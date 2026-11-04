"""Verifica practice.py: cosa dice davvero il monitor RML, passo per passo.

Non simula il frontend: costruisce gli eventi esattamente come li manderebbe la
pagina (noteon/noteoff con pitch, velocity, time_ms), ne ricava la traccia con
`trace_for_step` e chiede il verdetto al monitor VERO, con le specifiche VERE.

I sei casi coprono le situazioni in cui la modalita' deve comportarsi
diversamente, e in particolare la sesta: note giuste PIU' una in piu', dove il
cursore deve avanzare mentre la regola segnala. E' il caso che dimostra perche'
l'avanzamento non puo' essere il verdetto di pitch-agreement.
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(ROOT)
sys.path.insert(0, ROOT)

from join import ScoreModel                                   # noqa: E402
from practice import (PracticePlan, PRACTICE_RULES,           # noqa: E402
                      SUSPENDED_RULES, hand_summary, step_status, trace_for_step)

MONITOR = os.path.join(REPO, "RML_DOCS", "RML_TESTS", "monitor")
METRICS = os.path.join(REPO, "RML_DOCS", "RML_TESTS", "metrics")
BATCH = os.path.join(REPO, "service", "batch.pl")
TMP = os.path.join(ROOT, "_probe_traces")
os.makedirs(TMP, exist_ok=True)
SCORE = os.path.join(REPO,
                     "The Legend of Zelda_ Great Fairy Fountain (Piano Cover).musicxml")

esiti = []


def judge(events):
    """Il verdetto del monitor sulle regole di pratica."""
    trace = os.path.join(TMP, "practice.jsonl")
    with open(trace, "w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    args = ["swipl", "-O", "-p", "monitor=%s" % MONITOR, BATCH, "--", trace]
    for r in PRACTICE_RULES:
        args += [r, os.path.join(METRICS, r + ".pl").replace("\\", "/")]
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out = {}
    for line in proc.stdout.decode().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] in PRACTICE_RULES:
            out[parts[0]] = "ok" if parts[1] == "0" else "VIOLATA"
    return out, proc.stderr.decode().strip()


def press(pitch, t, dur=200):
    return [{"type": "noteon", "pitch": pitch, "velocity": 80, "time_ms": t},
            {"type": "noteoff", "pitch": pitch, "velocity": 0,
             "time_ms": t + dur}]


def caso(label, index, events, atteso_avanza, atteso_verdetto=None, piano=None,
         atteso_status=None):
    """Esegue un caso, confronta con l'atteso e registra l'esito.

    `piano` e' il piano su cui giocare: quello senza mani per i casi 1-7, quello di
    una mano sola per gli altri. Default: il piano completo, cosi' i casi gia'
    scritti non cambiano.

    `atteso_status` confronta dei campi dello stato (per esempio `extra` vuoto e
    `other_hand` pieno): il verdetto dice come hai suonato, lo stato dice cosa hai
    premuto, e sui casi mano sono due cose diverse da verificare separate.
    """
    piano = piano if piano is not None else plan
    status = step_status(piano, index, events)
    trace = trace_for_step(piano, index, events)
    verdetti, err = judge(trace)

    print("\n%s" % label)
    print("   attese %s | premute %s | mancanti %s | estranee %s | altra mano %s"
          % (status["expected"], status["pressed"],
             status["missing"], status["extra"], status["other_hand"]))
    for r in PRACTICE_RULES:
        print("   %-22s %s" % (r, verdetti.get(r, "?")))
    avanza = status["advance"]
    print("   -> cursore: %s" % ("AVANZA" if avanza else "RESTA"))
    if err:
        print("   stderr: %s" % err[-300:])

    ok = (avanza == atteso_avanza)
    if atteso_verdetto:
        for regola, voluto in atteso_verdetto.items():
            if verdetti.get(regola) != voluto:
                ok = False
                print("   !! %s: atteso %s, ottenuto %s"
                      % (regola, voluto, verdetti.get(regola)))
    if atteso_status:
        for campo, voluto in atteso_status.items():
            if status.get(campo) != voluto:
                ok = False
                print("   !! stato.%s: atteso %s, ottenuto %s"
                      % (campo, voluto, status.get(campo)))
    esiti.append((label, ok))
    return verdetti


model = ScoreModel.from_musicxml(SCORE)
plan = PracticePlan(model)

print("piano: %d passi" % len(plan))
print("primo passo: %s" % plan.event_at(0))
print("regole attive: %s" % ", ".join(PRACTICE_RULES))
print("regole sospese: %s" % ", ".join(sorted(SUSPENDED_RULES)))

single = next(i for i, s in enumerate(plan.steps) if len(s["notes"]) == 1)
chord = next(i for i, s in enumerate(plan.steps) if len(s["notes"]) == 2)
print("passo singolo: %d  |  passo d'accordo: %d" % (single, chord))

# ---- 1. nota giusta
i = single
giusta = plan.steps[i]["pitches"][0]
caso("1. passo %d: premo la nota giusta (%d)" % (i, giusta), i,
     press(giusta, 1000), atteso_avanza=True,
     atteso_verdetto={"pitch-agreement": "ok"})

# ---- 2. nota sbagliata
caso("2. passo %d: premo la nota SBAGLIATA (%d, attesa %d)"
     % (i, giusta + 1, giusta), i,
     press(giusta + 1, 1000), atteso_avanza=False,
     atteso_verdetto={"pitch-agreement": "VIOLATA"})

# ---- 3. accordo premuto con calma: avanza, ma la regola segnala
i = chord
accordo = plan.steps[i]["pitches"]
ev = []
t = 1000
for p in accordo:
    ev += press(p, t)
    t += 500
caso("3. passo %d (accordo %s) premuto a 500 ms per nota" % (i, accordo), i, ev,
     atteso_avanza=True,
     atteso_verdetto={"pitch-agreement": "ok", "chord-jitter": "VIOLATA"})

# ---- 4. accordo premuto insieme
ev = []
t = 1000
for p in accordo:
    ev += press(p, t)
    t += 15
caso("4. passo %d (accordo %s) premuto a 15 ms per nota" % (i, accordo), i, ev,
     atteso_avanza=True,
     atteso_verdetto={"chord-jitter": "ok"})

# ---- 5. nota sostenuta dal passo precedente: non deve far avanzare
trovato = None
for k, s in enumerate(plan.steps):
    atteso = set(s["pitches"])
    suona = set(model.score_pitches_at(s["onset"]))
    estranee = suona - atteso
    if estranee and k > 0:
        trovato = (k, sorted(atteso), sorted(estranee)[0])
        break
if trovato is None:
    print("\n5. nessun passo con nota sostenuta estranea: caso non testabile")
    esiti.append(("5. nota sostenuta", True))
else:
    k, atteso, estranea = trovato
    caso("5. passo %d: premo la nota SOSTENUTA %d (attese %s)"
         % (k, estranea, atteso), k, press(estranea, 1000),
         atteso_avanza=False, atteso_verdetto={"pitch-agreement": "VIOLATA"})

# ---- 6. IL CASO DECISIVO: note giuste PIU' una in piu'.
#          Il cursore deve avanzare lo stesso, e la regola deve segnalare.
ev = []
t = 1000
for p in accordo:
    ev += press(p, t)
    t += 15
ev += press(accordo[0] + 1, t)          # una nota fuori dallo spartito, in piu'
caso("6. passo %d (accordo %s) SUONATO BENE + una nota in piu' (%d)"
     % (i, accordo, accordo[0] + 1), i, ev,
     atteso_avanza=True,
     atteso_verdetto={"pitch-agreement": "VIOLATA"})

# ---- 7. un note-on con velocity 0 E' un rilascio, non una pressione.
#          Se lo si trattasse come attacco, il cursore avanzerebbe su un
#          rilascio: e' la trappola che lo standard MIDI prepara e che le
#          tastiere vere fanno scattare.
ev = []
t = 1000
for p in accordo:
    ev += press(p, t)
    t += 15
# rilascio dell'ultima nota scritto come note-on con velocity 0
ev.append({"type": "noteon", "pitch": accordo[-1], "velocity": 0, "time_ms": t + 300})
caso("7. passo %d (accordo %s) suonato bene, chiuso da un note-on a velocity 0"
     % (i, accordo), i, ev,
     atteso_avanza=True,
     atteso_verdetto={"pitch-agreement": "ok"})

# ---- 8..13: il filtro per mano -------------------------------------------------
#
# I casi sopra girano sul piano completo, perche' e' quello che la modalita' ha
# sempre fatto. Qui si verifica l'altro regime: una mano sola, dove i passi, il
# cancello dell'avanzamento e la traccia che va a Prolog cambiano tutti e tre.

somma = hand_summary(model)
print("\nmani nel file: %s" % somma)
esiti.append(("8.  il file dichiara le due mani", somma["split"]))

if not somma["split"]:
    print("   (nessuna separazione per mano su questo file: i casi 9-13 non sono "
          "testabili e restano verdi)")
    for etichetta in ("9.  passi della mano sola", "10. indici del cursore",
                      "11. l'altra mano non e' un errore",
                      "12. solo l'altra mano: il passo non avanza",
                      "13. nota sbagliata con la mano sola"):
        esiti.append((etichetta, True))
else:
    destra = PracticePlan(model, "right")
    sinistra = PracticePlan(model, "left")

    # 9. I passi di una mano sono solo gli istanti in cui QUELLA mano suona, e
    #    nessun passo chiede un tasto dell'altra mano.
    attacchi_destra = sorted({n["onset"] for n in model.notes if n.get("staff") == 1})
    ok9 = len(destra) == len(attacchi_destra)
    for s in destra.steps:
        della_destra = {n["pitch"] for n in model.notes
                        if n["onset"] == s["onset"] and n.get("staff") == 1}
        ok9 = ok9 and set(s["pitches"]) <= della_destra
    print("\n9.  mano destra: %d passi, attacchi con la destra nel brano: %d "
          "| mano sinistra: %d passi"
          % (len(destra), len(attacchi_destra), len(sinistra)))
    esiti.append(("9.  passi della mano sola", ok9))

    # 10. L'indice ASSOLUTO dell'attacco deve puntare all'attacco giusto dello
    #     spartito completo: il cursore di OSMD conta quelli nell'ordine in cui li
    #     disegna, quindi se il numero sbaglia il pianista vede il segno di
    #     posizione sul punto sbagliato del rigo.
    indici = [s["attack"] for s in sinistra.steps]
    ok10 = (all(model._onsets[s["attack"]] == s["onset"] for s in sinistra.steps)
            and indici == sorted(indici) and len(set(indici)) == len(indici))
    print("10. indici del cursore per la sinistra: primi %s, ultimo %d "
          "(attacchi totali %d)" % (indici[:5], indici[-1], len(model._onsets)))
    esiti.append(("10. indici del cursore", ok10))

    # 11. LA MANO ESCLUSA NON E' UN ERRORE. Se studio la destra e premo anche il
    #     tasto che lo spartito chiede alla sinistra, quello non deve finire in
    #     `extra` (pitch-agreement lo leggerebbe come nota sbagliata) e non deve
    #     trattenere il cursore. Va pero' dichiarato in `other_hand`: un numero che
    #     sparisce in silenzio mente lo stesso.
    passo11 = next((k for k, s in enumerate(destra.steps)
                    if len(s["pitches"]) == 1 and s["offhand"]), None)
    if passo11 is None:
        print("11. nessun passo della destra con una nota sola e l'altra mano "
              "attesa: caso non testabile")
        esiti.append(("11. l'altra mano non e' un errore", True))
    else:
        s11 = destra.steps[passo11]
        ev = press(s11["pitches"][0], 1000) + press(s11["offhand"][0], 1012)
        caso("11. mano destra, passo %d: premo %d (atteso) e anche %d della sinistra"
             % (passo11, s11["pitches"][0], s11["offhand"][0]),
             passo11, ev, atteso_avanza=True, piano=destra,
             atteso_verdetto={"pitch-agreement": "ok", "chord-jitter": "ok"},
             atteso_status={"extra": [], "other_hand": [s11["offhand"][0]],
                            "missing": []})

    # 12. Se premo SOLO la nota dell'altra mano l'esercizio non e' completo: il
    #     cursore resta, ma quella nota non diventa una nota sbagliata.
    if passo11 is None:
        esiti.append(("12. solo l'altra mano: il passo non avanza", True))
    else:
        caso("12. mano destra, passo %d: premo SOLO %d della sinistra"
             % (passo11, s11["offhand"][0]),
             passo11, press(s11["offhand"][0], 1000), atteso_avanza=False,
             piano=destra,
             atteso_status={"extra": [], "other_hand": [s11["offhand"][0]],
                            "missing": list(s11["pitches"])})

    # 13. Con la mano sola la nota sbagliata si vede lo stesso: il filtro toglie
    #     l'altra mano dalla richiesta e dalla traccia, non la valutazione.
    if passo11 is None:
        esiti.append(("13. nota sbagliata con la mano sola", True))
    else:
        caso("13. mano destra, passo %d: premo %d invece di %d"
             % (passo11, s11["pitches"][0] + 1, s11["pitches"][0]),
             passo11, press(s11["pitches"][0] + 1, 1000), atteso_avanza=False,
             piano=destra,
             atteso_verdetto={"pitch-agreement": "VIOLATA"},
             atteso_status={"extra": [s11["pitches"][0] + 1], "other_hand": []})

# ---------------------------------------------------------------- riepilogo
print("\n" + "=" * 58)
falliti = [l for l, ok in esiti if not ok]
for label, ok in esiti:
    print("  %s  %s" % ("OK     " if ok else "FALLITO", label))
print("=" * 58)
print("%d/%d casi come atteso" % (len(esiti) - len(falliti), len(esiti)))
sys.exit(1 if falliti else 0)
