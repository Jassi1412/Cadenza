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
                      SUSPENDED_RULES, step_status, trace_for_step)

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


def caso(label, index, events, atteso_avanza, atteso_verdetto=None):
    """Esegue un caso, confronta con l'atteso e registra l'esito."""
    status = step_status(plan, index, events)
    trace = trace_for_step(plan, index, events)
    verdetti, err = judge(trace)

    print("\n%s" % label)
    print("   attese %s | premute %s | mancanti %s | estranee %s"
          % (status["expected"], status["pressed"],
             status["missing"], status["extra"]))
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

# ---------------------------------------------------------------- riepilogo
print("\n" + "=" * 58)
falliti = [l for l, ok in esiti if not ok]
for label, ok in esiti:
    print("  %s  %s" % ("OK     " if ok else "FALLITO", label))
print("=" * 58)
print("%d/%d casi come atteso" % (len(esiti) - len(falliti), len(esiti)))
sys.exit(1 if falliti else 0)
