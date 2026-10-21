"""Prova `moveCursorToStep` con un OSMD finto, senza browser.

PERCHE' SERVE. La funzione cammina sul cursore vero di OSMD, che nel browser non
si puo' pilotare da uno script. Ma la sua logica — quando si resetta, quando
cammina, quando rinuncia — si puo' provare con un finto cursore che si comporta
come quello vero: `Iterator.EndReached`, `next()`, `reset()`, `show()`, `hide()`.

Il test NON prova OSMD: prova la mia funzione. Se un giorno OSMD cambia API,
questo test resta verde e il browser no — e' il motivo per cui la logica e' qui
e non dentro un componente.

PERCHE' SI CONTA E NON SI CONFRONTANO LE NOTE. La versione precedente cercava la
voce le cui note coincidessero con quelle del passo. In un browser vero non
combacia MAI: OSMD riporta le note 36 semitoni (tre ottave) sotto il piano, in
modo uniforme su tutto il brano, per via di una direzione
`<octave-shift type="down" size="8">` scritta sul rigo di violino. Il passo 0
chiede [46, 93] e la voce corrispondente dice [10, 57]. Scrivere un "-36" nel
codice sarebbe un bug travestito da costante.

Quello che invece torna, misurato sul brano intero, e' la POSIZIONE: la fermata k
del cursore e' il passo k del piano, 128 volte su 128. Quindi si conta, e non si
legge un pitch.

La funzione e' ricopiata da `ScorePage.tsx` perche' quel file importa il player
da 11 MB e non si puo' caricare in node. Se la ricopiatura diverge, il test
mente: e' il limite dichiarato di questa prova. Per la copertura della sequenza
reale dei 128 passi c'e' `test_cursor_sequence.py`, e per la prova sul cursore
VERO c'e' il browser.
"""

esiti = []


def check(label, cond, dettaglio=""):
    esiti.append((label, bool(cond)))
    print("  %s %s%s" % ("OK     " if cond else "FALLITO", label,
                         ("  <- " + dettaglio) if dettaglio and not cond else ""))


class FakeCursor:
    """Un cursore con le stesse mosse di quello vero.

    `entries` e' la sequenza di fermate che l'iteratore attraversa: ogni fermata
    e' una tupla (misura, [numeri MIDI]). I numeri MIDI qui NON servono al
    posizionamento — e' proprio il punto — ma servono a controllare che il
    cursore si fermi sulla fermata giusta.
    """

    def __init__(self, entries, start=0):
        self.entries = entries
        self.pos = start
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
        # OSMD non avanza oltre la fine: `moveToNextVisibleVoiceEntry` e' un
        # `for(;!this.endReached;)`, quindi su una lista finita il cursore si
        # ferma all'ultima fermata. Un finto che avanza sempre mentirebbe su
        # questo punto, che e' proprio quello che il test 6 deve misurare.
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


class FakeOsmd:
    def __init__(self, cursor):
        self.cursors = [cursor] if cursor else None


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


# ---------------------------------------------------------------- i casi
# ogni fermata e' (misura, [numeri MIDI])

UNO_E_UNA = [(1, [60]), (1, [64]), (2, [60]), (2, [67]), (3, [60])]

print("\n1. posizionamento per POSIZIONE: il passo 2 e' la terza fermata")
c = FakeCursor(UNO_E_UNA)
r = moveCursorToStep(FakeOsmd(c), 2, -1)
check("ritorna 2", r == 2, "ritorno=%s" % r)
check("si e' fermato sulla terza fermata", c.pos == 2, "pos=%s" % c.pos)
check("la fermata e' quella giusta", c.entries[c.pos] == (2, [60]),
      "fermata=%s" % (c.entries[c.pos],))
check("visibile", c.hidden is False)

print("\n2. due passi consecutivi si fermano su fermate DIVERSE")
c = FakeCursor(UNO_E_UNA)
moveCursorToStep(FakeOsmd(c), 1, -1)
primo = c.pos
moveCursorToStep(FakeOsmd(c), 2, 1)
secondo = c.pos
check("il primo e' sulla seconda fermata", primo == 1, "pos=%s" % primo)
check("il secondo e' sulla terza fermata", secondo == 2, "pos=%s" % secondo)
check("il cursore si e' mosso davvero", primo != secondo)

print("\n3. i PITCH NON CONTANO: fermate con note diverse, stessa posizione")
# Le note qui sono volutamente sbagliate rispetto a un qualunque piano: se il
# posizionamento dipendesse dal pitch, questo caso non passerebbe.
c = FakeCursor([(1, [10]), (1, [11]), (1, [12]), (2, [13])])
r = moveCursorToStep(FakeOsmd(c), 3, -1)
check("ritorna 3", r == 3, "ritorno=%s" % r)
check("si e' fermato sulla quarta fermata", c.pos == 3, "pos=%s" % c.pos)
check("visibile", c.hidden is False)

print("\n4. avanti senza resettare: nessun salto all'inizio")
# Come in produzione: la prima chiamata parte da -1 (posizione sconosciuta) e fa
# un reset, poi il cammino e' tutto in avanti e non se ne fa piu'.
c = FakeCursor(UNO_E_UNA)
pos = -1
for k in range(4):
    pos = moveCursorToStep(FakeOsmd(c), k, pos)
check("un solo reset, quello iniziale", c.resets == 1, "reset=%s" % c.resets)
# Il passo 3 e' la quarta fermata (indici da 0), e le fermate sono cinque.
check("e' arrivato alla quarta fermata", c.pos == 3, "pos=%s" % c.pos)

print("\n5. andare indietro richiede un reset")
c = FakeCursor(UNO_E_UNA)
moveCursorToStep(FakeOsmd(c), 4, -1)
check("e' in fondo", c.pos == 4, "pos=%s" % c.pos)
r = moveCursorToStep(FakeOsmd(c), 1, 4)
check("tornando indietro riparte dall'inizio", c.resets == 2, "reset=%s" % c.resets)
check("ritorna 1", r == 1, "ritorno=%s" % r)

print("\n6. fine brano: si ferma dove puo', senza crashare")
c = FakeCursor([(1, [60])])
r = moveCursorToStep(FakeOsmd(c), 5, -1)
check("non esplode", isinstance(r, int), "ritorno=%r" % r)
check("resta all'inizio (c'e' una sola fermata)", c.pos == 0, "pos=%s" % c.pos)
check("il cursore e' visibile lo stesso", c.hidden is False)

print("\n7. OSMD senza cursori / null: non esplode")
check("senza cursori -> -1", moveCursorToStep(FakeOsmd(None), 2, -1) == -1)
check("osmd null -> -1", moveCursorToStep(None, 2, -1) == -1)

print("\n8. il percorso e' il minimo: un passo = una fermata")
c = FakeCursor([(1, [60]), (2, [60]), (3, [60]), (4, [60])])
moveCursorToStep(FakeOsmd(c), 3, -1)
check("tre fermate per arrivare al passo 3", c.pos == 3, "pos=%s" % c.pos)

print("\n" + "=" * 58)
falliti = [l for l, ok in esiti if not ok]
print("moveCursorToStep: %d/%d controlli passati"
      % (len(esiti) - len(falliti), len(esiti)))
print("=" * 58)
raise SystemExit(1 if falliti else 0)
