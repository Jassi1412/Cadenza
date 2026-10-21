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
  measure: number;
  /** i tasti da premere perche' il passo sia completo, senza ripetizioni */
  pitch: number[];
  articulation: string | null;
}

export interface StepStatus {
  advance: boolean;
  expected: number[];
  pressed: number[];
  missing: number[];
  extra: number[];
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
  const extra = premuti.filter((p) => !expected.includes(p));
  // Estranee NON bloccano: se hai suonato le note giuste e in piu' una sbagliata,
  // il passo e' completo e si avanza. A dire che quella nota non c'entrava e' la
  // regola pitch-agreement, che arriva dopo e non tocca il cursore.
  return { advance: missing.length === 0, expected, pressed: premuti, missing, extra };
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
