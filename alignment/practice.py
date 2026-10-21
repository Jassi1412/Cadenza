"""Modalita' practice: lo spartito si legge una volta, poi si procede a passi.

PERCHE' QUESTO MODULO ESISTE, e perche' non e' un secondo join.py.

La modalita' normale allinea nel TEMPO: `join()` deve dedurre in che battuta
dello spartito e' caduta una nota, e lo fa interpolando `beat_at(t/tempo_factor)`
sugli angoli del tempo scritto. Tutto il suo lavoro difficile e' li'.

La modalita' practice non ha un tempo. Il brano sta fermo e avanza di un passo
quando l'allievo ha premuto le note giuste: la posizione nello spartito non e'
una cosa da DEDURRE, e' una variabile di stato che il chiamante conosce gia'.
Quindi qui non si allinea niente e non si interpola niente: si legge quello che
lo spartito chiede all'istante N e si costruisce una traccia di pochi eventi.

EFFETTO COLLATERALE, ed e' la cosa che conta: le regole RML non cambiano di una
riga. Girano sugli stessi campi `expected.*` con le stesse soglie, perche' il
formato della traccia e' quello che conoscono. RML resta l'unico giudice anche
in questa modalita': se il verdetto venisse calcolato in TypeScript, l'MVP
perderebbe il suo oggetto (e' la lezione di MetricsTestPage, vedi pages/AGENTS.md).


AVANZAMENTO E GIUDIZIO SONO DUE COSE DIVERSE

Questa e' la distinzione piu' importante del modulo, e serve a non far mentire
nessuno dei due.

  AVANZAMENTO  e' la COMPLETEZZA del passo: hai premuto tutte le note che lo
               spartito chiede qui? E' una proprieta' di controllo di flusso
               dell'esercizio, non un giudizio sull'esecuzione. La stessa
               categoria della fine-brano che ScorePage deduce dal player: un
               fatto sullo stato dell'esercizio, non un verdetto. Sta qui, in
               Python, ed e' dichiarata come tale.

  GIUDIZIO     e' cosa dice RML delle note che hai DAVVERO premuto. Sempre RML,
               nessuna soglia in Python, nessuna soglia in TypeScript.

PERCHE' NON SI PUO' USARE pitch-agreement COME CANCELLO. Sarebbe la scelta
naturale ("se la regola dice che la nota e' sbagliata, non avanzo") ed e'
sbagliata, per un motivo preciso: `pitch-agreement` guarda una nota alla volta e
non sa quante ne mancavano, quindi non distingue

    "hai premuto la nota sbagliata invece di quella giusta"   -> non avanzare
    "hai premuto le giuste E una in piu'"                     -> avanzare

Le due cose sono entrambe "un noteon con pitchDist diverso da zero": lo stesso
verdetto per due situazioni opposte. Se `pitch-agreement` fosse il cancello, una
nota premuta per sbaglio bloccherebbe l'avanzamento anche quando l'allievo ha
suonato tutto giusto, che e' il contrario del comportamento voluto.

Le due cose coincidono nel caso normale (sbagli la nota -> manca quella attesa ->
non avanzi) e si separano solo dove serve (nota in piu' -> avanzi, e RML te la
segnala). Il frontend usa `advance` per il cursore e i verdetti per il pannello.


QUALI REGOLE HANNO SENSO QUI DENTRO

Non tutte le sette regole del servizio si applicano a un brano che sta fermo, e
la scelta non e' "quali sono difficili" ma "quali hanno bisogno del tempo":

  attive     pitch-agreement, pitch-range      (la nota)
             chord-jitter, dynamics-adherence  (come l'hai suonata)
  sospese    articulation, pedal-toggle, syncopated-pedal

Tutte e quattro le attive sono FEEDBACK: nessuna blocca l'avanzamento, che
dipende dalla completezza. La scelta e' MISURATA, non di comodo: su una traccia
di un passo con il brano fermo `chord-jitter` boccia ogni accordo premuto a piu'
di 30 ms — cioe' ogni accordo premuto con calma, il comportamento normale di chi
sta imparando (verificato: accordo a 500 ms -> VIOLATA, a 15 ms -> ok). La
specifica e' corretta; cambia il suo ruolo qui, ed e' giusto che una regola
segnali invece di bloccare.
"""

import bisect

# Le regole che girano in practice mode. Il servizio le fa eseguire da
# batch.pl come tutte le altre: sono le stesse specifiche .rml, senza varianti.
PRACTICE_RULES = ("pitch-agreement", "pitch-range",
                  "chord-jitter", "dynamics-adherence")

# Le regole che esistono nel servizio ma non si applicano qui, con il motivo.
# Viaggiano nella risposta invece di sparire: un verdetto che tace si legge come
# "conforme", ed e' la distinzione fra assente e zero che questo progetto tiene
# gia' dappertutto (vedi i commenti su dynExplicit e spanExplicit).
SUSPENDED_RULES = {
    "articulation":
        "Serve il tempo fra un attacco e il successivo: qui quel tempo e' quanto "
        "ci metti a trovare il tasto, non un'articolazione.",
    "pedal-toggle":
        "Confronta la battuta di ogni CC64 con gli estremi dello span di pedale. "
        "A brano fermo l'evento di pedale non ha un passo proprio, quindi il "
        "confronto sarebbe soddisfatto per costruzione e la regola direbbe "
        "sempre conforme.",
    "syncopated-pedal":
        "Chiede che il pedale arrivi dopo l'attacco della nota, leggendo l'ordine "
        "reale degli eventi. A brano fermo quell'ordine e' quello con cui trovi i "
        "tasti, non il tempo musicale.",
}


class PracticePlan:
    """Lo spartito ridotto a una sequenza di passi.

    Un PASSO e' un istante della partitura: contiene tutte le note che vanno
    premute insieme, quindi un accordo e' un passo solo. E' la sola definizione
    che rende chord-jitter misurabile: se il passo fosse una singola nota, il
    ritardo fra le note dell'accordo sarebbe quello con cui l'allievo le cerca e
    la regola non avrebbe piu' niente da dire.
    """

    def __init__(self, model):
        self.model = model
        onsets = sorted({n["onset"] for n in model.notes})
        self.steps = []
        for i, onset in enumerate(onsets):
            note = [n for n in model.notes if n["onset"] == onset]
            self.steps.append({
                "index": i,
                "notes": note,
                "onset": onset,
                "measure": model.measure_at(onset),
                "articulation": model.articulation_at(onset),
                # I pitch da premere in questo passo, SENZA ripetizioni.
                #
                # Senza ripetizioni perche' due voci che suonano la stessa nota
                # sono due note sullo spartito ma UN tasto sulla tastiera: un
                # pianista preme C4 una volta sola, e chiedergli di premerlo due
                # volte sarebbe una richiesta che non ha senso fisico. La lista
                # con le ripetizioni resta in `notes`, che serve ai campi di
                # expected (chordMates) dove le occorrenze contano.
                "pitches": sorted({n["pitch"] for n in note}),
            })

    def __len__(self):
        return len(self.steps)

    def event_at(self, index):
        """L'evento puntato dal cursore, nella forma che serve al frontend.

        `pitch` e' la lista dei tasti da premere: il frontend la usa per
        evidenziare i tasti e per decidere quando il passo e' completo, non per
        giudicare. Il giudizio e' sempre di RML.
        """
        step = self.steps[index]
        return {
            "index": index,
            "total": len(self.steps),
            "measure": step["measure"],
            "pitch": step["pitches"],
            "articulation": step["articulation"],
        }

    def all_events(self):
        """Tutti i passi, per il frontend.

        Serve l'elenco COMPLETO e non solo il primo perche' il cursore avanza in
        locale: l'allievo non deve aspettare il verdetto — che sul piano gratuito
        arriva in secondi — per passare al tasto successivo, e per sapere se ha
        premuto tutto gli bastano i pitch di ogni passo, che il server ha gia'
        calcolato. Il verdetto, quello, arriva dopo.
        """
        return [self.event_at(i) for i in range(len(self.steps))]


# --------------------------------------------------------------- la traccia


def _annotation(model, pitch, step):
    """I campi `expected` di una nota premuta al passo indicato.

    Sono gli STESSI campi che scrive `join()`, perche' le specifiche RML li
    leggono per nome. La differenza e' da dove viene la battuta: li' da
    `beat_at(t/tempo_factor)`, qui dall'onset del passo, che e' esatto per
    costruzione e non ha bisogno di tolleranze.

    E la differenza che conta e' QUALI pitch si considerano attesi.
    `join()` usa `score_pitches_at(beat)`, che con la sua tolleranza prende
    anche le note gia' in suono da un attacco precedente: in modalita' normale e'
    voluto, perche' una nota tenuta mentre ne attacchi un'altra e' comunque
    dentro lo spartito. Qui no: il cancello deve rispondere a "hai premuto le
    note di QUESTO passo?", e una nota sostenuta dal passo precedente non e' una
    risposta valida. Verificato: sul brano di prova il passo 1 attende [46, 86] e
    a quel punto suona ancora 53 dal passo 0; con la lista dello spartito 53
    sarebbe passata come nota giusta.
    """
    onset = step["onset"]
    e = model.expected_at(onset)
    near, dist = model.nearest(step["pitches"], pitch)
    chord_mates = model.chord_mates(onset, near)

    # ATTENZIONE, e' la stessa regola di join(): se lo spartito in quel punto non
    # prevede nessuna nota, pitchDist None farebbe passare la nota per
    # `unmatchedNote` e non verrebbe mai bocciata. Quel campo e' pensato per le
    # note suonate FUORI da ogni nota attiva, che nella traccia del join sono una
    # cosa normale. Qui il passo c'e' sempre per costruzione, quindi una nota
    # fuori dallo spartito va bocciata come qualsiasi pitch sbagliato.
    if dist is None:
        dist = 127

    return {
        "dyn": e["dyn"],
        "dynExplicit": e["dyn"] is not None,
        "dynText": e["dyn_text"],
        "pedal": e["pedal"],
        "spanExplicit": e["span"] is not None,
        "spanStart": e["span"]["start"] if e["span"] else None,
        "spanEnd": e["span"]["end"] if e["span"] else None,
        "pitch": near,
        "pitchDist": dist,
        "pitches": step["pitches"],
        "chordId": model.chord_at(onset),
        "chordMates": chord_mates,
        "art": model.articulation_at(onset),
    }


def is_note_off(ev):
    """Un note-off, in una delle due forme in cui lo strumento lo manda.

    Un note-on con velocity 0 E' un rilascio: e' cosi' che lo manda lo standard
    MIDI e le tastiere lo fanno davvero. Web MIDI non sempre lo normalizza, ed e'
    la stessa trappola che `useVerdict.toPerformance` documenta sul lato
    frontend. Trattarlo come attacco lascerebbe la nota premuta per sempre e
    farebbe avanzare il cursore su un rilascio.
    """
    if ev["type"] == "noteoff":
        return True
    return ev["type"] == "noteon" and (ev.get("velocity") or 0) == 0


def pressed_notes(events):
    """Gli attacchi premuti, con la durata, nella forma {time_ms, dur_ms, ...}.

    Ricalca `toPerformance` del frontend, ma qui gli eventi arrivano grezzi:
    l'accoppiamento attacco/rilascio deve stare in un posto solo, e il resto del
    lavoro e' gia' qui.

    Le durate si accoppiano FIFO per pitch, come nel frontend: se lo stesso
    pitch suona due volte prima del rilascio, il primo note-off chiude il primo
    attacco. Una nota mai rilasciata prende la durata fino all'ultimo evento
    visto: buttarla nasconderebbe proprio il caso della nota tenuta.
    """
    notes = []
    pending = {}
    last = 0.0
    for ev in events:
        last = ev["time_ms"]
        pitch = ev["pitch"]
        if is_note_off(ev):
            queue = pending.get(pitch)
            if not queue:
                continue          # rilascio senza attacco: nulla da chiudere
            attack = queue.pop(0)
            if not queue:
                del pending[pitch]
            notes.append({"time_ms": attack["time_ms"],
                          "dur_ms": ev["time_ms"] - attack["time_ms"],
                          "pitch": pitch, "velocity": attack["velocity"]})
        else:
            pending.setdefault(pitch, []).append(
                {"time_ms": ev["time_ms"], "velocity": ev["velocity"]})
    for pitch, queue in pending.items():
        for attack in queue:
            notes.append({"time_ms": attack["time_ms"],
                          "dur_ms": max(last - attack["time_ms"], 30.0),
                          "pitch": pitch, "velocity": attack["velocity"]})
    notes.sort(key=lambda n: n["time_ms"])
    return notes


def step_status(plan, index, events):
    """Cosa manca perche' il passo sia completo. NON e' un verdetto.

    Risponde a "hai premuto tutti i tasti di questo passo?", che e' controllo di
    flusso dell'esercizio (vedi il commento in testa al modulo). Il giudizio su
    COME li hai premuti lo danno le regole RML, sulla traccia costruita da
    `trace_for_step`.
    """
    step = plan.steps[index]
    expected = step["pitches"]
    premuti = {n["pitch"] for n in pressed_notes(events)}
    mancanti = [p for p in expected if p not in premuti]
    estranei = sorted(p for p in premuti if p not in expected)
    return {
        "advance": not mancanti,
        "expected": expected,
        "pressed": sorted(premuti),
        "missing": mancanti,
        "extra": estranei,
    }


def trace_for_step(plan, index, events, control_changes=None):
    """La traccia di UN passo: quello che e' successo davanti al passo corrente.

    Non e' una fetta della traccia del brano intero. E' una traccia a se', di
    pochi eventi — le note premute adesso e i pedali azionati adesso — ed e' il
    motivo per cui il verdetto arriva in un processo da ~170 ms invece che in uno
    che si rilegge il brano.
    """
    step = plan.steps[index]
    model = plan.model
    notes = pressed_notes(events)

    attacchi = sorted({n["time_ms"] for n in notes})

    def prossimo_attacco(t):
        i = bisect.bisect_right(attacchi, t)
        return attacchi[i] if i < len(attacchi) else None

    out = []
    for n in notes:
        ann = _annotation(model, n["pitch"], step)
        prossimo = prossimo_attacco(n["time_ms"])
        posizione = {"beat": round(step["onset"], 4), "measure": step["measure"]}
        out.append({
            "type": "noteon",
            "note": {"number": n["pitch"], "rawAttack": n["velocity"]},
            "timestamp": n["time_ms"],
            "position": posizione,
            "expected": ann,
            # quanto e' stata tenuta premuta: la stessa informazione che porta
            # join(). Qui non la legge nessuna regola attiva, ma la traccia non
            # deve cambiare forma fra le due modalita': una regola togliere o
            # mettere un campo non deve costare una riscrittura.
            "durMs": round(float(n["dur_ms"]), 2),
            "gapMs": None if prossimo is None else round(prossimo - n["time_ms"], 2),
        })
        out.append({
            "type": "noteoff",
            "note": {"number": n["pitch"]},
            "timestamp": n["time_ms"] + n["dur_ms"],
            "position": posizione,
            "expected": ann,
        })

    # il pedale: in pratica non lo giudica nessuna regola attiva, ma se l'allievo
    # lo preme l'evento deve esserci. Una traccia che lo nasconde descriverebbe
    # un'esecuzione diversa da quella che c'e' stata, e il giorno in cui una
    # regola sul pedale diventa applicabile qui la traccia e' gia' pronta.
    #
    # Gli altri controller si scartano: nessuna regola li guarda, e una traccia
    # piu' corta costa meno.
    for c in control_changes or []:
        if c["controller"] != 64:
            continue
        out.append({
            "type": "controlchange",
            "controller": 64,
            "value": c["value"],
            "timestamp": c["time_ms"],
            "position": {"beat": round(step["onset"], 4),
                         "measure": step["measure"]},
            "expected": {
                "dyn": None, "dynExplicit": False, "dynText": None,
                "pedal": model.expected_at(step["onset"])["pedal"],
                "spanExplicit": False, "spanStart": None, "spanEnd": None,
                "pitch": None, "pitchDist": None, "pitches": [],
                "chordId": model.chord_at(step["onset"]), "chordMates": [],
                "art": None,
            },
        })

    out.sort(key=lambda e: e["timestamp"])
    return out
