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

MONITOR = os.environ.get("RML_MONITOR", "/opt/rml")
SPECS = os.environ.get("RML_SPECS", "/opt/specs")
# batch.pl sta accanto a server.py: stessa directory, quindi stesso ROOT.
ROOT = os.path.dirname(os.path.abspath(__file__))


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
        raise ValueError("mano sconosciuta: %s (valide: right, left)" % hand)
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
        if len(parts) != 2 or parts[0] not in metrics:
            continue
        name, code = parts
        verdicts[name] = (code == "0", int(code), "")
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
            verdicts[name] = (False, 2, proc.stderr.decode()[-400:])
    return verdicts



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
        raise ValueError("manca lo spartito MusicXML")
    notes = body.get("notes")
    if not isinstance(notes, list) or not notes:
        raise ValueError("nessuna nota suonata")
    out = []
    for n in notes:
        if not isinstance(n, dict):
            raise ValueError("nota malformata")
        try:
            out.append({"time_ms": float(n["time_ms"]), "dur_ms": float(n["dur_ms"]),
                        "pitch": int(n["pitch"]), "velocity": int(n["velocity"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("nota malformata: servono time_ms, dur_ms, pitch, velocity")
    cc = []
    for c in body.get("control_changes") or []:
        try:
            cc.append({"time_ms": float(c["time_ms"]),
                       "controller": int(c["controller"]), "value": int(c["value"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("control change malformato")
    return out, cc


def analyse(body):
    notes, cc = validate(body)

    score = scratch_path(".musicxml")
    trace = scratch_path(".jsonl")
    try:
        with open(score, "w", encoding="utf-8") as f:
            f.write(body["score"])
        model = ScoreModel.from_musicxml(score)
        events = join(model, notes, read_tempo_factor(body), cc)
        with open(trace, "w", encoding="utf-8") as f:
            f.write(to_jsonl(events) + "\n")
        verdicts = _run_metrics(trace, METRICS)
    finally:
        unlink(score)
        unlink(trace)
    return verdicts, events


def practise_step(body):
    """Un passo di pratica: la traccia di quel passo, e cosa ne dicono le regole.

    Il PIANO non si ricostruisce da zero se e' in cache, e il cursore non
    aspetta questo verdetto per avanzare (vedi practice.py): qui si risponde a
    "come l'hai suonato", non a "puoi andare avanti".
    """
    if not isinstance(body.get("score"), str) or "<" not in body["score"]:
        raise ValueError("manca lo spartito MusicXML")

    events = body.get("events")
    if not isinstance(events, list):
        raise ValueError("manca l'elenco degli eventi")

    hand = _requested_hand(body)
    plan = get_plan(body["score"], hand)
    index = int(body.get("step", 0))
    if not 0 <= index < len(plan):
        # Il numero di passi dipende dalla mano richiesta, e il messaggio lo dice:
        # "fuori dal brano" avrebbe fatto cercare il problema nello spartito invece
        # che nel filtro mano appena acceso.
        raise ValueError("passo %d fuori dall'esercizio (%d-%d%s)"
                         % (index, 0, len(plan) - 1,
                            ", mano " + hand if hand else ""))

    # Gli eventi arrivano grezzi dal canale MIDI e vanno normalizzati come nella
    # modalita' normale: un campo malformato deve dare un 400 chiaro, non una
    # traccia costruita a meta'.
    clean = []
    for e in events:
        if not isinstance(e, dict):
            raise ValueError("evento malformato")
        try:
            clean.append({"type": str(e["type"]), "pitch": int(e["pitch"]),
                          "velocity": int(e.get("velocity") or 0),
                          "time_ms": float(e["time_ms"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("evento malformato: servono type, pitch, time_ms")
    clean.sort(key=lambda e: e["time_ms"])

    cc = []
    for c in body.get("control_changes") or []:
        try:
            cc.append({"time_ms": float(c["time_ms"]),
                       "controller": int(c["controller"]), "value": int(c["value"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("control change malformato")

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
                return self._send(413, {"error": "corpo fuori dai limiti"})
            body = json.loads(self.rfile.read(n))

            path = self.path.split("?")[0].rstrip("/") or "/"
            if path == "/practice":
                if not isinstance(body.get("score"), str) or "<" not in body["score"]:
                    raise ValueError("manca lo spartito MusicXML")
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

            verdicts, events = analyse(body)
            self._send(200, {
                "events": len(events),
                "verdicts": {k: {"ok": v[0], "exit": v[1]} for k, v in verdicts.items()},
                "stderr": {k: v[2] for k, v in verdicts.items() if v[2].strip()},
            })
        except Exception as e:
            traceback.print_exc()
            self._send(400, {"error": "%s: %s" % (type(e).__name__, e)})

    def log_message(self, fmt, *a):
        sys.stderr.write("[cadenza] " + fmt % a + "\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", 8080))), Handler).serve_forever()