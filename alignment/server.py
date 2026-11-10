"""Endpoint di Cadenza: riceve l'esecuzione e restituisce i verdetti.

Tre rotte, tutte POST tranne il GET di cortesia:

    /                modalita' normale: spartito + esecuzione intera -> sette
                     verdetti. E' il verdetto a fine brano.
    /practice        modalita' practice: spartito -> il PIANO di pratica, cioe'
                     la sequenza dei passi. Si chiama una volta all'apertura.
    /practice/step   modalita' practice: gli eventi suonati davanti a UN passo
                     -> i verdetti delle regole che si applicano a quelle note,
                     piu' la completezza del passo.

Il verdetto e' interamente in Prolog: questo file non contiene nessuna soglia,
nessuna classificazione, nessun giudizio. Fa solo il lavoro di trasporto.

La completezza del passo NON e' un verdetto ed e' l'unica cosa di questo file che
somiglia a una decisione: e' un confronto fra insiemi di pitch (le note che il
piano dichiara per quel passo contro quelle premute), non una soglia su una
grandezza. Serve a far avanzare il cursore senza aspettare il verdetto, che sul
piano gratuito arriva in secondi. Il perche' per esteso sta in practice.py.

Uso
    PORT=8080 python server.py
    curl -X POST localhost:8080/ -H 'Content-Type: application/json' -d @req.json

    req.json  {"score": "<musicxml ...>",
               "notes": [{"time_ms":0,"dur_ms":250,"pitch":60,"velocity":90}],
               "control_changes": [{"time_ms":0,"controller":64,"value":127}],
               "tempo_factor": 1.0}
"""
import hashlib
import json
import os
import subprocess
import sys
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

from join import ScoreModel, join, to_jsonl
from practice import (PRACTICE_RULES, SUSPENDED_RULES, PracticePlan, hand_summary,
                      step_status, trace_for_step)

# batch.pl sta accanto a server.py: stessa directory, quindi stesso ROOT.
ROOT = os.path.dirname(os.path.abspath(__file__))


def _default_spec_dir(container_path, dev_subdir):
    """Dove stanno i .pl compilati quando nessun ambiente lo dice esplicitamente.

    Il default vecchio scriveva "/opt/rml" e "/opt/specs" anche dove /opt non
    esiste — cioè su ogni macchina che non sia il container di Render. Senza
    RML_MONITOR/RML_SPECS esportate, swipl non trova nè la libreria monitor nè
    le specifiche: ogni regola risponde exit 2, con stderr persino vuoto, e
    l'allievo legge "cannot verify" in eterno mentre il servizio sembra
    perfettamente vivo. `_find_batch` qui sotto racconta esattamente questa
    storia; queste due righe erano l'altra meta' dello stesso guasto, rimaste
    mute.

    Il container vince comunque per primo: lo stage 1 di service/Dockerfile
    compila i .rml dentro /opt/, quindi se quel percorso esiste si usa lui e
    il comportamento di Render non cambia di un byte. Altrimenti si finisce
    nei RML_DOCS/RML_TESTS del repo, le stesse cartelle a cui le suite puntano
    i figli esplicitamente dal 2026-11-10 — perche' su una macchina di
    sviluppo gli unici .pl che esistono sono compilati lì.
    """
    if os.path.isdir(container_path):
        return container_path
    return os.path.join(ROOT, "..", "RML_DOCS", "RML_TESTS", dev_subdir)


MONITOR = os.environ.get("RML_MONITOR") or _default_spec_dir("/opt/rml", "monitor")
SPECS = os.environ.get("RML_SPECS") or _default_spec_dir("/opt/specs", "metrics")


def _find_batch():
    """Dove sta batch.pl.

    In produzione (Dockerfile) e' copiato accanto a server.py, in /opt: una
    directory sola e ROOT basta. In sviluppo i due file stanno in cartelle
    diverse — server.py in alignment/, batch.pl in service/ — e cercarlo solo
    accanto a server.py significa che swipl non parte affatto, non stampa
    nessuna riga per nessuna metrica, e il fallback qui sotto marca TUTTE le
    regole come violate. Cioe' l'allievo legge "hai suonato male" quando invece
    e' il servizio che non e' partito.

    Si cerca, invece di copiare il file: una copia in piu' e' una copia che si
    disallinea, e il .pl e' la fonte che deve restare una sola.
    """
    explicit = os.environ.get("CADENZA_BATCH")
    if explicit:
        return explicit
    candidates = [os.path.join(ROOT, "batch.pl"),
                  os.path.join(ROOT, "..", "service", "batch.pl")]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]


BATCH = _find_batch()

# Dove si scrivono lo spartito e la traccia, che partitura e swipl leggono da
# file: e' l'unico punto in cui il servizio tocca il disco.
#
# Una cartella sola riusata, non un TemporaryDirectory per richiesta. Su Windows
# cancellare una cartella temporanea con partitura che tiene ancora un handle
# aperto fallisce con PermissionError, e il fallimento arriva DOPO che la
# risposta e' stata calcolata, quindi sporca il log di un errore che non c'e'.
# Ogni file ha un nome suo, ed e' la sua cancellazione a essere esplicita.
SCRATCH = os.environ.get("CADENZA_TMPDIR") or os.path.join(ROOT, "scratch")

# Le sette metriche. Ogni nome e' anche il file <nome>.pl in SPECS.
METRICS = ("articulation", "chord-jitter", "dynamics-adherence", "pedal-toggle",
           "pitch-agreement", "pitch-range", "syncopated-pedal")

# Tetto di richiesta. Uno spartito reale e' 90 KB; 2 MB lascia spazio per
# spartiti corposi senza dare a un chiamante spazio per far saturare l'istanza
# da solo, che su Render Free e' 512 MB condivisi con tutto il resto.
MAX_BODY = 2 * 1024 * 1024


def scratch_path(suffix):
    """Un percorso di lavoro nuovo, nella cartella di scratch."""
    os.makedirs(SCRATCH, exist_ok=True)
    return os.path.join(SCRATCH, "%s%s" % (uuid.uuid4().hex, suffix))


def unlink(path):
    """Cancella un file di lavoro senza far fallire la richiesta se non riesce.

    Su Windows un file ancora aperto da un altro processo non si cancella: e'
    un residuo di qualche decina di KB, non un motivo per rispondere 400 a chi
    ha suonato bene.
    """
    try:
        os.unlink(path)
    except OSError:
        pass


# --------------------------------------------------------------- i piani

# Lo spartito si legge una volta per sessione di pratica, non a ogni passo.
#
# Perche' una cache e non una richiesta che rimanda lo spartito ogni volta: il
# piano si costruisce leggendo il MusicXML con partitura, che costa ~1,2 s di
# import piu' ~70 ms di lettura, mentre un verdetto su un passo ne costa 170 in
# locale. Senza cache, ogni pressione ripagherebbe la lettura dello spartito: e'
# il costo che rende la modalita' inutilizzabile, non la verifica.
#
# Il limite non e' una scelta di prudenza: su Render Free l'istanza ha 512 MB e
# ogni piano conserva il modello dello spartito in memoria. 8 sessioni
# concorrenti sono piu' di quante ne regge l'istanza, e le piu' vecchie
# scivolano fuori da sole (si rilegge lo spartito, non si sbaglia).
PLANS = {}
PLANS_LOCK = threading.Lock()
MAX_PLANS = 8


def _plan_key(score_xml, hand):
    """La cache e' per (spartito, mano): lo stesso brano ha piani diversi."""
    return hashlib.sha256(("%s|%s" % (hand or "both", score_xml))
                          .encode("utf-8")).hexdigest()


def _requested_hand(body):
    """La mano chiesta dalla richiesta: 'right', 'left', o None per tutte.

    Un valore sconosciuto e' un 400 chiaro, non "tutte le mani" per comodita'. Se
    il frontend scrivesse `destra` e il servizio intendesse "entrambe", l'allievo
    studierebbe tutto il brano credendo di studiare una mano sola: un errore che si
    vede solo dopo, quando il tempo e' gia' andato.
    """
    hand = body.get("hand")
    if hand is None:
        return None
    hand = str(hand).strip().lower()
    if hand in ("", "both", "all", "tutte"):
        return None
    if hand not in ("right", "left"):
        raise ValueError("unknown hand: %s (valid values: right, left)" % hand)
    return hand


def get_plan(score_xml, hand=None):
    """Il piano per questo spartito e questa mano, dalla cache o costruendolo."""
    key = _plan_key(score_xml, hand)
    with PLANS_LOCK:
        cached = PLANS.get(key)
        if cached is not None:
            # riporta in testa: l'ordine di inserimento diventa ordine d'uso
            PLANS.pop(key)
            PLANS[key] = cached
            return cached

    # La costruzione sta FUORI dal lock: leggere uno spartito richiede ~70 ms e
    # tenerlo bloccato mentre lo si fa serializzerebbe ogni sessione nuova su
    # ogni altra. Due richieste simultanee sullo stesso spartito lo leggono due
    # volte e scrivono lo stesso risultato: e' lavoro sprecato, non un errore.
    plan = _build_plan(score_xml, hand)

    with PLANS_LOCK:
        PLANS[key] = plan
        while len(PLANS) > MAX_PLANS:
            PLANS.pop(next(iter(PLANS)))
    return plan


def _build_plan(score_xml, hand=None):
    """Legge lo spartito e ne fa la sequenza di passi per la mano richiesta."""
    score = scratch_path(".musicxml")
    try:
        with open(score, "w", encoding="utf-8") as f:
            f.write(score_xml)
        model = ScoreModel.from_musicxml(score)
    finally:
        unlink(score)
    return PracticePlan(model, hand)


def _run_metrics(trace_path, metrics):
    """I verdetti del monitor su una traccia, per le regole indicate.

    Una specifica alla volta nella stessa VM Prolog: `match/2` viene importata in
    `user` e una seconda specifica nella stessa VM fallisce al caricamento.
    batch.pl se ne occupa e scrive "<nome> <exit>" per riga.
    exit 0 = traccia conforme, 1 = violata, 2 = errore.

    Su una riga violata seguono gli indici 0-based degli eventi su cui la macchina
    RML si e' fermata: "<nome> 1 7 19 40". Sono i punti del brano in cui l'allievo
    ha sbagliato, e servono alla pagina per colorare di rosso LA nota, non una a
    caso. Il codice d'uscita continua a venire dalla passata intera: gli indici
    sono un'aggiunta sopra lo stesso verdetto, mai una sua ricalcolazione, e
    infatti la modalita' pratica li ignora senza accorgersene.
    """
    specs = []
    for name in metrics:
        specs += [name, os.path.join(SPECS, "%s.pl" % name)]
    proc = subprocess.run(
        ["swipl", "-O", "-p", "monitor=%s" % MONITOR,
         BATCH, "--", trace_path] + specs,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    verdicts = {}
    for line in proc.stdout.decode().splitlines():
        parts = line.split()
        if len(parts) < 2 or parts[0] not in metrics:
            continue
        name, code = parts[0], parts[1]
        # gli indici viaggiano solo sulle righe violate; un token sporco non deve
        # far esplodere la riga, e' l'unica cosa che sappiamo del punto
        ids = [int(x) for x in parts[2:] if x.lstrip("-").isdigit()]
        verdicts[name] = (code == "0", int(code), "", tuple(ids))
    # Le regole di cui non si e' letta nemmeno una riga.
    #
    # exit 2 NON e' una violazione: e' il monitor che non e' partito (swipl
    # mancante, batch.pl non trovato, una specifica che non compila). Confonderlo
    # con exit 1 significa dire all'allievo che ha suonato male quando invece il
    # servizio e' rotto, che e' il modo peggiore di fallire: l'errore diventa un
    # giudizio sulla persona. Il frontend distingue i due casi proprio su questo
    # codice, vedi useVerdict.
    for name in metrics:
        if name not in verdicts:
            verdicts[name] = (False, 2, proc.stderr.decode()[-400:], ())
    return verdicts


# Cio' che le regole RML non possono vedere, e i due numeri che lo decidono.
# Scelti qui, visibili qui, ritoccabili qui — non dispersioni sparse:
#   TIMING_TOL_MS  quanto si puo' pressare una nota scritta fuori dal suo
#                  istante prima che la pagina la chiami "out of time". 200 ms
#                  e' il confine dove un pianista percepisce "la_sentivo dentro
#                  il brano" da "stavo cercando il tasto": misurato su prese
#                  vero del 2026-11-10, il ritardo netto dell'utente era mezzo
#                  secondo, e la precisione di chi conosce il brano sta sotto
#                  i 100. Scelta musicale, non un teorema: si tocca qui.
#   MATCH_CAP_MS   oltre questa distanza dallo stesso tasto scritto la pressione
#                  non e' piu' "in ritardo": e' un'altra nota, o un'allucinazione
#                  del rumore. Scala col tempo reale (x tempo_factor), perche' a
#                  meta' velocita' anche gli intervalli written si allungano.
TIMING_TOL_MS = 200
MATCH_CAP_MS = 900


def coverage(model, notes, factor):
    """Ricostruisce la verita' per attacco scritto: udito, in ritardo, mai premuto.

    Due cose le regole RML non possono dirle, e non per negligenza: una riga di
    traccia nasce solo da un tasto PREMUTO, quindi l'attacco che nessuno ha
    premuto non produce riga e batch.pl non ha nessun indice da puntare; e il
    ritardo grossissimo sparisce nello snap di join, che ancora la pressione
    all'attacco scritto piu' vicino senza chiedere se QUEL tasto c'entrasse —
    verita' misurata con esperimento nudo (Warmup C Major, 2026-11-10: 500 ms di
    ritardo su un attacco, deltaMis della riga risultato ~0 perche' la riga era
    finita sull'attacco dopo).

    Questa funzione ri-àncora sul tasto realmente premuto — il numero premuto
    contro i pitch attesi di cet'attacco scritto, la sola cerniera onesta tra i
    due mondi — e per ogni attacco risponde: ogni nota attesa li' fu davvero
    udita (stesso numero, entro MATCH_CAP_MS per lo stesso tasto, assegnazione
    golosa dal delta piu' piccolo prima che un vicino si mangi la pressione)?
    Se si': era dentro TIMING_TOL_MS o no? Restituisce tre liste di punti con
    LA STESSA grammatica delle locations (measure/beat/attack, qui attack =
    indice dell'attacco scritto), perche' la pagina li dipinge allo stesso modo.

    Non esclude niente: il chiamante tace "never played" dove una regola RML ha
    gia' puntato lo stesso punto (la coppia di numeri li' basta e avanza), mentre
    "out of time" arriva sempre perche' quella verita' nessun'altra regola la
    dice. Il campo kind/played sul ritardo e' la coppia onesta per la
    card d'hover: delta col segno in played (positivo = in ritardo), niente
    written perche' l'istante esatto l'allievo ce l'ha gia' sotto gli occhi
    nella carta del voto che scorre.
    """
    attacks = model.attacks()  # [(beat, [pitch attesi])] in ordine cronologico
    if not attacks or not notes:
        return [], [], []

    expect_at = [(model.ms_at(b) * float(factor), sorted(pitches))
                 for b, pitches in attacks]
    cap = MATCH_CAP_MS * float(factor)

    cands = []
    for i, p in enumerate(notes):
        t = float(p["time_ms"])
        for k, (ems, pitches) in enumerate(expect_at):
            if int(p["pitch"]) not in pitches:
                continue
            d = t - ems
            if abs(d) <= cap:
                cands.append((abs(d), i, k, d))
    cands.sort()

    covered = {}   # per attack: pitch atteso -> delta firmato del match migliore
    used_notes = set()
    for _, i, k, d in cands:
        if i in used_notes:
            continue  # questa pressione ha gia' trovato il suo attacco, il piu' vicino
        pnum = int(notes[i]["pitch"])
        if pnum in covered.get(k, {}):
            continue  # quella nota attesa e' gia' udita: la seconda vale come extra altrove
        used_notes.add(i)
        covered.setdefault(k, {})[pnum] = d

    late, missed, correct = [], [], []
    for k, (ems, pitches) in enumerate(expect_at):
        if not pitches:
            continue
        beat, measure = round(attacks[k][0], 4), model.measure_at(attacks[k][0])
        cov = covered.get(k, {})
        loc = {"measure": measure, "beat": beat, "attack": k}
        if any(p not in cov for p in pitches):
            missed.append(loc)
            continue  # attacco con buchi: il rosso "never played" copre anche li'
        worst_d, worst_a = 0.0, 0.0
        for d in cov.values():
            if abs(d) > worst_a:
                worst_a, worst_d = abs(d), d
        if worst_a > TIMING_TOL_MS:
            late.append({**loc, "kind": "timing", "played": int(round(worst_d))})
        else:
            correct.append(loc)
    return late, missed, correct


def _loc_key(l):
    """Chiave del punto identica a quella che usera' il frontend: attack se c'e'."""
    if isinstance(l.get("attack"), int):
        return "a%d" % l["attack"]
    return "%s:%s" % (l.get("measure"), l.get("beat"))


def _detail_for(rule, ev):
    """I numeri nudi di un punto violato: cosa e' stato suonato, cosa chiedeva lo spartito.

    L'hover sulla nota rossa deve poter dire subito la differenza, senza frasi:
    per le regole del pitch sono i due NUMERI di tasto (quello premuto e quello
    atteso), per la dinamica le due VELOCITA'. Tutto il resto — jitter, pedale,
    articolazione — non ha una coppia di numeri da mostrare, e l'hover si
    limita al nome della regola con la posizione: meglio una riga in meno di
    un valore inventato.

    I nomi dei tasti non si formattano qui: li sa fare la pagina (`noteName`,
    la stessa usata sui chip e sulla tastiera). Due formati diversi dello
    stesso numero, uno per parte, sono il seme delle divergenze future.
    """
    rule = (rule or "").lower()
    if rule.startswith("pitch"):
        played = (ev.get("note") or {}).get("number")
        written = (ev.get("expected") or {}).get("pitch")
    elif rule.startswith("dyn"):
        played = (ev.get("note") or {}).get("rawAttack")
        written = (ev.get("expected") or {}).get("dyn")
    else:
        return None
    if isinstance(played, int) and isinstance(written, int):
        kind = "pitch" if rule.startswith("pitch") else "velocity"
        return {"kind": kind, "played": played, "written": written}
    return None  # un numero mancante non e' un verdetto: la riga sta senza valori


def _locations(ids, events, rule=None):
    """Gli indici di batch.pl tradotti nei punti dello spartito.

    Un indice e' una riga della traccia, e ogni riga porta gia' dentro di se' il
    punto che riguarda: la battuta, la misura e il `chordId`, cioe' l'INDICE
    ASSOLUTO dell'attacco nello spartito completo. E' lo stesso numero che il
    piano di pratica chiama `attack` e che il cursore di OSMD sa raggiungere contando
    (128 fermate su 128, misurato in alignment/_probe_osmd.mjs): la pagina arriva
    alla nota giusta contando, come fa il cursore, perche' l'altezza del suono
    non e' un ponte affidabile fra i due mondi (octave-shift, sempre li').
    Qui si legge soltanto: niente calcoli, niente soglie.

    Il `rule` serve solo a scegliere se allegare i numeri nudi (`_detail_for`):
    la stessa riga della traccia sa gia' entrambi i valori, qui non si giudica
    e non si confronta niente.
    """
    locs, seen = [], set()
    for i in ids:
        if not 0 <= i < len(events):
            continue
        pos = events[i].get("position") or {}
        measure, beat = pos.get("measure"), pos.get("beat")
        if measure is None or beat is None:
            continue
        attack = (events[i].get("expected") or {}).get("chordId")
        key = (measure, beat)
        if key in seen:
            continue
        seen.add(key)
        loc = {"measure": measure, "beat": beat,
               "attack": attack if isinstance(attack, int) else None}
        detail = _detail_for(rule, events[i])
        if detail:
            loc.update(detail)
        locs.append(loc)
    return locs



def read_tempo_factor(body):
    """Quanti millisecondi reali vale un millisecondo scritto nello spartito.

    Lo manda la pagina, che e' il posto dove l'utente sceglie il tempo con lo
    slider: 1 se suona al tempo scritto, 2 se suona a meta' velocita'. Se il
    campo manca o ha un valore che non ha senso, si torna al tempo scritto
    invece di rifiutare la richiesta: e' un valore che cambia solo la scala dei
    tempi, e perdere una prova intera per quello sarebbe peggio.
    """
    try:
        f = float(body.get("tempo_factor", 1.0))
    except (TypeError, ValueError):
        return 1.0
    if not np.isfinite(f) or f <= 0:
        return 1.0
    return f


def validate(body):
    """Controllo di ingresso. Questa e' una frontiera fidata: il corpo arriva
    da un browser, non da noi."""
    if not isinstance(body.get("score"), str) or "<" not in body.get("score", ""):
        raise ValueError("missing MusicXML score")
    notes = body.get("notes")
    if not isinstance(notes, list) or not notes:
        raise ValueError("no notes were played")
    out = []
    for n in notes:
        if not isinstance(n, dict):
            raise ValueError("malformed note")
        try:
            out.append({"time_ms": float(n["time_ms"]), "dur_ms": float(n["dur_ms"]),
                        "pitch": int(n["pitch"]), "velocity": int(n["velocity"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("malformed note: time_ms, dur_ms, pitch and velocity are required")
    cc = []
    for c in body.get("control_changes") or []:
        try:
            cc.append({"time_ms": float(c["time_ms"]),
                       "controller": int(c["controller"]), "value": int(c["value"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("malformed control change")
    return out, cc


def analyse(body):
    notes, cc = validate(body)

    score = scratch_path(".musicxml")
    trace = scratch_path(".jsonl")
    try:
        with open(score, "w", encoding="utf-8") as f:
            f.write(body["score"])
        model = ScoreModel.from_musicxml(score)
        factor = read_tempo_factor(body)
        events = join(model, notes, factor, cc)
        with open(trace, "w", encoding="utf-8") as f:
            f.write(to_jsonl(events) + "\n")
        verdicts = _run_metrics(trace, METRICS)
    finally:
        unlink(score)
        unlink(trace)
    # Il model, le note e il fattore viaggiano fuori insieme al verdetto: la
    # copertura legge la verita' scritta, che vive solo nel model (`coverage`).
    return verdicts, events, model, notes, factor


def practise_step(body):
    """Un passo di pratica: la traccia di quel passo, e cosa ne dicono le regole.

    Il PIANO non si ricostruisce da zero se e' in cache, e il cursore non
    aspetta questo verdetto per avanzare (vedi practice.py): qui si risponde a
    "come l'hai suonato", non a "puoi andare avanti".
    """
    if not isinstance(body.get("score"), str) or "<" not in body["score"]:
        raise ValueError("missing MusicXML score")

    events = body.get("events")
    if not isinstance(events, list):
        raise ValueError("missing the list of events")

    hand = _requested_hand(body)
    plan = get_plan(body["score"], hand)
    index = int(body.get("step", 0))
    if not 0 <= index < len(plan):
        # Il numero di passi dipende dalla mano richiesta, e il messaggio lo dice:
        # "fuori dal brano" avrebbe fatto cercare il problema nello spartito invece
        # che nel filtro mano appena acceso.
        raise ValueError("step %d is outside this exercise (%d-%d%s)"
                         % (index, 0, len(plan) - 1,
                            ", hand " + hand if hand else ""))

    # Gli eventi arrivano grezzi dal canale MIDI e vanno normalizzati come nella
    # modalita' normale: un campo malformato deve dare un 400 chiaro, non una
    # traccia costruita a meta'.
    clean = []
    for e in events:
        if not isinstance(e, dict):
            raise ValueError("malformed event")
        try:
            clean.append({"type": str(e["type"]), "pitch": int(e["pitch"]),
                          "velocity": int(e.get("velocity") or 0),
                          "time_ms": float(e["time_ms"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("malformed event: type, pitch and time_ms are required")
    clean.sort(key=lambda e: e["time_ms"])

    cc = []
    for c in body.get("control_changes") or []:
        try:
            cc.append({"time_ms": float(c["time_ms"]),
                       "controller": int(c["controller"]), "value": int(c["value"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("malformed control change")

    trace = trace_for_step(plan, index, clean, cc)
    status = step_status(plan, index, clean)

    verdicts = {}
    if trace:
        # Nessuna nota premuta: non c'e' niente da giudicare e non si avvia
        # Prolog. Il caso non e' un errore, e' l'allievo che non ha ancora
        # toccato la tastiera: rispondere "tutto conforme" su una traccia vuota
        # sarebbe la bugia peggiore, e le regole non hanno niente da dire.
        path = scratch_path(".jsonl")
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(to_jsonl(trace) + "\n")
            verdicts = _run_metrics(path, PRACTICE_RULES)
        finally:
            unlink(path)

    return {
        "step": index,
        "total": len(plan),
        # quale sottoinsieme si sta studiando: serve al frontend per non mostrare
        # un verdetto della mano destra come se fosse del brano intero
        "hand": hand,
        "status": status,
        "verdicts": {k: {"ok": v[0], "exit": v[1]} for k, v in verdicts.items()},
        "suspended": SUSPENDED_RULES,
        "stderr": {k: v[2] for k, v in verdicts.items() if v[2].strip()},
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        # Il frontend sta su Vercel, il servizio su Render: domini diversi.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        # Il GET di cortesia dice anche quali regole girano in pratica: e' la
        # stessa informazione che il piano manda al frontend, e serve a
        # verificare da fuori che il servizio deployato sia quello giusto.
        self._send(200, {
            "service": "cadenza",
            "metrics": list(METRICS),
            "practice": {
                "rules": list(PRACTICE_RULES),
                "suspended": SUSPENDED_RULES,
                # Le mani che il filtro sa isolare. Viaggia qui perche' e' la prima
                # cosa da guardare quando il toggle dell'app resta spento sul sito
                # deployato: se questo elenco c'e', il servizio e' quello giusto.
                "hands": ["right", "left"],
            },
        })

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self._send(413, {"error": "request body too large"})
            body = json.loads(self.rfile.read(n))

            path = self.path.split("?")[0].rstrip("/") or "/"
            if path == "/practice":
                if not isinstance(body.get("score"), str) or "<" not in body["score"]:
                    raise ValueError("missing MusicXML score")
                hand = _requested_hand(body)
                plan = get_plan(body["score"], hand)
                return self._send(200, {
                    "total": len(plan),
                    "hand": hand,
                    # Che cosa separa davvero questo spartito: se `split` e' falso
                    # il frontend tiene il filtro mano spento e dichiarato, perche'
                    # un toggle che chiede "destra" a un pezzo senza righi sceglie
                    # meta' brano a caso.
                    "hands": hand_summary(plan.model),
                    "steps": plan.all_events(),
                    "rules": list(PRACTICE_RULES),
                    "suspended": SUSPENDED_RULES,
                })
            if path == "/practice/step":
                return self._send(200, practise_step(body))

            verdicts, events, model, notes, factor = analyse(body)
            # Su una regola violata viaggiano anche i punti dello spartito: la
            # pagina ci colora di rosso le note e il mouse sopra racconta quali
            # regole sono cascate li'. exit 2 NON produce posizioni: il servizio
            # non ha giudicato niente, e una nota rossa sarebbe un'accusa inventata.
            payload = {}
            for k, v in verdicts.items():
                entry = {"ok": v[0], "exit": v[1]}
                if v[1] == 1:
                    entry["locations"] = _locations(v[3], events, k)
                payload[k] = entry

            # Poi vengono le due cose che RML non puo' vedere, e il verde della
            # presa. I punti rossi gia' rivendicati dalle regole non si accusano
            # due volte: una nota stonata e' gia' rossa, e aggiungervi "non e'
            # mai stata suonata" sarebbe una seconda voce che dice la stessa
            # cosa in un altro modo — la coppia di numeri li' ha gia' detto tutto.
            late, missed, correct = coverage(model, notes, factor)
            red = set()
            for v in payload.values():
                for l in v.get("locations", []):
                    red.add(_loc_key(l))
            # "never played" tace dove un rosso c'e' gia': li' la coppia di
            # numeri RML ha gia' detto tutto, e una seconda voce che dice
            # "mancava anche questa" sarebbe rumore sopra la stessa nota.
            # "out of time" NON si esclude mai: il punto e' rosso comunque, e
            # la sua riga porta una verita' che nessun'altra riga dice — il
            # tasto era quello giusto, arrivato male nel tempo. Il voto non
            # raddoppia: planMarks fonde i punti con la stessa chiave, e due
            # righe su un errore sono informazioni, non due errori.
            missed = [l for l in missed if _loc_key(l) not in red]
            if late:
                payload["out of time"] = {"ok": False, "exit": 1, "locations": late}
                red.update(_loc_key(l) for l in late)
            if missed:
                payload["never played"] = {"ok": False, "exit": 1, "locations": missed}
                red.update(_loc_key(l) for l in missed)
            correct = [l for l in correct if _loc_key(l) not in red]

            self._send(200, {
                "events": len(events),
                "verdicts": payload,
                # Il verde della presa: attacchi scritti che hanno suonato il
                # loro pitch giusto, e dentro il tempo. E' un fatto di copertura
                # (python riàncora sul tasto premuto), non un verdetto RML: c'e'
                # anche quando ogni monitor e' rimasto muto, e "giusto" qui vale
                # intonazione + tempo — se dinamica o pedale hanno detto altro su
                # quel punto, il punto era gia' rosso e non puo' essere verde.
                "correct": correct,
                "stderr": {k: v[2] for k, v in verdicts.items() if v[2].strip()},
            })
        except Exception as e:
            traceback.print_exc()
            self._send(400, {"error": "%s: %s" % (type(e).__name__, e)})

    def log_message(self, fmt, *a):
        sys.stderr.write("[cadenza] " + fmt % a + "\n")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    # Dirlo UNA VOLTA all'avvio batte lasciar indovinare all'allievo in eterno:
    # senza queste due cartelle ogni verdetto dice "cannot verify" in silenzio,
    # e nessun documento aveva mai scritto che un avvio locale ne dipendeva
    # fino al pomeriggio del 2026-11-10. Il testo e' inglese perche' lo legge
    # chi avvia il servizio, non l'allievo.
    for etichetta, percorso in (("monitor library", MONITOR), ("compiled specs", SPECS)):
        if not os.path.isdir(percorso):
            print(f'[cadenza] WARNING: {etichetta} directory not found: {percorso}\n'
                  f'[cadenza]          every rule will answer exit 2 ("cannot verify"). '
                  "Point RML_MONITOR/RML_SPECS at the compiled .pl directories.", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()