"""Prova end-to-end dei tre endpoint, via HTTP vero.

Avvia server.py su una porta libera e fa le tre chiamate che fara' il frontend:
il piano, un passo suonato bene, un passo con una nota sbagliata. Controlla
anche che il cursore avanzi o resti come deve.

Non usa la temp di sistema perche' sotto il sandbox di sviluppo non e'
scrivibile: TMPDIR punta a una cartella nel workspace.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(ROOT)
TMPDIR = os.path.join(ROOT, "_probe_traces", "tmp")
os.makedirs(TMPDIR, exist_ok=True)

PORT = 8137
API = "http://127.0.0.1:%d" % PORT
SCORE = os.path.join(REPO,
                     "The Legend of Zelda_ Great Fairy Fountain (Piano Cover).musicxml")

env = dict(os.environ)
env["TMPDIR"] = TMPDIR
env["TEMP"] = TMPDIR
env["TMP"] = TMPDIR
env["PYTHONIOENCODING"] = "utf-8"
env["PORT"] = str(PORT)
if "RML_SPECS" not in env:
    env["RML_SPECS"] = os.path.join(REPO, "RML_DOCS", "RML_TESTS", "metrics")
if "RML_MONITOR" not in env:
    env["RML_MONITOR"] = os.path.join(REPO, "RML_DOCS", "RML_TESTS", "monitor")

with open(SCORE, encoding="utf-8") as f:
    score_xml = f.read()

proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")],
                        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        cwd=ROOT)


def post(path, payload, timeout=180):
    req = urllib.request.Request(API + path,
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read()), (time.perf_counter() - t0) * 1000, None
    except urllib.error.HTTPError as e:
        return None, (time.perf_counter() - t0) * 1000, e.read().decode()[:400]


def get(path, timeout=30):
    with urllib.request.urlopen(API + path, timeout=timeout) as r:
        return json.loads(r.read())


esiti = []


def check(label, cond, detail=""):
    esiti.append((label, bool(cond)))
    print("  %s %s%s" % ("OK     " if cond else "FALLITO", label,
                         ("  <- " + detail) if detail and not cond else ""))


try:
    # aspetta che il server risponda
    for _ in range(60):
        try:
            info = get("/")
            break
        except Exception:
            time.sleep(0.5)
    else:
        raise RuntimeError("il server non risponde")

    print("=== GET / ===")
    print("  servizio: %s" % info.get("service"))
    print("  metriche: %d" % len(info.get("metrics", [])))
    print("  pratica attive: %s" % info.get("practice", {}).get("rules"))
    print("  pratica sospese: %s" % list(info.get("practice", {}).get("suspended", {})))
    check("il GET dichiara le 4 regole di pratica",
          len(info.get("practice", {}).get("rules", [])) == 4)
    check("il GET dichiara le 3 sospese",
          len(info.get("practice", {}).get("suspended", {})) == 3)
    check("il GET dichiara le mani che il filtro sa isolare",
          info.get("practice", {}).get("hands") == ["right", "left"])

    print("\n=== POST /practice (il piano) ===")
    pieno = None
    data, ms, err = post("/practice", {"score": score_xml})
    if err:
        print("  ERRORE: %s" % err)
        check("il piano risponde", False)
    else:
        print("  %d passi in %.0f ms" % (data["total"], ms))
        print("  primo passo: %s" % data["steps"][0])
        check("il piano ha 128 passi", data["total"] == 128)
        check("il piano manda tutti i passi", len(data["steps"]) == data["total"])
        check("ogni passo ha i suoi pitch",
              all(isinstance(s["pitch"], list) and s["pitch"]
                  for s in data["steps"]))
        check("il piano dichiara le regole attive", len(data["rules"]) == 4)
        check("il piano dichiara le regole sospese", len(data["suspended"]) == 3)
        primo_passo = data["steps"][0]
        pieno = data            # serve ai controlli sul filtro per mano, piu' sotto

    # secondo giro: deve venire dalla cache, quindi molto piu' veloce
    _, ms2, _ = post("/practice", {"score": score_xml})
    print("\n=== POST /practice (di nuovo: cache) ===")
    print("  %.0f ms (prima: %.0f ms, la lettura dello spartito non si ripete)"
          % (ms2, ms))
    check("il secondo piano e' piu' veloce", ms2 < ms)

    # ---- passo 0, l'accordo, suonato bene
    print("\n=== POST /practice/step : passo 0 (accordo) suonato bene ===")
    primo = primo_passo["pitch"]
    events = []
    t = 1000
    for p in primo:
        events.append({"type": "noteon", "pitch": p, "velocity": 80, "time_ms": t})
        events.append({"type": "noteoff", "pitch": p, "velocity": 0, "time_ms": t + 200})
        t += 15
    step, ms, err = post("/practice/step",
                         {"score": score_xml, "step": 0, "events": events})
    if err:
        print("  ERRORE: %s" % err)
        check("il passo risponde", False)
    else:
        print("  %.0f ms" % ms)
        print("  status: %s" % step["status"])
        for k, v in step["verdicts"].items():
            print("    %-22s exit %d  %s"
                  % (k, v["exit"], "ok" if v["ok"] else "VIOLATA"))
        check("il passo 0 avanza", step["status"]["advance"] is True)
        check("le 4 regole hanno un verdetto", len(step["verdicts"]) == 4)
        # exit 2 = il monitor non e' partito. Non e' una violazione, ed e' il
        # modo peggiore di sbagliare: l'errore del servizio letto dall'allievo
        # come un giudizio sulla sua esecuzione.
        check("nessuna regola e' in errore (exit 2)",
              all(v["exit"] != 2 for v in step["verdicts"].values()),
              "exit 2 = monitor non partito, non violazione")
        check("il verdetto e' tutto conforme",
              all(v["ok"] for v in step["verdicts"].values()))

        # la seconda chiamata deve riusare il piano in cache
        print("  (seconda chiamata sullo stesso spartito: %.0f ms, piano in cache)" % ms)

    # ---- passo 0 con una nota sbagliata
    print("\n=== POST /practice/step : passo 0 con una nota SBAGLIATA ===")
    events2 = []
    t = 1000
    for i, p in enumerate(primo):
        pitch = (p + 1) if i == 0 else p
        events2.append({"type": "noteon", "pitch": pitch, "velocity": 80, "time_ms": t})
        events2.append({"type": "noteoff", "pitch": pitch, "velocity": 0,
                        "time_ms": t + 200})
        t += 15
    step2, ms, err = post("/practice/step",
                          {"score": score_xml, "step": 0, "events": events2})
    if err:
        print("  ERRORE: %s" % err)
        check("il passo sbagliato risponde", False)
    else:
        print("  status: %s" % step2["status"])
        for k, v in step2["verdicts"].items():
            print("    %-22s %s" % (k, "ok" if v["ok"] else "VIOLATA"))
        check("con la nota sbagliata il cursore RESTA",
              step2["status"]["advance"] is False)
        check("la nota sbagliata risulta mancante",
              len(step2["status"]["missing"]) == 1)

    # ---- passo fuori dal brano: deve essere un 400
    print("\n=== POST /practice/step : passo fuori dal brano ===")
    _, _, err = post("/practice/step",
                     {"score": score_xml, "step": 999, "events": []})
    print("  risposta: %s" % (err or "(nessun errore!)").strip()[:120])
    check("il passo fuori range e' rifiutato", err is not None)

    # ---- nessuna nota premuta: non deve dire "conforme"
    print("\n=== POST /practice/step : nessuna nota premuta ===")
    vuoto, _, err = post("/practice/step",
                         {"score": score_xml, "step": 0, "events": []})
    if err:
        print("  ERRORE: %s" % err)
    else:
        print("  verdetti: %s" % vuoto["verdicts"])
        print("  mancanti: %s" % vuoto["status"]["missing"])
        check("senza note non si dichiara nessun verdetto",
              len(vuoto["verdicts"]) == 0)
        check("senza note il cursore resta", vuoto["status"]["advance"] is False)

    # ---- il filtro per mano, via HTTP
    #
    # Sono tre le cose da verificare qui e non solo nel modulo: che il servizio
    # dichiari quante mani ha lo spartito (il frontend ci spegne il toggle se
    # false), che l'indice assoluto dell'attacco arrivi giusto (e' quello che il
    # cursore di OSMD deve contare), e che un passo valido per il brano completo
    # diventi rifiutato dentro l'esercizio di una mano sola.
    print("\n=== POST /practice : mano sinistra sola ===")
    sx, ms, err = post("/practice", {"score": score_xml, "hand": "left"})
    if err or not pieno:
        print("  ERRORE: %s" % (err or "piano completo non disponibile"))
        check("il piano per mano risponde", False)
    else:
        mani = sx.get("hands", {})
        print("  mani nel file: %s" % mani)
        print("  passi sinistra: %d, brano completo: %d (%.0f ms)"
              % (sx["total"], pieno["total"], ms))
        check("il piano dichiara le due mani dello spartito",
              mani.get("split") is True and mani.get("right", 0) > 0
              and mani.get("left", 0) > 0)
        check("la mano sinistra ha meno passi del brano completo",
              0 < sx["total"] < pieno["total"])
        indici = [s.get("attack") for s in sx["steps"]]
        check("ogni passo per mano porta l'indice assoluto dell'attacco",
              all(isinstance(a, int) for a in indici))
        check("gli indici sono crescenti e senza buchi nell'ordine",
              indici == sorted(indici) and len(set(indici)) == len(indici))
        check("i passi della sinistra stanno dentro gli attacchi del brano",
              all(a < pieno["total"] and set(s["pitch"]) <= set(pieno["steps"][a]["pitch"])
                  for s, a in zip(sx["steps"], indici)))

        print("\n=== POST /practice/step : mano sinistra, nota della destra ===")
        primo_sx = sx["steps"][0]
        ev = []
        t = 1000
        for p in primo_sx["pitch"]:
            ev.append({"type": "noteon", "pitch": p, "velocity": 80, "time_ms": t})
            ev.append({"type": "noteoff", "pitch": p, "velocity": 0, "time_ms": t + 200})
            t += 15
        altre = primo_sx.get("offhand") or []
        if altre:
            # la premo DOPO, perche' se fosse giudicata sarebbe una nota fuori
            # posto: deve essere ignorata, non perdonata
            ev.append({"type": "noteon", "pitch": altre[0], "velocity": 80,
                       "time_ms": t + 400})
            ev.append({"type": "noteoff", "pitch": altre[0], "velocity": 0,
                       "time_ms": t + 600})
        sxstep, ms, err = post("/practice/step",
                               {"score": score_xml, "hand": "left",
                                "step": 0, "events": ev})
        if err:
            print("  ERRORE: %s" % err)
            check("il passo per mano risponde", False)
        else:
            print("  attese %s | premute %s | altra mano %s | estranee %s"
                  % (sxstep["status"]["expected"], sxstep["status"]["pressed"],
                     sxstep["status"]["other_hand"], sxstep["status"]["extra"]))
            check("il passo per mano dice quale mano si sta studiando",
                  sxstep.get("hand") == "left")
            check("la nota dell'altra mano e' dichiarata, non giudicata",
                  not sxstep["status"]["extra"]
                  and (not altre or sxstep["status"]["other_hand"] == [altre[0]]))
            check("con la mano sola il passo completo avanza",
                  sxstep["status"]["advance"] is True)
            check("nessuna regola e' in errore sul passo per mano (exit 2)",
                  all(v["exit"] != 2 for v in sxstep["verdicts"].values()))

        print("\n=== POST /practice/step : fuori dall'esercizio della mano ===")
        _, _, err = post("/practice/step",
                         {"score": score_xml, "hand": "left",
                          "step": sx["total"], "events": []})
        print("  risposta: %s" % (err or "(nessun errore!)").strip()[:140])
        check("un passo oltre i passi della mano e' rifiutato", err is not None)

    _, _, err = post("/practice/step",
                     {"score": score_xml, "hand": "destra", "step": 0, "events": []})
    print("\n=== POST /practice/step : mano scritta male ===")
    print("  risposta: %s" % (err or "(nessun errore!)").strip()[:140])
    check("una mano sconosciuta e' un 400, non 'tutte le mani'", err is not None)

    # ---- la modalita' normale deve continuare a funzionare
    print("\n=== POST / (modalita' normale, non deve essersi rotta) ===")
    sys.path.insert(0, ROOT)
    from join import ScoreModel  # noqa: E402
    model = ScoreModel.from_musicxml(SCORE)
    notes = []
    for n in model.notes:
        o = model.ms_at(n["onset"])
        notes.append({"time_ms": round(o, 2),
                      "dur_ms": round(model.ms_at(n["onset"] + n["duration"]) - o, 2),
                      "pitch": n["pitch"], "velocity": 80})
    notes.sort(key=lambda x: x["time_ms"])
    res, ms, err = post("/", {"score": score_xml, "notes": notes,
                              "control_changes": [], "tempo_factor": 1.0})
    if err:
        print("  ERRORE: %s" % err)
        check("la modalita' normale risponde", False)
    else:
        ok = sum(1 for v in res["verdicts"].values() if v["ok"])
        print("  %d/%d conformi in %.0f ms" % (ok, len(res["verdicts"]), ms))
        check("la modalita' normale da' 7 verdetti", len(res["verdicts"]) == 7)

finally:
    proc.terminate()
    try:
        out, err = proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
    log = (err or b"").decode(errors="replace")
    if "Traceback" in log:
        print("\n--- log del server (ultime righe) ---")
        print("\n".join(log.strip().splitlines()[-25:]))

print("\n" + "=" * 58)
falliti = [l for l, ok in esiti if not ok]
for label, ok in esiti:
    print("  %s  %s" % ("OK     " if ok else "FALLITO", label))
print("=" * 58)
print("%d/%d controlli passati" % (len(esiti) - len(falliti), len(esiti)))
sys.exit(1 if falliti else 0)
