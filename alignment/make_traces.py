"""Rigenera le tracce di riferimento delle sette regole.

Le tracce in RML_DOCS/RML_TESTS/metrics/traces/ sono ciò su cui le regole
vengono collaudate: se sono piu' vecchie del codice che le giudica, il
risultato non dice niente sul codice di oggi.

Il file produce 14 file: 7 conformi (identici fra loro) e 7 sabotati, uno per
regola. La sabotaggine non tocca mai la traccia gia' scritta: si applica
all'ESECUZIONE e poi si ricalcola tutto da capo con join(), come accade in
davvero quando un musicista sbaglia.

L'esecuzione di partenza non e' inventata qui: si ricava da una traccia già
verificata, e i suoi tempi sono i millisecondi veri di quella esecuzione.
"""
import copy
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from join import ScoreModel, join, to_jsonl

SCORE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "The Legend of Zelda_ Great Fairy Fountain (Piano Cover) - con dinamiche.musicxml")

# Lo spartito con i cartigli. Serve ad articulation: lo spartito di sopra non ne
# ha nessuno, quindi la regola su quello non ha niente da guardare e non lo puo'
# collaudare. Non e' che sia una regola che non funziona: e' una regola che su
# quello spartito tace, perche' lo spartito non chiede niente.
MERRY = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "Merry-Go-Round of Life_ Howl's Moving Castle Piano Tutorial (3).musicxml")

SEED = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "RML_DOCS", "RML_TESTS", "metrics", "traces", "articulation.ok.jsonl")
OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "RML_DOCS", "RML_TESTS", "metrics", "traces")

# La traccia di partenza dura 19201 ms, lo spartito al tempo scritto 24774 ms.
# Il fattore e' il rapporto: 0,775 vuol dire che quel brano e' stato suonato al
# 129% della velocita' scritta, che e' un tempo perfettamente legittimo.
TEMPO_FACTOR = 0.775

RULES = ["articulation", "chord-jitter", "dynamics-adherence", "pedal-toggle",
         "pitch-agreement", "pitch-range", "syncopated-pedal"]


# ── l'esecuzione di partenza ────────────────────────────────────────────────

def read_trace(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def to_performance(events):
    """Ritorna l'esecuzione come lista di note + control change.

    È l'inverso di quello che fa useMidi.ts: dalle coppie attacco/sollevamento
    del file MIDI ricava le note suonate.
    """
    open_a, notes, cc = {}, [], []
    for e in events:
        t = e["timestamp"]
        if e["type"] == "noteon":
            open_a.setdefault(e["note"]["number"], []).append((t, e["note"]["rawAttack"]))
        elif e["type"] == "noteoff":
            q = open_a.get(e["note"]["number"]) or []
            if q:
                t0, vel = q.pop(0)
                notes.append({"time_ms": t0, "dur_ms": t - t0,
                              "pitch": e["note"]["number"], "velocity": vel})
        elif e["type"] == "controlchange":
            cc.append({"time_ms": t, "controller": e["controller"], "value": e["value"]})
    return notes, cc


# ── i sette sabotaggi ───────────────────────────────────────────────────────
#
# Ognuno tocca l'esecuzione e nient'altro. Se una regola segnala un difetto che
# il suo sabotaggio non contiene, vuol dire che la regola vede qualcos'altro e
# la matrice 7x7 va letta conattenzione.

def sabotage_articulation(model, notes, cc):
    """Non piu' un sabotaggio: lo spartito di riferimento non ha cartigli.

    La regola confronta la durata suonata con l'istante in cui arriva la nota
    dopo, e lo fa SOLO sulle note su cui lo spartito scrive un cartiglio. Su
    questo spartito non ce n'e' nessuno, quindi non c'e' niente da sabotare: la
    traccia di errore qui e' identica a quella buona, ed e' corretto che lo sia.

    Il sabotaggio vero di questa regola e' nella coppia `articulation-marked`,
    costruita sullo spartito che ha i cartigli. Vedi `marking_execution`.
    """
    return notes, cc


def marking_execution(model, da, a, sabotato):
    """Una esecuzione su una fetta di spartito che ha i cartigli.

    da/a sono battute. Dentro la fetta ogni nota suonata come lo spartito
    chiede: la staccata viene lasciata prima della nota dopo, la tenuta viene
    tenuta fino a li'. Con sabotato=True le staccate vengono invece tenute fino
    all'ultimo istante, che e' esattamente l'errore che la regola deve vedere.

    Non e' una prova che si puo' fare a caso: se la esecuzione non contiene
    nessuna nota con il cartiglio, la regola ha giustamente niente da dire e la
    traccia di errore risulterebbe conforme.
    """
    prossimi = sorted({n["onset"] for n in model.notes if da <= n["onset"] < a})
    if len(prossimi) < 2:
        raise RuntimeError("fetta troppo piccola per avere un attacco successivo")
    prossimo_di = dict(zip(prossimi[:-1], prossimi[1:]))

    note = []
    for n in model.notes:
        if not (da <= n["onset"] < a):
            continue
        successivo = prossimo_di.get(n["onset"])
        gap = None if successivo is None else \
            model.ms_at(successivo) - model.ms_at(n["onset"])
        # l'ultimo attacco non ha nota dopo: non c'e' niente da confrontare
        if gap is None or gap <= 0:
            durata = 150.0
        elif n["articulation"] == "staccato":
            durata = (0.99 if sabotato else 0.5) * gap
        elif n["articulation"] in ("tenuto", "legato"):
            durata = 0.95 * gap
        else:
            durata = 0.5 * gap
        # La velocity segue la dinamica che lo spartito scrive in quella
        # battuta: e' il numero che la regola dynamics-adherence usa come centro
        # della fascia. Era una costante (64) prima della tabella a centro metà,
        # e con quella tabella 64 non era il centro di nessuna fascia.
        dyn = model.expected_at(n["onset"])["dyn"]
        note.append({"time_ms": model.ms_at(n["onset"]), "dur_ms": durata,
                     "pitch": n["pitch"], "velocity": dyn if dyn is not None else 64})
    return note


def _finestra_con_cartigli(model):
    """La piu' corta fetta di battute che contiene stacchi e tenuti insieme.

    Cercata e non scritta a mano perche' i numeri cambiano se lo spartito di prova
    cambia: una finestra scelta sul posto smetterebbe di contenere i cartigli
    senza che nessuno se ne accorga.
    """
    marcate = sorted({n["onset"] for n in model.notes if n["articulation"]})
    if not marcate:
        raise RuntimeError("lo spartito non ha cartigli: la regola non avrebbe "
                           "niente da collaudare")
    meglio = None
    for inizio in marcate:
        dentro = [b for b in marcate if inizio <= b < inizio + 12.0]
        if not dentro:
            continue
        staccati = {b for b in dentro
                    if model.articulation_at(b) == "staccato"}
        tenuti = {b for b in dentro
                  if model.articulation_at(b) in ("tenuto", "legato")}
        punteggio = (min(len(staccati), 4) + min(len(tenuti), 4), -(inizio + 12.0))
        if meglio is None or punteggio > meglio[0]:
            meglio = (punteggio, inizio)
    if meglio is None:
        raise RuntimeError("nessuna finestra con cartigli")
    return meglio[1], meglio[1] + 12.0


def sabotage_chord_jitter(model, notes, cc):
    """Una nota di ogni accordo arriva in ritardo: 120 ms, contro i 30 tollerati."""
    per_onset = {}
    for n in notes:
        per_onset.setdefault(n["time_ms"], []).append(n)
    moved = 0
    for t in sorted(per_onset):
        grp = sorted(per_onset[t], key=lambda x: x["pitch"])
        if len(grp) == 2 and moved < 8:
            grp[0]["time_ms"] += 120.0
            moved += 1
    return notes, cc


def sabotage_dynamics(model, notes, cc):
    """12 note suonate sotto il 70% della dinamica che lo spartito chiede.

    Le note si scelgono guardando `expected.dyn`, non a caso: la regola lascia
    stare le note senza dinamica esplicita, e suonare piano una nota che lo
    spartito vuole gia' piano non e' un difetto.
    """
    loudest = max(d["velocity"] for d in model.dynamics)
    by_onset = {}
    for n in notes:
        by_onset.setdefault(round(n["time_ms"], 3), []).append(n)

    touched = 0
    for score_note in model.notes:
        if touched >= 12:
            break
        # `expected_at` non ha dynExplicit: la dinamica e' esplicita quando lo
        # spartito ne dichiara una per questa battuta, e allora arriva un numero.
        dyn = model.expected_at(score_note["onset"])["dyn"]
        if dyn is None or dyn != loudest:
            continue
        when = round(model.ms_at(score_note["onset"]) * TEMPO_FACTOR, 3)
        for played in by_onset.get(when, []):
            # un gradino sotto la fascia, non molto piu' in basso: cosi' il
            # sabotaggio prova il confine e non un errore grossolano. Con la
            # fascia a centro met', il pavimento e' floor(loudest - 8).
            played["velocity"] = math.floor(loudest - 8) - 1
            touched += 1
            break
    if touched < 12:
        raise RuntimeError(
            "sabotaggio dinamico: colpite %d note su 12, i tempi non tornano" % touched)
    return notes, cc


def sabotage_pedal_toggle(notes, cc):
    """Il pedale viene premuto e mai rilasciato."""
    return notes, [c for c in cc if not (c["controller"] == 64 and c["value"] == 0)]


def sabotage_pedal_toggle(model, notes, cc):
    """Il pedale viene premuto e mai rilasciato."""
    return notes, [c for c in cc if not (c["controller"] == 64 and c["value"] == 0)]


def sabotage_pitch_agreement(model, notes, cc):
    """Quattro note suonate due semitoni sopra: il JOIN le vede fuori spartito."""
    for n in notes[70:74]:
        n["pitch"] += 2
    return notes, cc


def sabotage_pitch_range(model, notes, cc):
    """Due note fuori dall'estensione 21..108 che pitch-range.pl considera."""
    for n in notes[40:42]:
        n["pitch"] = 110
    return notes, cc


def sabotage_syncopated_pedal(model, notes, cc):
    """Il pedale viene rilasciato senza essere stato premuto."""
    return notes, [c for c in cc if not (c["controller"] == 64 and c["value"] == 127)]


SABOTAGE = {
    "articulation": sabotage_articulation,
    "chord-jitter": sabotage_chord_jitter,
    "dynamics-adherence": sabotage_dynamics,
    "pedal-toggle": sabotage_pedal_toggle,
    "pitch-agreement": sabotage_pitch_agreement,
    "pitch-range": sabotage_pitch_range,
    "syncopated-pedal": sabotage_syncopated_pedal,
}


def write(name, case, events):
    path = os.path.join(OUT, "%s.%s.jsonl" % (name, case))
    with open(path, "w", encoding="utf-8") as f:
        f.write(to_jsonl(events) + "\n")
    return path


def _velocity_dalla_dinamica(model, notes):
    """Riscrive la velocity di ogni nota suonata con la dinamica dello spartito.

    Prima la esecuzione di partenza prendeva le velocity dalla traccia su disco,
    cioe' da una propria uscita precedente: cambiando la tabella delle dinamiche
    le tracce non la seguivano e restavano con i numeri vecchi. Qui la velocity
    dipende solo dallo spartito, quindi la tabella vale perche' vale.

    Le note senza dinamica scritta in quella battuta restano a 64: non sono
    giudicate dalla regola e il numero non conta.
    """
    cambiati = 0
    for n in notes:
        # stessa battuta che calcola join.py:580-584, arrotondata sugli attacchi
        # dello spartito. Senza snap_beat due note al confine fra due dinamiche
        # prendono la dinamica sbagliata e la regola le boccia per niente.
        beat = model.snap_beat(model.beat_at(n["time_ms"] / TEMPO_FACTOR))
        dyn = model.expected_at(beat)["dyn"]
        if dyn is None:
            continue
        if n["velocity"] != dyn:
            cambiati += 1
        n["velocity"] = dyn
    return notes, cambiati


def _pedali_dalla_partitura(model):
    """Costruisce i control change del pedale dallo spartito: uno per span.

    Prima le pressioni venivano dalla traccia su disco: due soli eventi, uno
    a inizio brano e uno a fine. Andava bene finche' gli span erano uniti in
    uno unico; ora che ogni comparsa del pedale e' uno span a se', l'esecuzione
    corretta e' una pressione dove lo span apre e un rilascio dove chiude, per
    ognuno. Come per le velocity in _velocity_dalla_dinamica: la traccia di
    riferimento deve seguire lo spartito, non una sua copia precedente.

    Sia la pressione che il rilascio sono anticipati di 1 ms, tranne la
    pressione nello span: il pedale sincopato si preme subito DOPO il primo
    noteon coperto, quindi la pressione cade a +1 ms dall'inizio dello span.
    Il rilascio resta anticipato di 1 ms (tranne l'ultimo span): a parita'
    di istante i noteon vengono prima dei control change e gli span sono
    contigui, e bisogna che il rilascio dello span non finisca davanti al
    noteoff delle sue note. Lo snap_beat del JOIN riporta comunque entrambi
    sul bordo giusto: 1 ms e' molto sotto la sua tolleranza.
    """
    cc = []
    for i, p in enumerate(model.pedals):
        cc.append({"time_ms": model.ms_at(p["start"]) * TEMPO_FACTOR + 1,
                   "controller": 64, "value": 127})
        # ultimo span: il rilascio sta ESATTO alla fine, non a -1 ms. Se stesse
        # a -1 ms precederebbe il noteoff dell'ultima nota, che ha ancora il
        # pedale atteso, e syncopated-pedal si bloccherebbe su un notePedal
        # senza pressione. A parita' di istante i noteoff vengono prima dei
        # control change, quindi la nota chiude dentro la sua regione e il
        # rilascio arriva dopo. Non serve l'anticipo: non c'e' uno span dopo.
        fine = model.ms_at(p["end"]) * TEMPO_FACTOR
        if i < len(model.pedals) - 1:
            fine -= 1
        cc.append({"time_ms": fine, "controller": 64, "value": 0})
    return cc


def main():
    model = ScoreModel.from_musicxml(SCORE)
    notes, _cc_scartati = to_performance(read_trace(SEED))
    cc = _pedali_dalla_partitura(model)
    notes, cambiati = _velocity_dalla_dinamica(model, notes)
    print("spartito: %d note, %d dinamiche, %d pedali"
          % (len(model.notes), len(model.dynamics), len(model.pedals)))
    print("esecuzione di partenza: %d note, %d control change"
          % (len(notes), len(cc)))
    print("velocity ricalcolate dallo spartito: %d\n" % cambiati)

    ok = join(model, notes, TEMPO_FACTOR, cc)
    for r in RULES:
        p = write(r, "ok", ok)
        print("  %-20s ok   %4d eventi  %s" % (r, len(ok), os.path.basename(p)))

    print()
    for r in RULES:
        n, c = copy.deepcopy(notes), copy.deepcopy(cc)
        n, c = SABOTAGE[r](model, n, c)
        ev = join(model, n, TEMPO_FACTOR, c)
        p = write(r, "fail", ev)
        print("  %-20s fail %4d eventi  %s" % (r, len(ev), os.path.basename(p)))

    print("\nscritte in %s" % OUT)


def main_marking():
    """Le due tracce con cui si collauda davvero articulation."""
    model = ScoreModel.from_musicxml(MERRY)
    da, a = _finestra_con_cartigli(model)
    dentro = [n for n in model.notes if da <= n["onset"] < a]
    segnate = [n for n in dentro if n["articulation"]]
    print("\nspartito coi cartigli: %d note, di cui %d con cartiglio"
          % (len(model.notes), sum(1 for n in model.notes if n["articulation"])))
    print("fetta scelta: battute %.1f..%.1f, %d note, %d con cartiglio"
          % (da, a, len(dentro), len(segnate)))
    for caso, sabotato in (("ok", False), ("fail", True)):
        note = marking_execution(model, da, a, sabotato)
        ev = join(model, note, 1.0, [])
        p = write("articulation-marked", caso, ev)
        print("  articulation-marked  %-4s %4d eventi  %s"
              % (caso, len(ev), os.path.basename(p)))


if __name__ == "__main__":
    main()
    main_marking()