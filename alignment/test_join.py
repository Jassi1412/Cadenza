"""Test del JOIN con difetti piantati a coordinate note.

Non uso una registrazione reale perche' non esiste ancora: genero
un'esecuzione sintetica dallo spartito, rovinata in modo noto, e verifico
che il JOIN trovi esattamente i difetti piantati e non inventi altri.

Se questo test fallisce, il bug e' del JOIN, non del test: la verita' e' nota.
"""
import numpy as np
import partitura as pt

from join import ScoreModel, join, to_jsonl

SCORE = "/score/The Legend of Zelda_ Great Fairy Fountain (Piano Cover) - con dinamiche.musicxml"

MS_PER_BEAT = 600.0          # 100 bpm, lo spartito non ha indicazione di tempo
TOO_SOFT_FACTOR = 0.7       # sotto il 70% della dinamica attesa = troppo leggera

# Fino a qui l'esecuzione segue il tempo dello spartito, quindi la diagnosi dei
# difetti e' affidabile. Oltre questo punto comincia il rallentamento piantato,
# e il fattore di velocita' — uno solo per tutta l'esecuzione — non puo' seguire
# un rallentamento che cambia meta' brano. Li' quello che si vede non e' piu'
# "questa nota e' sbagliata" ma "da qui in poi suono piu' piano".
ALIGNED_UNTIL_BEAT = 26.0


# Queste due funzioni sono le stesse regole che scrivera' dynamics-adherence.rml
# e pitch-agreement.rml, scritte in Python. Il JOIN non sa cosa sia un errore:
# mette a confronto i campi e lascia che sia RML a concludere. Qui le ripetiamo
# solo per avere un riferimento, finche' il monitor non e' eseguibile.

def too_soft(e):
    # solo noteon: la traccia contiene anche i noteoff, che non hanno rawAttack
    return e["type"] == "noteon" and e["expected"]["dynExplicit"] and \
        e["note"]["rawAttack"] < e["expected"]["dyn"] * TOO_SOFT_FACTOR


def wrong_pitch(e):
    return e["type"] == "noteon" and \
        e["expected"]["pitchDist"] is not None and e["expected"]["pitchDist"] > 0


def build_performance(model):
    """Esegue lo spartito rovinandolo, e restituisce (note, verita'-terreno)."""
    perf, truth = [], {"too_soft": 0, "wrong_pitch": 0, "dropped": 0}

    for i, n in enumerate(model.notes):
        beat = n["onset"]

        # difetto 1: dalla battuta 26 in poi il pianista rallenta del 35%
        t = beat * MS_PER_BEAT
        if beat >= 26:
            t = 26 * MS_PER_BEAT + (t - 26 * MS_PER_BEAT) * 1.35

        # difetto 2: salta 4 note sparse (note mancate)
        if i in (7, 40, 90, 150):
            truth["dropped"] += 1
            continue

        vel = n["expected_dyn"] or 80
        # durata reale della nota, non un valore fisso: un pianolo fatto di
        # note da 50 ms non e' suonabile e l'allineatore non lo distingue
        # da uno spartito pieno di buchi.
        dur_ms = n["duration"] * MS_PER_BEAT

        # difetto 3: le prime 8 note del climax le suona tutte pianissimo
        if 24 <= beat < 26:
            vel = 30
            truth["too_soft"] += 1

        perf.append({"time_ms": t, "pitch": n["pitch"], "velocity": vel,
                     "score_beat": beat, "dur_ms": dur_ms})

        # difetto 4: 3 note sbagliate, con un semitono sopra
        if i in (20, 100, 180):
            perf.append({"time_ms": t + 12, "pitch": n["pitch"] + 1,
                         "velocity": vel, "score_beat": beat, "dur_ms": dur_ms})
            # contate solo nella zona in cui l'allineamento regge: oltre, il
            # difetto non e' distinguibile dalla deriva di tempo
            if beat < ALIGNED_UNTIL_BEAT:
                truth["wrong_pitch"] += 1

    perf.sort(key=lambda x: x["time_ms"])
    return perf, truth


def main():
    print("=== 1. carico lo spartito ===")
    model = ScoreModel.from_musicxml(SCORE)
    print("  note       :", len(model.notes))
    print("  dinamiche  :", len(model.dynamics),
          [d["text"] for d in model.dynamics])
    print("  pedali     :", len(model.pedals))
    print("  beat/div   :", model.beat_grad)
    print("  span pedali:", [round(p["start"], 2) for p in model.pedals[:5]], "...")
    print("  span dinam.:", [(round(d["start"], 2), round(d["end"], 2)) for d in model.dynamics])
    assert len(model.notes) == 216, "le note non sono 216"
    assert len(model.dynamics) == 4, "le dinamiche non sono 4"
    assert len(model.pedals) >= 1, "nessun pedale letto dall'XML"

    print()
    print("=== 2. genero l'esecuzione rovinata ===")
    perf, truth = build_performance(model)
    print("  note suonate   :", len(perf))
    print("  difetti piantati: troppo leggere %d, pitch sbagliati %d, saltate %d"
          % (truth["too_soft"], truth["wrong_pitch"], truth["dropped"]))
    print()
    print("=== 3. il fattore di velocita' ===")
    # L'esecuzione sintetica mette MS_PER_BEAT ms per battuta, lo spartito ne
    # chiede un altro numero. Il fattore e' quanti millisecondi reali vale un
    # millisecondo scritto: quindi i ms dell'esecuzione, diviso quelli dello
    # spartito. Sotto unita' l'esecuzione e' piu' veloce dello scritto.
    score_ms_per_beat = (model.ms_at(2.0) - model.ms_at(0.0)) / 2.0
    tempo_factor = MS_PER_BEAT / score_ms_per_beat
    print("  ms per battuta nello spartito  : %.2f" % score_ms_per_beat)
    print("  ms per battuta nell'esecuzione : %.2f" % MS_PER_BEAT)
    print("  fattore: %.4f  (suona al %.0f%% del tempo scritto)"
          % (tempo_factor, 100.0 / tempo_factor))

    print()
    print("=== 4. JOIN ===")
    events = join(model, perf, tempo_factor)
    print("  eventi annotati:", len(events))
    for e in events[:2]:
        print("  esempio:", to_jsonl([e]))

    found_soft = sum(1 for e in events
                      if e["position"]["beat"] < ALIGNED_UNTIL_BEAT and too_soft(e))
    found_wrong = sum(1 for e in events
                      if e["position"]["beat"] < ALIGNED_UNTIL_BEAT and wrong_pitch(e))
    print()
    print("  troppo leggere  : trovati %d, piantati %d" % (found_soft, truth["too_soft"]))
    print("  pitch sbagliati : trovati %d, piantati %d" % (found_wrong, truth["wrong_pitch"]))

    print()
    print("=== 5. le note che RML giudicherebbe sbagliate ===")
    aligned = [e for e in events
               if e["position"]["beat"] < ALIGNED_UNTIL_BEAT and wrong_pitch(e)]
    for e in aligned[:10]:
        print("  suonata %d, attesa %d (distanza %d semitoni), battuta %.1f, misura %d"
              % (e["note"]["number"], e["expected"]["pitch"],
                 e["expected"]["pitchDist"],
                 e["position"]["beat"], e["position"]["measure"]))
    print("  (se %d righe e non %d, il problema e' altrove)"
          % (len(aligned), truth["wrong_pitch"]))

    # la traccia che andra' in pasto al monitor RML
    with open("/work/joined.jsonl", "w", encoding="utf-8") as f:
        f.write(to_jsonl(events) + "\n")
    print()
    print("  traccia per RML scritta in /work/joined.jsonl")

    print()
    print("=== 6. il rallentamento e' visibile? ===")
    # dalla battuta 26 in poi il tempo e' allungato del 35%: il delta
    # rispetto al previsto deve crescere.
    late = [e["timing"]["deltaMs"] for e in events if e["position"]["beat"] > 26]
    early = [e["timing"]["deltaMs"] for e in events if e["position"]["beat"] < 20]
    if late and early:
        print("  delta medio prima della battuta 20 : %+.0f ms" % (sum(early) / len(early)))
        print("  delta medio dopo la battuta 26     : %+.0f ms" % (sum(late) / len(late)))
        assert sum(late) / len(late) > sum(early) / len(early), \
            "il rallentamento non si vede nei tempi"

    assert found_wrong == truth["wrong_pitch"], \
        "il JOIN ha perso o inventato note sbagliate"
    assert found_soft == truth["too_soft"], \
        "il JOIN ha perso o inventato note troppo leggere"

    print()
    print("TEST COMPLETATO")


if __name__ == "__main__":
    main()
