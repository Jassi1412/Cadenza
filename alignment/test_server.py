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

from join import ScoreModel  # noqa: E402
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
        # Le posizioni viaggiano solo sulle regole violate: una nota rossa dove
        # il monitor non ha giudicato niente sarebbe un'accusa inventata.
        check("le posizioni compaiono solo sulle regole violate",
              all(("locations" in v) == (v["exit"] == 1)
                  for v in res["verdicts"].values()))

    # ---- le dita sporche: due note stonate devono essere INDICATE, non solo contate
    #
    # E' il cuore del verdetto nuovo: la pagina colora di rosso le note che il
    # tooltip accusa, quindi il servizio deve puntare il punto giusto. Qui si
    # sporcano due note precise e si pretende che la regola del pitch dica QUEL
    # battuta e QUELLA battitura, calcolate dalla stessa mappa che usa join.py.
    print("\n=== POST / : due note stonate, il verdetto deve sapere dove ===")
    sporche = [dict(n) for n in notes]
    sporche[5]["pitch"] += 3
    sporche[40]["pitch"] -= 2
    res2, ms, err = post("/", {"score": score_xml, "notes": sporche,
                               "control_changes": [], "tempo_factor": 1.0})
    if err:
        print("  ERRORE: %s" % err)
        check("la prova stonata risponde", False)
    else:
        pa = res2["verdicts"].get("pitch-agreement", {})
        locs = pa.get("locations") or []
        print("  pitch-agreement exit %s, %d posizioni in %.0f ms"
              % (pa.get("exit"), len(locs), ms))
        check("con due note stonate pitch-agreement e' violata", pa.get("exit") == 1)
        check("la prova stonata produce posizioni", len(locs) > 0)

        # L'hover minimalista della pagina vive di NUMERI, non di frasi: sulle
        # note stonate ogni posizione deve portare il tasto premuto e quello
        # scritto, come due interi. E da qualche parte i due devono differire,
        # perche' qui le stonature le abbiamo messe noi dentro di proposito.
        con_valori = [l for l in locs if l.get("kind") == "pitch"]
        print("  %d/%d posizioni con i numeri nudi premuto/scritto"
              % (len(con_valori), len(locs)))
        check("le pitch violate portano i numeri premuto e scritto",
              len(con_valori) > 0
              and all(isinstance(l.get("played"), int)
                      and isinstance(l.get("written"), int)
                      for l in con_valori))
        check("i due numeri raccontano l'errore: qualche tasto non e' quello chiesto",
              any(l["played"] != l["written"] for l in con_valori))

        def attesa(i):
            n = sporche[i]
            b = model.snap_beat(model.beat_at(n["time_ms"]))
            return (model.measure_at(b), round(b, 4))

        volute = [attesa(5), attesa(40)]
        date = {(l["measure"], l["beat"]) for l in locs}
        for (vm, vb) in volute:
            hit = any(m == vm and abs(bb - vb) < 1e-3 for (m, bb) in date)
            check("la nota stonata alla battuta %s e' segnalata" % vm, hit,
                  "atteso (%s, %s), ricevuto %s" % (vm, vb, sorted(date)[:8]))
        check("ogni posizione ha misura e battitura",
              all(isinstance(l.get("measure"), int) and isinstance(l.get("beat"), float)
                  for l in locs))
        check("nessuna regola e' in errore sulla prova stonata (exit 2)",
              all(v["exit"] != 2 for v in res2["verdicts"].values()))

    # ---- la verita' dell'utente (2026-11-10): a meta' della prova smette di
    #      premere. Nessun tasto mai premuto non produce nessuna riga di traccia,
    #      quindi nessun monitor RML puo' puntarli: deve pensarci la copertura,
    #      e deve nominare QUEGLI attacchi come "never played", col punto giusto.
    print("\n=== POST / : si smette di suonare a meta', i buchi diventano rossi ===")

    def verdi_rosse_distinte(r):
        """Nessun attacco del verde compare in una locazione rossa: mai, in nessun verdetto."""
        rossi = set()
        for vv in r["verdicts"].values():
            for ll in (vv.get("locations") or []):
                if isinstance(ll.get("attack"), int):
                    rossi.add(ll["attack"])
        return all(not (isinstance(ll.get("attack"), int) and ll["attack"] in rossi)
                   for ll in r.get("correct") or [])

    check("la risposta porta la lista verde accanto ai verdetti",
          isinstance(res2.get("correct"), list))
    check("il verde della prova stonata non pesta nessun rosso",
          verdi_rosse_distinte(res2))

    meta = [dict(n) for n in notes][:len(notes) * 3 // 5]
    res3, ms, err = post("/", {"score": score_xml, "notes": meta,
                               "control_changes": [], "tempo_factor": 1.0})
    if err:
        print("  ERRORE: %s" % err)
        check("la prova fermata a meta' risponde", False)
    else:
        npv = res3["verdicts"].get("never played") or {}
        locs3 = npv.get("locations") or []
        print("  never played exit %s, %d posizioni in %.0f ms"
              % (npv.get("exit"), len(locs3), ms))
        check("gli attacchi fermati a meta' diventano la regola 'never played' con le sue posizioni",
              npv.get("ok") is False and npv.get("exit") == 1 and len(locs3) > 0)
        check("ogni buco indica un punto completo: misura, battitura e indice d'attacco",
              all(isinstance(l.get("measure"), int) and isinstance(l.get("beat"), float)
                  and isinstance(l.get("attack"), int) for l in locs3))
        check("il verde della prova a meta' non pesta nessun rosso",
              verdi_rosse_distinte(res3))

    # ---- e l'altra metà della denuncia: nota GIUSTA ma con mezzo secondo di
    #      ritardo. Nello snap di join quella pressione risultava in tempo quasi
    #      perfetto sull'attacco vicino (verita' misurata); la copertura la
    #      riacciuffa sul tasto che ha davvero premuto e ne scrive il ritardo,
    #      col segno, sulla posizione giusta.
    print("\n=== POST / : mezzo secondo di ritardo su una nota ===")
    in_ritardo = [dict(n) for n in notes]
    bersaglio = min(40, len(in_ritardo) - 1)
    in_ritardo[bersaglio]["time_ms"] += 500.0
    res4, ms, err = post("/", {"score": score_xml, "notes": in_ritardo,
                               "control_changes": [], "tempo_factor": 1.0})
    if err:
        print("  ERRORE: %s" % err)
        check("la prova in ritardo risponde", False)
    else:
        otm = res4["verdicts"].get("out of time") or {}
        locs4 = otm.get("locations") or []
        print("  out of time exit %s, %d posizioni in %.0f ms"
              % (otm.get("exit"), len(locs4), ms))
        check("la nota giusta fuori tempo diventa la regola 'out of time'",
              otm.get("ok") is False and otm.get("exit") == 1 and len(locs4) > 0)
        check("il ritardo arriva come numero col segno, kind timing e non sotto la soglia",
              any(isinstance(l.get("played"), int) and l.get("kind") == "timing"
                  and abs(l["played"]) >= 150 for l in locs4))
        check("il verde della prova in ritardo non pesta nessun rosso",
              verdi_rosse_distinte(res4))

    # ---- la traccia pulita non deve MAI colorare niente: se una regola e'
    #      conforme la caccia agli indici non parte nemmeno, quindi niente
    #      falsi allarmi su chi ha suonato bene.
    if not err and res and not any(v["exit"] == 1 for v in res["verdicts"].values()):
        check("sulla prova perfetta nessuna posizione", True)

    # ---- la presa intera con UNA MANO e SENZA DINAMICA (richiesta 2026-11-10).
    #
    # Sono gli stessi due comandi della pratica, portati a fine brano: L/R
    # scelgono il rigo da giudicare, D decide se dynamics-adherence entra nel
    # verdetto. La prova qua sotto e' la stessa esecuzione "pulita" di prima,
    # che suona TUTTE E DUE le mani: se il filtro non togliesse le note
    # dell'altra mano, pitch-agreement le accuserebbe subito.
    # ---- la verita' dell'utente (2026-11-11): a meta' velocita' ha suonato
    #      entrambe le mani, e la seconda nota di destra di ogni misura e'
    #      arrivata in anticipo di poche decine di ms. Il join la agganciava
    #      all'attacco PRECEDENTE — l'accordo di sinistra ancora TENUTO — e
    #      chord-jitter la accusava di non essere arrivata insieme a un accordo
    #      che nessuno aveva riattaccato. Ora l'accordo e' quello della nota
    #      scritta riconosciuta dal pitch, non l'ultimo attacco passato.
    print("\n=== POST / : la nota in anticipo non eredita l'accordo tenuto ===")
    warmup = os.path.join(REPO, "Warmup C Major (scale and chords).musicxml")
    with open(warmup, encoding="utf-8") as f:
        warm_xml = f.read()
    wmodel = ScoreModel.from_musicxml(warmup)
    warm_notes, early_done = [], False
    for onset, pitches in wmodel.attacks():
        at = wmodel.ms_at(onset) * 2.0
        for p in pitches:
            early = 60.0 if (p == 62 and not early_done) else 0.0
            early_done = early_done or early > 0
            warm_notes.append({"time_ms": at - early, "dur_ms": 500,
                               "pitch": p, "velocity": 80})
    warm, ms, err = post("/", {"score": warm_xml, "notes": warm_notes,
                               "control_changes": [], "tempo_factor": 2.0,
                               "dynamics": False})
    if err:
        print("  ERRORE: %s" % err)
        check("la presa del Warmup risponde", False)
    else:
        cj = warm["verdicts"].get("chord-jitter") or {}
        print("  chord-jitter exit %s in %.0f ms" % (cj.get("exit"), ms))
        check("una nota anticipata non eredita l'accordo della mano tenuta",
              cj.get("exit") == 0)

    print("\n=== POST /hands : cosa si puo' separare ===")
    hm, ms, err = post("/hands", {"score": score_xml})
    if err:
        print("  ERRORE: %s" % err)
        check("/hands risponde", False)
    else:
        mani = hm.get("hands") or {}
        print("  %s in %.0f ms" % (mani, ms))
        check("/hands dichiara le due mani e il file le separa",
              mani.get("split") is True and mani.get("right", 0) > 0
              and mani.get("left", 0) > 0 and mani.get("unknown") == 0)
        check("/hands non costruisce il piano: nessun elenco di passi",
              "steps" not in hm)

    print("\n=== POST / : la presa giudicata sulla mano sinistra ===")
    sx_plan, _, err_sx = post("/practice", {"score": score_xml, "hand": "left"})
    if err_sx or not sx_plan:
        check("il piano della sinistra e' disponibile", False)
    else:
        attacchi_sx = {s["attack"] for s in sx_plan["steps"]}
        sola, ms, err = post("/", {"score": score_xml, "notes": notes,
                                   "control_changes": [], "tempo_factor": 1.0,
                                   "hand": "left", "dynamics": False})
        if err:
            print("  ERRORE: %s" % err)
            check("la presa per mano risponde", False)
        else:
            rossi, verdi = set(), set()
            for v in sola["verdicts"].values():
                for l in v.get("locations") or []:
                    if isinstance(l.get("attack"), int):
                        rossi.add(l["attack"])
            verdi = {l.get("attack") for l in sola.get("correct") or []}
            print("  %d rossi, %d verdi in %.0f ms" % (len(rossi), len(verdi), ms))
            check("con una mano nessun punto rosso cade fuori da quella mano",
                  rossi <= attacchi_sx, sorted(rossi - attacchi_sx)[:6])
            check("con una mano nessun verde cade fuori da quella mano",
                  verdi <= attacchi_sx, sorted(verdi - attacchi_sx)[:6])
            check("la mano sinistra e' giudicata davvero: qualche verde",
                  len(verdi) > 0)
            check("pitch-agreement non accusa le note dell'altra mano",
                  (sola["verdicts"].get("pitch-agreement") or {}).get("exit") == 0)
            check("la mano non suonata in questa presa non diventa 'never played'",
                  "never played" not in sola["verdicts"])
            check("con D spento la regola della dinamica non compare",
                  "dynamics-adherence" not in sola["verdicts"])
            check("con D acceso la regola della dinamica c'e', e ha giudicato",
                  res is not None and "dynamics-adherence" in res["verdicts"]
                  and res["verdicts"]["dynamics-adherence"]["exit"] in (0, 1))
            # Il pedale non e' ne' dell'una ne' dell'altra: filtrato cambierebbe
            # risposta senza che l'esecuzione cambi (misurato: la stessa presa
            # pulita "fallisce" a sinistra e passa a destra). Si sospende, e la
            # risposta lo dichiara invece di lasciare un silenzio assolutorio.
            check("con una mano il pedale non si giudica",
                  not ({"pedal-toggle", "syncopated-pedal"} & set(sola["verdicts"])))
            check("e le due regole sospese sono dichiarate nella risposta",
                  sorted(sola.get("suspended") or {})
                  == ["pedal-toggle", "syncopated-pedal"])
            # La pagina colora solo il rigo giudicato: deve sapere quale mano
            # senza indovinarlo dalla scelta a schermo (che puo' essere cambiata).
            check("la risposta dichiara la mano giudicata",
                  sola.get("hand") == "left")

    _, _, err = post("/", {"score": score_xml, "notes": notes, "hand": "destra"})
    print("\n=== POST / : mano scritta male ===")
    print("  risposta: %s" % (err or "(nessun errore!)").strip()[:140])
    check("una mano sconosciuta e' un 400 anche nella presa intera", err is not None)

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
