/**
 * Le regole dell'esercizio a passi: quali tasti, e quando il passo e' completo.
 *
 * PERCHE' QUESTO FILE E' SEPARATO DA `usePractice.ts`, e non e' una questione di
 * ordine.
 *
 * Primo: qui non c'e' React e non c'e' rete. Sono funzioni pure da elenco di
 * eventi a stato del passo, quindi si possono provare davvero, senza montare un
 * componente ne' fingere un servizio. `useVerdict` esporta `toPerformance` dallo
 * stesso file dell'hook, e il prezzo e' che per provarla serve l'intero import
 * del modulo — `import.meta.env` compreso.
 *
 * Secondo, e conta di piu': la regola react-refresh vieta di esportare funzioni
 * insieme a componenti, e questa logica non appartiene a un componente.
 *
 * TERZO, ED E' LA COSA DA NON CONFONDERE. Questo file NON calcola verdetti.
 *
 * Quello che c'e' qui e' la COMPLETEZZA del passo: hai premuto tutti i tasti che
 * lo spartito chiede in questo punto? E' controllo di flusso dell'esercizio —
 * la stessa categoria della fine-brano che ScorePage deduce dal player — e non
 * un giudizio sull'esecuzione. Il giudizio e' di RML e arriva dal servizio
 * (`/practice/step`), che fa girare le stesse specifiche .rml della modalita'
 * normale.
 *
 * La separazione non e' teorica ed e' MISURATA. `pitch-agreement` guarda una
 * nota alla volta e non sa quante ne mancavano, quindi per lei "hai sbagliato
 * nota" e "hai aggiunto una nota" sono lo stesso verdetto: entrambi un noteon
 * con pitchDist diverso da zero. Le due situazioni pero' vogliono l'opposto — la
 * prima deve bloccare il cursore, la seconda no — quindi il verdetto di quella
 * regola non puo' decidere l'avanzamento. La completezza invece distingue i due
 * casi senza sforzo, perche' confronta insiemi di pitch. Verificato su traccia
 * vera con il monitor: alignment/_probe_practice.py, caso 6.
 */

import type { MidiEvent } from './useMidi';

/** Un passo dell'esercizio: un istante della partitura e i tasti che chiede. */
export interface PracticeStep {
  index: number;
  total: number;
  /**
   * L'indice di questo attacco nello spartito COMPLETO.
   *
   * Con una mano sola i due indici non coincidono piu': `index` conta i passi
   * dell'esercizio, `attack` conta gli attacchi del rigo completo, ed e' quest'ultimo
   * che il cursore di OSMD deve raggiungere (li' cammina posizione per posizione).
   * Passare `index` al posto di `attack` non da' un errore visibile: il segno di
   * posizione si ferma due note prima, e l'allievo suona quella dopo.
   */
  attack: number;
  measure: number;
  /** i tasti da premere perche' il passo sia completo, senza ripetizioni */
  pitch: number[];
  /**
   * I tasti dell'ALTRA mano nello stesso istante, quando si studia una mano sola.
   * Non sono note sbagliate se li si preme: sono fuori dall'esercizio.
   */
  offhand: number[];
  articulation: string | null;
}

export interface StepStatus {
  advance: boolean;
  expected: number[];
  pressed: number[];
  missing: number[];
  extra: number[];
  /**
   * I tasti dell'altra mano premuti comunque. Dichiarati, non contati come estranei:
   * `extra` lo leggerebbe pitch-agreement come nota sbagliata, e sarebbe una bugia
   * su una nota che lo spartito chiedeva eccome, solo non alla mano studiata.
   */
  other_hand: number[];
}

/** Il verdetto di una regola: `exit` 2 non e' una violazione, e' il monitor che non
 *  e' partito (vedi la regola sui tre stati, in components/AGENTS.md). */
export interface StepVerdict {
  ok: boolean;
  exit: number;
}

/** La parte di risposta del servizio che serve alla riga compatta della pratica. */
export interface VerdictsSnapshot {
  step: number;
  verdicts: Record<string, StepVerdict>;
}

/**
 * I pitch premuti in un elenco di eventi, senza ripetizioni.
 *
 * Serve all'avanzamento, che e' un confronto fra insiemi: un tasto premuto due
 * volte e' lo stesso tasto. La velocity non conta — quanto forte hai suonato non
 * decide se il passo e' completo, lo dice `dynamics-adherence`.
 */
export function pressedPitches(events: readonly MidiEvent[]): number[] {
  const out = new Set<number>();
  for (const e of events) {
    if (e.type !== 'noteon') continue;
    // Un note-on con velocity 0 e' un rilascio: lo strumento lo manda, e' lo
    // standard MIDI, e Web MIDI non sempre lo normalizza. Contarlo come
    // pressione farebbe avanzare il cursore su un rilascio. E' la stessa
    // trappola documentata in `toPerformance`.
    if ((e.rawAttack ?? 0) === 0) continue;
    if (e.note === undefined) continue;
    out.add(e.note);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Il passo e' completo? Confronto fra insiemi, non una soglia: le note attese le
 * ha dichiarate il piano del servizio, non questo file.
 *
 * Restituisce anche mancanti ed estranee, che il pannello mostra: sapere QUALE
 * tasto manca e' la cosa utile mentre si studia.
 */
export function stepStatus(step: PracticeStep, events: readonly MidiEvent[]): StepStatus {
  const premuti = pressedPitches(events);
  const expected = [...step.pitch].sort((a, b) => a - b);
  const missing = expected.filter((p) => !premuti.includes(p));
  // Con una mano sola, un tasto dell'altra mano premuto sullo stesso istante non e'
  // ne' atteso ne' estraneo: e' fuori dall'esercizio. Stessa regola del servizio
  // (`alignment/practice.py`), perche' le due parti devono dire la stessa cosa.
  const other = premuti.filter((p) => (step.offhand ?? []).includes(p));
  const extra = premuti.filter((p) => !expected.includes(p) && !other.includes(p));
  // Estranee NON bloccano: se hai suonato le note giuste e in piu' una sbagliata,
  // il passo e' completo e si avanza. A dire che quella nota non c'entrava e' la
  // regola pitch-agreement, che arriva dopo e non tocca il cursore.
  return {
    advance: missing.length === 0,
    expected, pressed: premuti, missing, extra,
    other_hand: other.sort((a, b) => a - b),
  };
}

/**
 * Il nome scientifico di una nota MIDI: 60 -> C4, 21 -> A0, 108 -> C8.
 *
 * L'ottava e' facile da sbagliare di uno, quindi sta in una funzione provabile
 * invece che dentro il markup. Gli estremi sono quelli della tastiera a 88
 * tasti, gli stessi che citano le specifiche RML.
 */
export function noteName(pitch: number): string {
  const nomi = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const ottava = Math.floor(pitch / 12) - 1;
  return `${nomi[((pitch % 12) + 12) % 12]}${ottava}`;
}

/** Come la riga compatta deve colorarsi: `error` non e' mai l'allievo. */
export type ProblemTone = 'waiting' | 'checking' | 'ok' | 'warn' | 'broken';

export interface StepProblem {
  tone: ProblemTone;
  /** una riga sola, in italiano: e' un messaggio, non un'etichetta di modo */
  text: string;
  /** il verdetto mostrato riguarda un passo gia' lasciato */
  stale: boolean;
}

/**
 * La riga compatta della pratica: QUALI problemi possono comparire, e in che ordine.
 *
 * PERCHE' STA QUI E NON NEL COMPONENTE. Il componente deve restare presentazionale
 * (vedi components/AGENTS.md): se qui c'entra una scelta, la scelta e' provabile, e
 * `alignment/run_practice_tests.mjs` la prova davvero.
 *
 * NON E' UN SECONDO GIUDIZIO. Questa funzione non ha nessuna soglia e non confronta
 * nessun numero: riordina verdetti che ha gia' emesso RML. Il lavoro sporco — quanto
 * lontana una nota, entro quanti millisecondi arrivano i compagni d'accordo, se la
 * velocity tiene conto della dinamica scritta — resta nelle specifiche .rml, che e'
 * il posto dove sta sempre stato (vedi pages/AGENTS.md: nessun parametro numerico
 * dentro una pagina).
 *
 * PERCHE' UNA RIGA SOLA. L'allievo ha tre modi di sbagliare, in questa modalita': la
 * nota, l'accordo arpeggiato, la dinamica. Le altre quattro regole della pratica sono
 * o un sottoinsieme della nota (`pitch-range` guarda se il tasto esiste sullo
 * spartito) o non si applicano a brano fermo (le tre del pedale e dell'articolazione,
 * dichiarate dal servizio con il loro motivo). Mostrate una riga per regola e si
 * finisce col pannello da 553 px che copriva meta' spartito: qui la domanda e' una
 * sola, "cosa ho sbagliato in questo passo", e la risposta e' la prima cosa che
 * bisogna sentire.
 *
 * L'ORDINE NON E' GUSTO: prima la nota, perche' se il tasto e' sbagliato anche
 * l'accordo e la dinamica sono giudicati su una nota che non c'entrava.
 */
export function stepProblem(input: {
  last: VerdictsSnapshot | null;
  stepIndex: number;
  judging: boolean;
  error: string | null;
  dynamicsOn: boolean;
}): StepProblem {
  const { last, stepIndex, judging, error, dynamicsOn } = input;

  // Niente da dire finche' non c'e' nessun verdetto. Il servizio non ha ancora
  // risposto, e un "ok" messo qui sarebbe inventato: sta succedendo niente.
  if (last === null) {
    if (judging) return { tone: 'checking', text: 'verifico…', stale: false };
    if (error) return { tone: 'warn', text: 'il verdetto non e\' arrivato', stale: false };
    return { tone: 'waiting', text: 'suona i tasti del passo', stale: false };
  }

  const stale = last.step !== stepIndex;
  const di = last.verdicts;
  const v = (nome: string) => di[nome];
  const rotta = (nome: string) => v(nome) !== undefined && v(nome).exit === 2;

  // Nessun verdetto perche' non c'era niente da giudicare: il servizio risponde con
  // `verdicts: {}` quando non e' premuto nessun tasto, apposta per non dire
  // "conforme" sul silenzio. Anche qui il silenzio non diventa un giudizio.
  if (Object.keys(di).length === 0) {
    if (error) return { tone: 'warn', text: 'il verdetto non e\' arrivato', stale };
    return { tone: 'waiting', text: 'suona i tasti del passo', stale };
  }

  // exit 2 per primo, sempre. E' il monitor che non e' partito: dire "nota
  // sbagliata" su un servizio rotto significa accusare l'allievo di un guasto
  // del software. E' lo stesso tre-stati che PracticePanel mostrava come riga
  // separata; qui e' una parola, ma non deve diventare mai un "violata".
  if (rotta('pitch-agreement') || rotta('pitch-range')
      || rotta('chord-jitter') || (dynamicsOn && rotta('dynamics-adherence'))) {
    return { tone: 'broken', text: 'non verificabile', stale };
  }

  const viola = (nome: string) => v(nome) !== undefined && !v(nome).ok;

  if (viola('pitch-agreement') || viola('pitch-range')) {
    return { tone: 'warn', text: 'nota sbagliata', stale };
  }
  if (viola('chord-jitter')) {
    // Le parole che ha usato chi usa l'app: "chord jitter". Il nome della regola e'
    // anche quello che compare nel pannello dei verdetti della modalita' normale,
    // quindi le due superfici non la chiamano in due modi diversi.
    return { tone: 'warn', text: 'chord jitter', stale };
  }
  // Con la dinamica spenta il verdetto continua ad arrivare (il servizio fa
  // sempre girare tutte e quattro le regole): e' l'allievo che ha scelto di non
  // guardarla, quindi non deve comparire nella riga. Lo dice l'interruttore.
  if (dynamicsOn && viola('dynamics-adherence')) {
    return { tone: 'warn', text: 'dinamica errata', stale };
  }

  if (error) return { tone: 'warn', text: 'il verdetto non e\' arrivato', stale };
  return { tone: 'ok', text: 'conforme', stale };
}
