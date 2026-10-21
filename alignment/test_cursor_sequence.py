"""La sequenza REALE dei 128 passi, con la funzione che va in produzione.

Il test precedente verificava che il cursore trovasse la voce con le note giuste.
In un browser vero quella ricerca non combacia mai: OSMD riporta le note 36
semitoni (tre ottave) sotto il piano, in modo uniforme su tutto il brano, per
via di una direzione `<octave-shift type="down" size="8">` sul rigo di violino.
Il passo 0 chiede [46, 93] e la voce corrispondente dice [10, 57].

Quello che invece e' misurato e' la POSIZIONE: la fermata k del cursore e' il
passo k del piano, 128 volte su 128, e la battuta coincide 128 volte su 128.
Quindi la funzione conta, e non legge un pitch.

Questo test costruisce le voci dell'iteratore dal piano vero, cosi' il conteggio
e' provato sulla sequenza reale e non su una lista inventata.

Uso: python alignment/test_cursor_sequence.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(ROOT)
sys.path.insert(0, ROOT)

from join import ScoreModel            # noqa: E402
from practice import PracticePlan      # noqa: E402

SCORE = os.path.join(
    REPO, "The Legend of Zelda_ Great Fairy Fountain (Piano Cover).musicxml")


class FakeCursor:
    """Il cursore di OSMD, ridotto alle mosse che usiamo.

    Le voci sono (misura, [midi]): una voce per ATTACCO dello spartito, con le
    sue note. E' la struttura che vede l'iteratore vero, che avanza di voce in
    voce.

    I MIDI qui NON sono confrontati con nessuno: e' il punto della nuova
    implementazione. Per rendere il test onesto, e' volutamente lo stesso
    insieme di note del piano ma traslato di 36 semitoni, come fa OSMD col
    rigo di violino: se la funzione dipendesse dal pitch, questo test
    fallirebbe.
    """

    def __init__(self, entries):
        self.entries = entries
        self.pos = 0
        self.hidden = True
        self.resets = 0
        self.shown = 0

    @property
    def Iterator(self):
        outer = self

        class It:
            @property
            def EndReached(self):
                return outer.pos >= len(outer.entries)

            @property
            def CurrentMeasure(self):
                if outer.pos >= len(outer.entries):
                    return None
                return type('M', (), {'MeasureNumber': outer.entries[outer.pos][0]})()

        return It()

    def next(self):
        if self.pos < len(self.entries) - 1:
            self.pos += 1

    def reset(self):
        self.pos = 0
        self.resets += 1

    def show(self):
        self.hidden = False
        self.shown += 1

    def hide(self):
        self.hidden = True


# --- la funzione sotto test, ricopiata da ScorePage.tsx -------------------

def moveCursorToStep(osmd, stepIndex, fromStep):
    cursor = osmd.cursors[0] if osmd and osmd.cursors else None
    if not cursor:
        return -1
    try:
        pos = fromStep
        if pos < 0 or pos > stepIndex:
            cursor.reset()
            pos = 0
        cursor.show()
        for _guard in range(6000):
            if pos >= stepIndex:
                break
            if cursor.Iterator.EndReached:
                break
            cursor.next()
            pos += 1
        cursor.show()
        return pos
    except Exception:                   # noqa: BLE001
        try:
            cursor.hide()
        except Exception:               # noqa: BLE001
            pass
        return -1


model = ScoreModel.from_musicxml(SCORE)
plan = PracticePlan(model)

# Lo spartito come lo vede l'iteratore: una voce per attacco, in ordine.
# Le note sono traslate di 36 semitoni, come fa OSMD: il test non deve
# dipendere dal pitch.
attacchi = sorted({n["onset"] for n in model.notes})
voci = []
for onset in attacchi:
    pitches = sorted({n["pitch"] for n in model.notes if n["onset"] == onset})
    voci.append((model.measure_at(onset), [p - 36 for p in pitches]))

print("brano: %d passi, %d voci, %d misure distinte"
      % (len(plan), len(voci), len({v[0] for v in voci})))

cursor = FakeCursor(voci)
osmd = type('O', (), {'cursors': [cursor]})()

posizione = -1
trovati = 0
non_trovati = []
indietro = 0
spostamenti = 0
battute_giuste = 0
pos_prec = None

for i, step in enumerate(plan.steps):
    target = step["measure"]             # la misura come la manda l'API
    nuova = moveCursorToStep(osmd, i, posizione)
    if nuova < 0:
        non_trovati.append((i, target))
        continue
    trovati += 1
    posizione = nuova
    if cursor.entries[cursor.pos][0] == target:
        battute_giuste += 1
    if pos_prec is not None and cursor.pos < pos_prec:
        indietro += 1
    if cursor.pos != pos_prec:
        spostamenti += 1
    pos_prec = cursor.pos

print("\npassi posizionati: %d/%d" % (trovati, len(plan)))
print("  passi che non hanno trovato la voce: %d %s"
      % (len(non_trovati), non_trovati[:4]))
print("  battuta corretta: %d/%d" % (battute_giuste, len(plan)))
print("  reset totali (all'avvio): %d" % cursor.resets)
print("  volte in cui il cursore si e' SPOSTATO: %d/%d" % (spostamenti, len(plan)))
print("  cammini all'indietro (sarebbero scatti a schermo): %d" % indietro)

print("\n" + "=" * 58)
# Il cursore si deve spostare a ogni passo: e' il punto della modalita'. Il
# confronto con 16 (il vecchio posizionamento per misura) e' la prova che il
# cambiamento serve.
ok = (trovati == len(plan) and indietro == 0 and cursor.resets <= 1
      and spostamenti >= len(plan) - 5 and battute_giuste == len(plan))
print("sequenza reale: %s" % ("TUTTI I PASSI TROVATI, cursore mobile" if ok
                              else "PROBLEMA"))
print("  (con il posizionamento per sola misura si muoveva 16 volte: %s)"
      % ("regressione!" if spostamenti <= 20 else "ora molto meglio"))
print("=" * 58)
raise SystemExit(0 if ok else 1)
