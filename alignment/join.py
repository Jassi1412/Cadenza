"""JOIN: unisce cio' che ha suonato il pianista e cio' che chiede lo spartito.

RML legge un solo flusso di eventi e non ha un operatore di join, quindi questa
traduzione va fatta in Python prima. Il risultato e' una traccia in cui ogni
nota suonata porta dentro di se' cosa ci si aspettava di sentire in quel punto.

Il JOIN NON calcola il verdetto: rende visibile nello stream le aspettative,
cosi' che RML possa scrivere regole sugli andamenti (quello che sa fare).
"""

import bisect
import json

import numpy as np
import partitura as pt

# dinamica MusicXML -> velocity MIDI (stessa mappa di add_dynamics.py)
#
# I valori sono a meta' intero di proposito. La regola dynamics-adherence accetta
# una nota quando la sua velocity sta entro 8 dal valore qui: con due centri
# consecutivi distanti 16, la fascia finisce dove la successiva comincia, e
# siccome le velocity sono intere quel bordo non e' raggiungibile. Le 8 fasce
# diventano cosi' una partizione esatta delle 128 velocity, senza buchi e senza
# valori in due fasce. Con centri interi il bordo sarebbe raggiungibile e due
# velocity vicine non sapremmo a quale dinamica appartengono.
#
# La tabella e' scritta a mano anche in add_dynamics.py: se cambi un numero,
# cambialo in entrambi i file.
DYN_VELOCITY = {
    "ppp": 7.5, "pp": 23.5, "p": 39.5, "mp": 55.5, "mf": 71.5,
    "f": 87.5, "ff": 103.5, "fff": 119.5,
}

# Tolleranza del gesto del piede, in battute. E' lo STESSO numero che verifica
# pedal-toggle.pl (`abs(B - S) =< 0.25`): se qui lo span venisse agganciato solo
# entro 0,05 come per le note, la finestra larga della specifica sarebbe codice
# morto e un pedale umano, che non arriva sul millisecondo, verrebbe sempre
# giudicato sbagliato. Meta' battuta a 120 = 250 ms: abbastanza largo per il
# piede, ancora abbastanza corto per accorgersi di un pedale premuto in ritardo
# di una battuta intera. Se cambi questo numero, cambia anche li'.
PEDAL_BEAT_TOL = 0.25


def _beat_of(part, t):
    """Conversioni in divisioni -> battuta, seguendo la misura in vigore.

    Il modo semplice sarebbe moltiplicare per un gradiente unico, misurato
    all'inizio dello spartito. Funziona finche' la misura non cambia mai. Ma se
    lo spartito passa da 3/4 a 6/8, il numero di battute per divisione e'
    diverso prima e dopo, e il gradiente unico sbaglia su tutto quello che viene
    dopo il cambio.

    Quanto sbaglia? Sul brano di prova, che ha undici cambi di misura, l'ultima
    nota e' alla battuta 766 e il calcolo con il gradiente unico la mette alla
    709: 57 battute fuori, cioe' l'ultimo settimo del brano. Non e' un errore che
    si vede, perche' il valore e' ben formato, e' semplicemente un altro brano.

    Per questo qui si chiede la conversione a partitura, che segue la misura
    battuta per battuta. La sua mappa finisce con il brano: fuori da li' non sa
    rispondere e restituisce nan, quindi il risultato va controllato.
    """
    b = float(part.beat_map(t))
    return b if np.isfinite(b) else None


class ScoreModel:
    """Cosa lo spartito si aspetta, in ogni istante della sua durata.

    Tutte le posizioni sono espresse in BATTUTE (beat). La conversione
    battuta <-> millisecondi e' costruita qui, dagli angoli del tempo scritto
    nello spartito: senza di essa non c'e' modo di dire quando una nota doveva
    suonare, perche' il MusicXML non contiene istanti assoluti.
    """

    def __init__(self, notes, dynamics, pedals, beat_grad, time_anchors):
        self.notes = notes            # lista di dict
        self.dynamics = dynamics      # lista di dict: start, end, text, velocity
        self.pedals = pedals          # lista di dict: start, end
        self.beat_grad = beat_grad    # beat per divisione

        # angoli (beat, ms al tempo scritto). Sono i punti in cui il tempo
        # cambia: in mezzo a un tratto la relazione e' lineare, quindi due
        # angoli bastano a definire tutto il brano.
        self._anch_beats = np.array([a[0] for a in time_anchors], dtype=float)
        self._anch_ms = np.array([a[1] for a in time_anchors], dtype=float)

        # indici per la ricerca: gli span sono disgiunti e ordinati
        self._dyn_starts = [d["start"] for d in self.dynamics]
        self._dyn_ends = [d["end"] for d in self.dynamics]
        self._ped_starts = [p["start"] for p in self.pedals]

        # gli attacchi dello spartito, per risalire dalla battuta al gruppo
        self._onsets = sorted({n["onset"] for n in notes})
        # i pitch che lo spartito chiede di premere insieme in ciascun istante:
        # serve a nominare QUALI note formano l'accordo, non quante sono
        self._group_pitches = {}
        for n in notes:
            # lista, non set: due voci che suonano la stessa nota sono due
            # note distinte da premere, e un set le fonderebbe in una
            self._group_pitches.setdefault(n["chordId"], []).append(n["pitch"])

        # il cartiglio di ogni attacco. Sullo stesso attacco piu' note hanno lo
        # stesso simbolo, perche' la propagazione sugli accordi e' gia' stata fatta:
        # qui basta prendere il primo valore buono che passa.
        self._art = {}
        for n in notes:
            if n["articulation"] and n["onset"] not in self._art:
                self._art[n["onset"]] = n["articulation"]

    def articulation_at(self, beat):
        """Il cartiglio che lo spartito mette su questa battuta, se lo mette.

        Cerca come `chord_at`: non confronta la battuta con l'attacco per
        uguaglianza esatta, ma risale all'attacco piu' vicino con lo stesso
        criterio. Serve perche' la battuta arriva arrotondata e non coincide mai
        al millisecondo con l'attacco scritto, e senza questo la regola leggeva
        il cartiglio solo in 11 casi su 199.
        """
        if not self._onsets:
            return None
        i = bisect.bisect_right(self._onsets, beat) - 1
        if i < 0:
            return None
        return self._art.get(self._onsets[i])

    # ---------------------------------------------------------------- lettura

    @classmethod
    def from_musicxml(cls, path):
        score = pt.load_score(path)
        part = score[0]

        # partitura lavora in "t" (divisions). La nostra unita' e' la "beat" di
        # note_array, che in 2/2 NON coincide con la quartina: nel file di prova
        # la nota 31.75 in beat sta a 63.5 in quarter. Misuro il gradiente invece
        # di indovinarlo dal time signature.
        beat_grad = float(part.beat_map(1.0)) - float(part.beat_map(0.0))
        assert beat_grad > 0, "conversione t -> beat non riuscita"

        # note
        na = part.note_array()
        by_id = {str(r["id"]): r for r in na}
        notes = []
        for n in part.notes:
            r = by_id.get(str(n.id))
            if r is None:
                continue
            # il cartiglio di staccato o tenuto e' gia' sulla nota: partitura lo
            # legge, e lo mette qui. Non e' nella tabella delle note, dove non
            # c'e' una colonna per le articolazioni, quindi va preso dagli
            # oggetti nota e non dalle righe.
            nota = {
                "id": str(n.id),
                "pitch": int(r["pitch"]),
                "onset": float(r["onset_beat"]),
                "duration": float(r["duration_beat"]),
                "voice": int(r["voice"]) if "voice" in r.dtype.names else 0,
                "articulation": str(n.articulations[0]) if n.articulations else None,
            }
            notes.append(nota)
        notes.sort(key=lambda x: (x["onset"], x["pitch"]))
        cls._propagate_articulations(notes)

        # legature: anche la <slur> sta nel file, non nelle colonne di partitura.
        # Una nota dentro una legatura deve IL suo suono fino all'attacco dopo:
        # lo spartito lo chiede, e il cartiglio atteso diventa "legato".
        for span in cls._read_slurs(path, part):
            for n in notes:
                if (span["start"] - 0.02 <= n["onset"] < span["end"] - 0.02
                        and n["articulation"] in (None, "tenuto")):
                    n["articulation"] = "legato"

        # Mani: la <voice> e' cio' che separa le due mani, il <staff> dice quale
        # rigo porta. partitura ha la voce per ogni riga della sua tabella, quindi
        # la mappa voice -> rigo (sotto) si applica qui e il campo "staff" resta
        # sulla nota: e' quello che legge practice.py per escludere una mano.
        hands = cls._read_hands(path)
        for n in notes:
            n["staff"] = hands.get(str(n["voice"]))

        # Gruppi di note simultanee NELLO SPARTITO: due note con lo stesso
        # attacco sono premute nello stesso istante, quindi vanno insieme.
        # L'id deriva dal solo spartito, mai dall'esecuzione: se lo ricavassi da
        # quando sono suonate le note, la regola "le note dell'accordo devono
        # arrivare insieme" risulterebbe vera per costruzione.
        onsets = sorted({n["onset"] for n in notes})
        onset_id = {o: i for i, o in enumerate(onsets)}
        group_pitches = {}
        for n in notes:
            n["chordId"] = onset_id[n["onset"]]
            # lista, non set: due voci sulla stessa nota sono due note distinte
            group_pitches.setdefault(n["chordId"], []).append(n["pitch"])
        for n in notes:
            mates = list(group_pitches[n["chordId"]])
            mates.remove(n["pitch"])
            n["chordMates"] = sorted(mates)

        # dinamiche: partitura le da' in t, le convertiamo in beat
        dynamics = []
        for d in part.dynamics:
            # Una direzione senza posizione non occupa nessun istante, quindi
            # non puo' essere "la dinamica che copre questa nota": non c'e' da
            # che momento iniziare ne' quando finisce. Succede con le indicazioni
            # espressive come un diminuendo o un sforzando, che non sono un punto
            # ma una tendenza. Prima di accorgersene il programma andava in
            # crash su qualsiasi spartito che ne contenesse una, il che' vuol
            # dire che reggeva solo gli spartiti con dinamiche tutte puntuali.
            if d.start is None or d.end is None:
                continue
            # stessa conversione degli angoli del tempo: la misura puo' cambiare
            # e il gradiente unico sbaglia, vedi _beat_of
            inizio, fine = _beat_of(part, d.start.t), _beat_of(part, d.end.t)
            if inizio is None or fine is None:
                continue
            dynamics.append({
                "start": inizio,
                "end": fine,
                "text": d.text,
                "velocity": DYN_VELOCITY.get(d.text, 80),
            })
        dynamics.sort(key=lambda x: x["start"])

        # pedali: partitura non li espone, li leggiamo dall'XML
        pedals = cls._read_pedals(path, part)

        # articolazioni (staccato, tenuto, legatura): lette dal file e gia' abbinate
        # nota per nota qui sopra

        # aggancia a ogni nota la dinamica che la copre
        for n in notes:
            e = cls._expected_at(dynamics, pedals, n["onset"])
            n["expected_dyn"] = e["dyn"]
            n["expected_pedal"] = e["pedal"]

        time_anchors = cls._build_time_anchors(part, path, beat_grad)

        return cls(notes, dynamics, pedals, beat_grad, time_anchors)

    @staticmethod
    def _read_tempos(path):
        """<sound tempo='X'> -> [(posizione in divisioni, bpm)].

        Stessa tecnica di _read_pedals: il tempo sta dentro <direction>, quindi
        per sapere *dove* cade devo camminare i figli della misura contando le
        durate. <backup> riporta indietro il cursore per la seconda voce.

        Il primo <sound tempo> e' il tempo di apertura: e' quello che l'utente
        vede sullo slider e quello che divide il tempo reale da quello scritto.
        """
        from lxml import etree

        root = etree.parse(path).getroot()
        out, offset = [], 0.0
        for m in root.findall(".//measure"):
            cursor = 0.0
            for child in m:
                if child.tag == "note":
                    if child.find("chord") is None:
                        d = child.findtext("duration")
                        if d:
                            cursor += float(d)
                elif child.tag == "backup":
                    d = child.findtext("duration")
                    if d:
                        cursor -= float(d)
                elif child.tag == "direction":
                    s = child.find("sound")
                    if s is not None and s.get("tempo"):
                        out.append((offset + cursor, float(s.get("tempo"))))
            offset += cursor
        return out

    @classmethod
    def _build_time_anchors(cls, part, path, beat_grad):
        """(beat, ms) agli angoli del tempo scritto.

        Il MusicXML non ha orari assoluti: ha battute e un tempo. Il tempo e' un
        numero di quartini al minuto, partitura da' quante divisioni vale una
        quartina, e con i due si ottiene la durata in ms di ogni tratto. Il
        risultato e' una spezzata: diritta dentro un tratto a tempo costante,
        spezzata dove il tempo cambia. Un brano con un solo tempo e' una retta.

        Il risultato e' al tempo SCRITTO. Per confrontarlo con l'esecuzione,
        che segue il tempo scelto dall'utente, serve il fattore che arriva
        dalla pagina: vedi `to_score_ms`.
        """
        tempos = cls._read_tempos(path)
        if not tempos:
            tempos = [(0.0, 120.0)]

        # partitura: colonne (t, divisioni-per-quartina). Se il tempo non e'
        # uniforme torna piu' di una riga, e gli spazi sono da seguire in ordine.
        qd = np.asarray(part.quarter_durations(), dtype=float)
        edges, durs = qd[:, 0].tolist(), qd[:, 1].tolist()

        def quarter_dur_at(t):
            q = durs[0]
            for c, d in zip(edges, durs):
                if c <= t:
                    q = d
                else:
                    break
            return q

        def bpm_at(t):
            cur = tempos[0][1]
            for tt, bb in tempos:
                if tt <= t:
                    cur = bb
                else:
                    break
            return cur

        def ms_between(t0, t1):
            """ms per andare da t0 a t1, seguendo i cambi di durata della quartina."""
            cuts = [t0] + [c for c in edges if t0 < c < t1] + [t1]
            total = 0.0
            for i in range(len(cuts) - 1):
                a, b = cuts[i], cuts[i + 1]
                if b <= a:
                    continue
                mid = (a + b) / 2.0
                total += (b - a) / quarter_dur_at(mid) * (60000.0 / bpm_at(mid))
            return total

        anchors = [(0.0, 0.0)]
        ms = 0.0
        prev = 0.0
        for t, _bpm in tempos:
            if t <= 0.0:
                continue
            ms += ms_between(prev, t)
            battuta = _beat_of(part, t)
            if battuta is not None:
                anchors.append((battuta, ms))
            prev = t

        # quarter_durations puo' non arrivare al fondo del brano: mi fermo dove
        # finisce l'ultima nota, altrimenti l'ultimo tratto non avrebbe tempo.
        end_t = max(float(n.start.t) + float(n.duration) for n in part.notes)
        ms += ms_between(prev, end_t)
        end_beat = _beat_of(part, end_t)
        # senza questo l'ultimo angolo finirebbe prima dell'ultima nota e tutto
        # quello che viene dopo verrebbe schiacciato sull'ultimo millisecondo
        # conosciuto: 55 attacchi di fila con lo stesso istante, verificato.
        if end_beat is not None:
            anchors.append((end_beat, ms))
        return anchors

    def beat_at(self, score_ms):
        """ms al tempo scritto -> battata."""
        return float(np.interp(score_ms, self._anch_ms, self._anch_beats))

    def ms_at(self, beat):
        """battuta -> ms al tempo scritto."""
        return float(np.interp(beat, self._anch_beats, self._anch_ms))

    @staticmethod
    def _propagate_articulations(notes):
        """Un cartiglio su una nota sola dell'accordo vale per tutto l'accordo.

        Su un accordo le note si suonano insieme: se il cartiglio sta su una delle
        note dell'attacco, l'accordino e' staccato o tenuto, non una nota dentro.
        Nello spartito di prova accade in 46 attacchi su 74: il simbolo e' scritto
        una volta sola e vale per tutte le note che partono insieme.

        Se invece le note dello stesso attacco portano simboli diversi non si
        propaga niente, perche' significherebbe inventare una marcatura che il
        file non ha. In quel caso ogni nota resta con quello che porta.

        Va detto che cosa pero': non e' che tutte le note dell'attacco siano per
        forza dello stesso simbolo, e' che se c'e' un solo simbolo fra le note di
        quell'attacco e' quello che vale per l'attacco.
        """
        per_attacco = {}
        for n in notes:
            per_attacco.setdefault(n["onset"], []).append(n)
        for gruppo in per_attacco.values():
            presenti = {n["articulation"] for n in gruppo if n["articulation"]}
            if len(presenti) == 1:
                simbolo = presenti.pop()
                for n in gruppo:
                    if n["articulation"] is None:
                        n["articulation"] = simbolo

    @staticmethod
    def _read_pedals(path, part):
        """<pedal type='start'|'stop'> -> span in beat.

        In MusicXML il pedale sta dentro <direction><direction-type><pedal/>, quindi
        non e' un figlio diretto di <measure>: per sapere *quando* accade devo
        camminare i figli della misura in ordine, contando le durate delle note
        gia' incontrate. Le note con <chord/> non fanno avanzare l'orologio.

        <backup> e' il pezzo che non si vede ma conta: questo spartito ha due
        voci, e la seconda riparte indietro con un <backup><duration>. Senza
        gestirlo il cursore non torna mai indietro e arriva a fine brano al
        doppio: gli ultimi span di pedale finivano a battuta 64 su uno spartito
        che ne ha 32, e la metà delle pressioni cadeva fuori dal brano.

        Il cursore e' in divisioni e la conversione in battuta la fa _beat_of,
        perche' la misura puo' cambiare: moltiplicare per un gradiente unico
        metteva le pressioni fuori posto dal primo cambio in poi.
        """
        from lxml import etree

        tree = etree.parse(path)
        root = tree.getroot()

        pedals, offset, open_at = [], 0.0, None
        for m in root.findall(".//measure"):
            cursor = 0.0
            for child in m:
                if child.tag == "note":
                    if child.find("chord") is None:
                        d = child.findtext("duration")
                        if d:
                            cursor += float(d)
                elif child.tag == "backup":
                    d = child.findtext("duration")
                    if d:
                        cursor -= float(d)
                elif child.tag == "direction":
                    for p in child.findall(".//pedal"):
                        at = _beat_of(part, offset + cursor)
                        if at is None:
                            continue
                        if p.get("type") == "start":
                            open_at = at
                        elif p.get("type") == "stop" and open_at is not None:
                            pedals.append({"start": open_at, "end": at})
                            open_at = None
            offset += cursor
        if open_at is not None:
            pedals.append({"start": open_at, "end": float("inf")})
        pedals.sort(key=lambda x: x["start"])

        # Gli span NON vanno uniti. Qui c'era un'unione degli span contigui:
        # sullo spartito di prova ogni battuta apre e chiude il suo <pedal>,
        # sedici coppie una di fila all'altra, e l'unione le schiacciava in uno
        # span unico 0..32. Cosi' la metrica non poteva piu' distinguere le
        # sedici comparse: chiedeva una pressione sola dove la partitura ne
        # chiede sedici. Ora ogni coppia <pedal type='start'/> ...
        # <pedal type='stop'/> resta uno span a se', e la metrica puo' chiedere
        # una pressione all'apertura e un rilascio alla chiusura di ciascuna.
        return pedals

    @staticmethod
    def _read_slurs(path, part):
        """<slur type='start'> ... <slur type='stop'> -> span in beat.

        La legatura non sta in una colonna di partitura: vive nei <notations>
        delle note. Si cammina la misura come per i pedali: l'apertura prende
        l'attacco della nota che la porta, la chiusura l'estensione di quella
        nota (la legatura arriva fino a li', e la nota dopo e' un nuovo attacco
        dal quale il suono deve arrivare senza buco).
        """
        from lxml import etree

        tree = etree.parse(path)
        root = tree.getroot()

        spans, offset, open_at = [], 0.0, {}
        for m in root.findall(".//measure"):
            cursor = 0.0
            for child in m:
                if child.tag == "note":
                    is_chord = child.find("chord") is not None
                    at_onset = _beat_of(part, offset + cursor)
                    d = child.findtext("duration")
                    after = cursor + (float(d) if d and not is_chord else 0.0)
                    for s in child.findall("notations/slur"):
                        num = s.get("number", "1")
                        if at_onset is None:
                            continue
                        if s.get("type") == "start":
                            open_at[num] = at_onset
                        elif s.get("type") == "stop" and num in open_at:
                            end_at = _beat_of(part, offset + after)
                            if end_at is not None and end_at > open_at[num]:
                                spans.append({"start": open_at.pop(num), "end": end_at})
                    cursor = after
                elif child.tag == "backup":
                    d = child.findtext("duration")
                    if d:
                        cursor -= float(d)
            offset += cursor
        for num, at in open_at.items():
            spans.append({"start": at, "end": float("inf")})
        spans.sort(key=lambda x: x["start"])
        return spans

    @staticmethod
    def _read_hands(path):
        """voice -> numero di rigo dichiarato dal file (1 = sopra, 2 = sotto).

        PERCHE' PER VOCE e non per la singola <staff>. Il <staff> dice su quale
        rigo la nota e' SCRITTA; nella scrittura pianistica la mano che valica il
        rigo (cross-staff) cambia rigo restando della stessa mano, mentre le due
        mani sono separate dalla <voice>: e' quello che usano gli editor, ed e' la
        cosa piu' vicina alla mano fisica. Si prende il rigo DOMINANTE di ogni
        voce, cosi' una voce che per un momento finisce sull'altro rigo non
        cambia mano.

        Ritorna {} quando il file non permette di separare le mani: niente
        <staff> (pezzo a un rigo solo) oppure niente <voice> (le note sono tutte
        in una voce, e allora non c'e' nessuna chiave per dire quale meta' del
        brano sia la destra). In quel caso l'app tiene il filtro mano spento e
        dichiarato, invece di indovinare.
        """
        from collections import Counter
        from lxml import etree

        tree = etree.parse(path)
        root = tree.getroot()

        per_voice = {}
        for note in root.iter("note"):
            v = note.findtext("voice")
            st = note.findtext("staff")
            if v is None or st is None:
                continue
            try:
                staff_n = int(st)
            except ValueError:
                continue
            per_voice.setdefault(str(v).strip(), Counter())[staff_n] += 1

        # il rigo piu' frequente per ogni voce: e' la sua mano
        return {v: cnt.most_common(1)[0][0] for v, cnt in per_voice.items()}

    # ------------------------------------------------------------- le query

    @staticmethod
    def _expected_at(dynamics, pedals, beat):
        dyn = None
        for d in dynamics:
            if d["start"] <= beat < d["end"]:
                dyn = d
                break
        pedal = any(p["start"] <= beat < p["end"] for p in pedals)
        span = next((p for p in pedals if p["start"] <= beat < p["end"]), None)
        return {
            "dyn": dyn["velocity"] if dyn else None,
            "dyn_text": dyn["text"] if dyn else None,
            "pedal": pedal,
            "span": span,
        }

    def expected_at(self, beat):
        return self._expected_at(self.dynamics, self.pedals, beat)

    def span_starting_at(self, beat, eps=0.05):
        """Lo span di pedale che APRE in questa battuta, se c'e'.

        Tolleranza e non uguaglianza: l'ultima battuta del brano non ha un
        attacco su cui snap_beat possa agganciarsi, e il rilascio finale
        arriverebbe come 31,9983 senza trovare lo span che chiude a 32.
        eps di default e' la meta' sedicesima di snap_beat, ma per il pedale
        si passa esplicitamente PEDAL_BEAT_TOL: il piede non arriva sul
        millisecondo, e la soglia vera e' quella della specifica.
        """
        return next((p for p in self.pedals if abs(p["start"] - beat) <= eps), None)

    def span_ending_at(self, beat, eps=0.05):
        """Lo span di pedale che CHIUDE in questa battuta, se c'e'."""
        return next((p for p in self.pedals if abs(p["end"] - beat) <= eps), None)

    def measure_at(self, beat):
        """Numero di misura 1-indexato, dalle battute e dal tempo."""
        return int(beat // 2) + 1  # 2/2: due battute per misura

    def for_hand(self, hand):
        """Lo stesso spartito, con una sola mano giudicabile.

        NON si rinumerano le posizioni. `_onsets`, `_anch_beats` e `_anch_ms`
        restano quelli del brano completo perche' l'indice d'attacco (`chordId`)
        e' il numero con cui la pagina cammina il cursore sullo spartito intero:
        rinumerare qui vorrebbe dire colorare la nota sbagliata in ogni brano con
        due righi. Cambia solo cio' che si ASPETTA: le note dell'altra mano escono
        da `notes` (quindi da `score_pitches_at` e da `chord_mates`), e un istante
        in cui la mano scelta non suona resta un attacco con la lista vuota, che
        la copertura salta invece di dichiararlo "never played".

        Le note senza rigo riconosciuto restano: e' la stessa regola del piano di
        pratica — escludere una nota senza certezza vorrebbe dire chiedere
        all'allievo un tasto che nessuno sa a chi appartiene.
        """
        wanted = {"right": 1, "left": 2}.get(hand)
        if wanted is None:
            return self
        kept = [n for n in self.notes if n.get("staff") in (wanted, None)]
        view = ScoreModel.__new__(ScoreModel)
        view.__dict__ = dict(self.__dict__)
        view.notes = kept
        view._group_pitches = {}
        for n in kept:
            view._group_pitches.setdefault(n["chordId"], []).append(n["pitch"])
        return view

    def attacks(self):
        """Gli attacchi dello spartito, in ordine cronologico.

        Restituisce [(battitura, [pitch attesi su quell'attacco]), ...], indice =
        chordId. Lo chiede server.py per la copertura dopo il join: una riga di
        traccia nasce solo da un tasto PREMUTO, quindi l'attacco che nessuno ha
        premuto non esiste nella traccia e nessuna regola RML puo' puntarlo —
        l'unica fonte della sua esistenza e' lo spartito stesso. Stesso ordine,
        stesso indice di `chord_at`: niente elenco parallelo che puo' divergere.
        """
        return [(o, list(self._group_pitches.get(i, [])))
                for i, o in enumerate(self._onsets)]

    def score_pitches_at(self, beat, tol=0.25):
        """Quali note dello spartito dovrebbero suonare in questa battuta.

        Non guardo solo gli attacchi: una nota lunga che e' iniziata prima
        e' ancora attiva, e se l'allineamento ha qualche decina di ms di
        scarto e' l'attacco a essere disallineato, non la sua fine.
        """
        return [n["pitch"] for n in self.notes
                if n["onset"] - tol <= beat < n["onset"] + n["duration"]]

    def chord_at(self, beat):
        """Il gruppo di note simultanee dello spartito che copre questa battuta.

        Serve a chord-jitter: due note con lo stesso chordId sono, secondo lo
        spartito, un accordo e quindi devono arrivare insieme.

        La battuta arriva gia' arrotondata sugli attacchi da `snap_beat`, quindi
        qui il confronto e' pulito.
        """
        if not self._onsets:
            return None
        i = bisect.bisect_right(self._onsets, beat) - 1
        return i if i >= 0 else None

    def snap_beat(self, beat, eps=0.05):
        """Riporta la battuta sull'attacco dello spartito piu' vicino.

        Tutto quello che lo spartito dice di un istante e' una funzione a
        gradino: quale dinamica copre la battuta, quale accordo e' stato
        premuto, se il pedale e' giusto. Se la battuta arriva dalla
        interpolazione sbagliata di 0,0001, cade dalla parte sbagliata di una
        frontiera e la traccia descrive un punto che non e' quello suonato: la
        dinamica di mezzo battuta prima, l'accordo precedente.

        eps e' meta' di una sedicesima (0,0625 in 2/2): abbastanza grande da
        assorbire l'errore di interpolazione, abbastanza piccola da non
        agganciare l'attacco successivo.
        """
        if not self._onsets:
            return beat
        i = bisect.bisect_left(self._onsets, beat)
        best, best_d = None, None
        for k in (i - 1, i, i + 1):
            if 0 <= k < len(self._onsets):
                d = abs(self._onsets[k] - beat)
                if best_d is None or d < best_d:
                    best, best_d = self._onsets[k], d
        return best if best_d is not None and best_d <= eps else beat

    def chord_mates(self, beat, pitch):
        """Gli ALTRI pitch che lo spartito chiede di premere nello stesso istante.

        Vuoto se il gruppo non contiene che questa nota: e' il caso in cui la
        nota non ha compagni e puo' arrivare quando le pare.

        Non si conta quante note ha il gruppo, si nomina chi ci sta dentro.
        E' la differenza che rende la regola generalizzabile: un accordo a 3
        note e uno a 2 si comportano allo stesso modo, senza casi speciali.
        """
        cid = self.chord_at(beat)
        if cid is None:
            return []
        mates = list(self._group_pitches.get(cid, ()))
        # si toglie UNA sola occorrenza: se due voci suonano la stessa nota,
        # l'altra resta compagna e va comunque premuta
        if pitch in mates:
            mates.remove(pitch)
        return sorted(mates)

    def nearest(self, pitches, pitch):
        """(pitch atteso piu' vicino, distanza in semitoni).

        Serve perche' il monitor RML confronta i campi con deep_subdict/2, che
        sulle liste lavora elemento per elemento a lunghezza uguale: non puo'
        esprimere "numero appartiene a questa lista". La distanza si puo' pero':
        e' un numero, e RML la confronta con un semplice `with`.
        """
        if not pitches:
            return None, None
        best = min(pitches, key=lambda q: (abs(q - pitch), q - pitch))
        return best, abs(pitch - best)


# --------------------------------------------------------------- il JOIN


def join(model, performed_notes, tempo_factor=1.0, control_changes=None):
    """Restituisce la traccia annotata, evento per evento.

    performed_notes  : lista di dict {time_ms, dur_ms, pitch, velocity}
    tempo_factor     : quanti millisecondi reali vale un millisecondo scritto
                       nello spartito. Vale 1 quando l'esecuzione segue il tempo
                       dello spartito, 2 quando suona a meta' velocita', 0.5 a
                       velocita' doppia. Lo calcola la pagina, che e' il posto
                       dove l'utente sceglie il tempo.
    control_changes  : lista di dict {time_ms, controller, value}. Opzionale:
                       se manca non viene emesso alcun controlchange.

    Vengono emessi tre tipi di evento, perche' le metriche RML hanno bisogno
    di tutti e tre: noteon per l'attacco, noteoff per il rilascio e controlchange
    per il pedale. Il rilascio porta con se' la stessa annotazione dello spartito,
    cosi' una regola che cerca un rilascio trova anche le aspettative; la DURATA
    invece sta sull'attacco, perche' e' li' che una regola deve poterla leggere
    senza dover abbinare attacchi e rilasci (vedi `durMs` piu' sotto).
    """
    if tempo_factor is None or not np.isfinite(tempo_factor) or tempo_factor <= 0:
        tempo_factor = 1.0

    # Gli istanti in cui il pianista preme un tasto, senza ripetizioni: e' la
    # griglia degli attacchi. Serve a misurare quanto tempo c'e' fra un attacco e
    # il successivo, che e' la reference dell'articolazione.
    #
    # Perche' gli attacchi e non le note: le note di un accordo partono insieme e
    # hanno lo stesso istante, quindi se si prendessero le note il distacco fra
    # due note di un accordo sarebbe zero e il confronto non avrebbe senso. Le
    # note di un accordo devono avere lo stesso gap, perche' l'articolazione
    # scritta vale per l'accordino intero.
    attacchi = sorted({float(p["time_ms"]) for p in performed_notes})

    def prossimo_attacco(t):
        """Il primo istante di attacco dopo t, o None se non c'e'."""
        i = bisect.bisect_right(attacchi, t)
        return attacchi[i] if i < len(attacchi) else None

    events = []
    for p in performed_notes:
        t = p["time_ms"]

        # istante dell'esecuzione riportato al tempo scritto nello spartito:
        # e' l'unica scala su cui i due mondi sono confrontabili
        score_t = t / tempo_factor

        # battuta dello spartito in cui e' caduta la nota. Riportata sugli attacchi
        # dello spartito: sotto, tutto quello che lo spartito dice e' a gradino.
        beat = model.snap_beat(model.beat_at(score_t))

        # quando la stessa battuta era prevista: il ritardo. Tornato al tempo
        # reale, cosi' il numero e' confrontabile con l'attacco come e' arrivato.
        expected_ms = model.ms_at(beat) * tempo_factor

        e = model.expected_at(beat)
        expected_pitches = model.score_pitches_at(beat)
        near_pitch, pitch_dist = model.nearest(expected_pitches, p["pitch"])
        chord_id = model.chord_at(beat)
        # i compagni d'accordo si cercano con il pitch che lo spartito si
        # ASPETTA, non con quello suonato: se il pianista ha sbagliato intonazione
        # e' la nota giusta che va cercata fra le altre da premere insieme
        chord_mates = model.chord_mates(beat, near_pitch)

        # il prossimo attacco suonato: serve al gapMs sotto
        prossimo = prossimo_attacco(t)

        expected = {
            # null se lo spartito non porta una dinamica in quel punto:
            # la regola RML deve poter distinguere "suona piano" da
            # "qui non c'e' niente scritto".
            "dyn": e["dyn"],
            "dynExplicit": e["dyn"] is not None,
            "dynText": e["dyn_text"],
            "pedal": e["pedal"],
            # lo span di pedale che copre questa battuta, se lo spartito ne
            # apre uno: le metriche del pedale hanno bisogno di conoscerne gli
            # estremi, non solo il fatto che in quel punto il pedale c'e'
            "spanExplicit": e["span"] is not None,
            "spanStart": e["span"]["start"] if e["span"] else None,
            "spanEnd": e["span"]["end"] if e["span"] else None,
            # la lista completa resta per leggere la traccia a mano;
            # pitch + pitchDist sono la forma che RML puo' confrontare.
            "pitch": near_pitch,
            "pitchDist": pitch_dist,
            "pitches": expected_pitches,
            # gruppo di accordo preso dallo spartito, non dall'esecuzione:
            # l'istante in partitura e CHI sono le altre note da premervi con lui
            "chordId": chord_id,
            "chordMates": chord_mates,
            # il cartiglio che lo spartito mette qui: "staccato", "tenuto",
            # "legato", oppure null se lo spartito non dice niente. E' null
            # nella maggior parte dei punti di uno spartito normale, e la regola
            # deve poter distinguere "qui e' scritto staccato" da "qui non c'e'
            # niente scritto", come fa per la dinamica.
            "art": model.articulation_at(beat),
        }

        # ATTACCO fuori da ogni nota attiva dello spartito (una nota in piu'
        # suonata in un silenzio): pitchDist None farebbe passare via
        # unmatchedNote, quindi il noteon porta un dist positivo grande e
        # viene bocciato da inScore come qualsiasi pitch sbagliato. Il
        # noteoff resta con pitchDist None: nessuna metrica giudica il
        # pitch del rilascio.
        expected_on = ({**expected, "pitchDist": 127} if pitch_dist is None
                       else expected)

        events.append({
            "type": "noteon",
            "note": {"number": p["pitch"], "rawAttack": p["velocity"]},
            "timestamp": t,
            "position": {"beat": round(beat, 4), "measure": model.measure_at(beat)},
            "expected": expected_on,
            "timing": {"deltaMs": round(t - expected_ms, 2)},
            # quanto e' stata tenuta premuta, in millisecondi reali.
            #
            # Sta QUI e non solo sul rilascio perche' una regola che vuole
            # guardare la durata di una nota non deve piu' abbinare l'attacco al
            # suo rilascio: non puo' farlo, perche' un attacco puo' arrivarne
            # un altro identico mentre il primo e' ancora premuto (le due voci
            # suonano spesso insieme), e a quel punto non si sa quale rilascio
            # chiuda quale attacco. Portando la durata con l'attacco, ogni nota
            # e' controllabile da sola e gli accordi non hanno piu' casi speciali.
            "durMs": round(float(p.get("dur_ms") or 0.0), 2),
            # quanto tempo passa da questo attacco al successivo, in millisecondi
            # reali. E' la reference con cui si giudica se una nota e' stata
            # staccata o tenuta: se il tasto e' stato lasciato prima che arrivasse
            # la nota dopo, lo stacco c'e'; se e' stato tenuto fino a li',
            # le due note sono legate.
            #
            # Non dipende dal fattore di velocita' ne' dal tempo scritto nello
            # spartito: e' una differenza fra due istanti dell'esecuzione, quindi
            # vale uguale su un brano lento, su uno veloce e anche dentro un tratto
            # in cui il tempo raddoppia a meta' brano.
            #
            # null sull'ultimo attacco: non c'e' nessuna nota dopo, quindi non c'e'
            # niente da confrontare, e la regola non deve tirare a indovinare.
            "gapMs": (None if prossimo is None else round(prossimo - t, 2)),
        })

        # il rilascio porta con se' gli stessi campi: se la regola vuole
        # confrontare la dinamica di una nota, la cerca sul rilascio anche
        if p.get("dur_ms"):
            events.append({
                "type": "noteoff",
                "note": {"number": p["pitch"]},
                "timestamp": t + p["dur_ms"],
                "position": {"beat": round(beat, 4),
                             "measure": model.measure_at(beat)},
                "expected": expected,
                "timing": {"deltaMs": round(t + p["dur_ms"] - expected_ms, 2)},
            })

    # il pedale: solo quello che l'esecuzione ha davvero premuto, annotato con
    # quello che lo spartito chiedeva in quel punto. Non si inventano eventi.
    #
    # Un pianoforte digitale non manda "giu'/su'": il sustain e' un continuo e
    # la discesa del piede produce una raffica di valori crescenti (8, 41, 96,
    # 127), la salita una decrescente. Le specifiche riconoscono il gesto solo a
    # valori esatti (value:127 per la pressione, value:0 per il rilascio), cosi'
    # come le macchine sintetiche dei test lo emettono. Un pedale vero, che non
    # si fermasse mai esattamente su quei due numeri, non avrebbe mai matchato
    # niente e risulterebbe sempre assente: la traccia allora conserva SOLO gli
    # attraversamenti della soglia 64, riscritti nei due valori canonici. Il
    # tempo resta quello fisico del messaggio che ha attraversato; dei valori
    # intermedi della stessa raffica non c'e' nulla da dire.
    pedal_state = False                      # False: su, True: giu'
    for c in control_changes or []:
        t = c["time_ms"]
        if c["controller"] == 64:
            down = c["value"] >= 64
            if down == pedal_state:
                continue                     # meta' raffica: non e' un gesto
            pedal_state = down
            c = {"time_ms": t, "controller": 64, "value": 127 if down else 0}
        beat = model.snap_beat(model.beat_at(t / tempo_factor))
        e = model.expected_at(beat)
        # lo span di riferimento dipende dal gesto. La pressione sta dove lo
        # span APRE: li' il check "contenuto" darebbe lo span che comincia,
        # che e' quello giusto. Il rilascio sta dove lo span CHIUDE, e li' il
        # check "contenuto" guarderebbe oltre il bordo e prenderebbe lo span
        # successivo (o niente): va chiesto esplicitamente lo span che finisce.
        if c["controller"] == 64 and c["value"] == 127:
            span = model.span_starting_at(beat, PEDAL_BEAT_TOL)
        elif c["controller"] == 64 and c["value"] == 0:
            span = model.span_ending_at(beat, PEDAL_BEAT_TOL)
        else:
            span = e["span"]
        events.append({
            "type": "controlchange",
            "controller": c["controller"],
            "value": c["value"],
            "timestamp": t,
            "position": {"beat": round(beat, 4), "measure": model.measure_at(beat)},
            "expected": {
                "dyn": None,
                "dynExplicit": False,
                "dynText": None,
                "pedal": e["pedal"],
                "spanExplicit": span is not None,
                "spanStart": span["start"] if span else None,
                "spanEnd": span["end"] if span else None,
                "pitch": None,
                "pitchDist": None,
                "pitches": [],
                "chordId": model.chord_at(beat),
                "chordMates": [],
            },
            "timing": {},
        })

    events.sort(key=lambda x: x["timestamp"])
    return events


def to_jsonl(events):
    return "\n".join(json.dumps(e) for e in events)
