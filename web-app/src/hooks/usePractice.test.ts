import { describe, expect, it } from 'vitest';
import { noteName, pressedPitches, stepProblem, stepStatus } from './practiceSteps';
import type { PracticeStep, VerdictsSnapshot } from './practiceSteps';
import type { MidiEvent } from './useMidi';

const on = (timestamp: number, note: number, rawAttack = 90): MidiEvent =>
  ({ type: 'noteon', note, rawAttack, timestamp });
const off = (timestamp: number, note: number): MidiEvent =>
  ({ type: 'noteoff', note, timestamp });

// `attack` e' l'indice dell'attacco nello spartito COMPLETO: quando si studia una
// mano sola non coincide piu' con `index`, ed e' quello che il cursore di OSMD deve
// raggiungere (cammina posizione per posizione su tutto il rigo). `offhand` sono i
// tasti dell'altro rigo nello stesso istante.
const passo = (pitch: number[], offhand: number[] = [], attack = 0): PracticeStep =>
  ({ index: 0, total: 10, attack, measure: 1, pitch, offhand, articulation: null });

describe('pressedPitches', () => {
  it('tiene un pitch una volta sola', () => {
    // Un tasto premuto due volte e' lo stesso tasto: l'avanzamento e' un
    // confronto fra insiemi, non un conteggio di eventi.
    expect(pressedPitches([on(0, 60), off(10, 60), on(20, 60)])).toEqual([60]);
  });

  it('un note-on con velocity 0 non conta come pressione', () => {
    // Lo strumento lo manda per il rilascio e Web MIDI non sempre lo normalizza:
    // contarlo farebbe avanzare il cursore su un rilascio.
    expect(pressedPitches([on(0, 60, 0)])).toEqual([]);
  });

  it('ignora i control change e i rilievi', () => {
    const cc: MidiEvent = { type: 'controlchange', controller: 64, value: 127, timestamp: 0 };
    expect(pressedPitches([cc, off(10, 60)])).toEqual([]);
  });

  it('ordina i pitch crescenti', () => {
    expect(pressedPitches([on(0, 67), on(10, 60), on(20, 64)])).toEqual([60, 64, 67]);
  });

  it('un accordo suonato con calma resta completo', () => {
    // Il tempo non entra nella completezza: 500 ms fra le due note di un accordo
    // sono un accordo completo, e chord-jitter lo segnalera' semmai come
    // sfalsato. Se qui contasse il tempo, il passo non avanzerebbe mai.
    expect(pressedPitches([on(0, 46), on(500, 93)])).toEqual([46, 93]);
  });
});

describe('stepStatus', () => {
  it('avanza quando tutte le note del passo sono state premute', () => {
    const s = stepStatus(passo([46, 93]), [on(0, 46), on(15, 93)]);
    expect(s.advance).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.extra).toEqual([]);
  });

  it('non avanza quando ne manca una, e dice quale', () => {
    const s = stepStatus(passo([46, 93]), [on(0, 46)]);
    expect(s.advance).toBe(false);
    expect(s.missing).toEqual([93]);
  });

  it('non avanza quando al posto della nota giusta ne preme un\'altra', () => {
    // E' il caso del principiante che sbaglia tasto: il cursore resta, e a dire
    // perche' e' pitch-agreement, che arriva dal servizio.
    const s = stepStatus(passo([91]), [on(0, 92)]);
    expect(s.advance).toBe(false);
    expect(s.missing).toEqual([91]);
    expect(s.extra).toEqual([92]);
  });

  it('AVANZA anche con una nota in piu\'', () => {
    // Il caso decisivo di tutta la modalita', ed e' il motivo per cui
    // l'avanzamento non puo' essere il verdetto di pitch-agreement: la regola
    // guarda una nota alla volta e non sa quante ne mancavano, quindi per lei
    // "hai sbagliato nota" e "hai aggiunto una nota" sono lo stesso verdetto.
    // Qui invece la differenza si vede: le attese ci sono tutte, quindi si
    // avanza, e la nota estranea viene solo segnalata.
    const s = stepStatus(passo([46, 93]), [on(0, 46), on(15, 93), on(30, 47)]);
    expect(s.advance).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.extra).toEqual([47]);
  });

  it('non avanza se il passo non ha ricevuto nessuna nota', () => {
    const s = stepStatus(passo([46, 93]), []);
    expect(s.advance).toBe(false);
    expect(s.missing).toEqual([46, 93]);
  });

  it('un tasto tenuto da prima non conta come pressione del passo', () => {
    // Il cursore non deve avanzare per una nota che era gia' giu' dal passo
    // precedente: sarebbe un avanzamento senza aver trovato il tasto nuovo.
    const s = stepStatus(passo([46, 86]), [on(0, 53)]);
    expect(s.advance).toBe(false);
    expect(s.missing).toEqual([46, 86]);
    expect(s.extra).toEqual([53]);
  });
});

describe('noteName', () => {
  it('usa la convenzione scientifica di webmidi', () => {
    expect(noteName(60)).toBe('C4');   // il Do centrale
    expect(noteName(69)).toBe('A4');   // il LA del diapason
  });

  it('gli estremi della tastiera a 88 tasti', () => {
    // Gli stessi numeri che citano pitch-range.rml e il modello degli eventi:
    // A0 = 21, C8 = 108.
    expect(noteName(21)).toBe('A0');
    expect(noteName(108)).toBe('C8');
  });

  it('i bemolli si leggono come diesis', () => {
    // MIDI non distingue: 61 e' il Do diesis, e non esiste un numero che dica
    // "Re bemolle". L'etichetta sceglie il diesis, e lo dichiara.
    expect(noteName(61)).toBe('C#4');
    expect(noteName(66)).toBe('F#4');
  });

  it('l\'ottava cambia a ogni do, non a ogni la', () => {
    // E' l'errore facile di uno: 59 e' B3 e 60 e' C4.
    expect(noteName(59)).toBe('B3');
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('C#4');
  });
});

describe('stepStatus con una mano sola', () => {
  it('il tasto dell\'altro rigo non e\' una nota estranea, ma si dichiara', () => {
    // Se finisse in `extra`, pitch-agreement lo leggerebbe come nota sbagliata:
    // sarebbe una bugia su una nota che lo spartito chiedeva eccome, solo non alla
    // mano che si sta studiando.
    const s = stepStatus(passo([93], [46]), [on(0, 93), on(12, 46)]);
    expect(s.advance).toBe(true);
    expect(s.extra).toEqual([]);
    expect(s.other_hand).toEqual([46]);
  });

  it('premere solo la nota dell\'altro rigo non fa avanzare e non fa sbagliare niente', () => {
    const s = stepStatus(passo([93], [46]), [on(0, 46)]);
    expect(s.advance).toBe(false);
    expect(s.missing).toEqual([93]);
    expect(s.extra).toEqual([]);
    expect(s.other_hand).toEqual([46]);
  });

  it('un tasto che non c\'entra con nessuna delle due mani resta estraneo', () => {
    const s = stepStatus(passo([93], [46]), [on(0, 93), on(12, 47)]);
    expect(s.extra).toEqual([47]);
  });

  it('senza filtro mano la lista dell\'altro rigo e\' vuota', () => {
    const s = stepStatus(passo([46, 93]), [on(0, 46), on(15, 93), on(30, 47)]);
    expect(s.other_hand).toEqual([]);
    expect(s.extra).toEqual([47]);
  });
});

describe('stepProblem', () => {
  const ok = { ok: true, exit: 0 };
  const male = { ok: false, exit: 1 };
  const rotta = { ok: false, exit: 2 };
  const daVerdetto = (step: number, verdicts: Record<string, typeof ok>): VerdictsSnapshot =>
    ({ step, verdicts });
  const nessunVerdetto = { last: null, stepIndex: 0, judging: false, error: null, dynamicsOn: true };

  it('dice correct quando tutte le regole passano', () => {
    const p = stepProblem({
      last: daVerdetto(3, { 'pitch-agreement': ok, 'chord-jitter': ok, 'dynamics-adherence': ok }),
      stepIndex: 3, judging: false, error: null, dynamicsOn: true,
    });
    expect(p.text).toBe('correct');
    expect(p.tone).toBe('ok');
  });

  it('la nota sbagliata passa davanti a chord jitter e dinamica', () => {
    // Se il tasto e' sbagliato, anche l'accordo e la dinamica sono giudicati su una
    // nota che non c'entrava: la prima cosa da correggere e' quella.
    const p = stepProblem({
      last: daVerdetto(3, { 'pitch-agreement': male, 'chord-jitter': male, 'dynamics-adherence': male }),
      stepIndex: 3, judging: false, error: null, dynamicsOn: true,
    });
    expect(p.text).toBe('wrong note');
  });

  it('chord jitter da solo si vede', () => {
    const p = stepProblem({
      last: daVerdetto(3, { 'pitch-agreement': ok, 'chord-jitter': male, 'dynamics-adherence': ok }),
      stepIndex: 3, judging: false, error: null, dynamicsOn: true,
    });
    expect(p.text).toBe('chord jitter');
  });

  it('la dinamica si vede solo con l\'interruttore acceso', () => {
    // Il servizio giudica la dinamica anche quando l'allievo ha scelto di non
    // guardarla: e' la scelta che decide cosa occupy lo schermo.
    const last = daVerdetto(3, { 'pitch-agreement': ok, 'chord-jitter': ok, 'dynamics-adherence': male });
    expect(stepProblem({ last, stepIndex: 3, judging: false, error: null, dynamicsOn: true }).text)
      .toBe('bad dynamics');
    expect(stepProblem({ last, stepIndex: 3, judging: false, error: null, dynamicsOn: false }).text)
      .toBe('correct');
  });

  it('exit 2 non diventa mai un giudizio su chi suona', () => {
    // E' il monitor che non e' partito. Mostrarlo come "wrong note" vorrebbe dire
    // accusare l'allievo del guasto di un pezzo del servizio.
    const p = stepProblem({
      last: daVerdetto(3, { 'pitch-agreement': rotta, 'chord-jitter': ok, 'dynamics-adherence': ok }),
      stepIndex: 3, judging: false, error: null, dynamicsOn: true,
    });
    expect(p.text).toBe('cannot verify');
    expect(p.tone).toBe('broken');
  });

  it('pitch-range violato conta come nota sbagliata', () => {
    const p = stepProblem({
      last: daVerdetto(3, { 'pitch-range': male, 'chord-jitter': ok }),
      stepIndex: 3, judging: false, error: null, dynamicsOn: true,
    });
    expect(p.text).toBe('wrong note');
  });

  it('dichiara vecchio il verdetto di un passo gia\' lasciato', () => {
    // Sul servizio deployato il verdetto arriva in ~2 s: mentre lo si legge le dita
    // sono gia' al passo dopo, e senza questo il verdetto dell'11 sembrerebbe del 12.
    const p = stepProblem({
      last: daVerdetto(11, { 'pitch-agreement': ok }),
      stepIndex: 12, judging: false, error: null, dynamicsOn: true,
    });
    expect(p.stale).toBe(true);
  });

  it('non inventa un "correct" quando non c\'e\' nessun verdetto', () => {
    const p = stepProblem(nessunVerdetto);
    expect(p.tone).toBe('waiting');
    // Nessuna parola, non una d'attesa: la riga della pratica mostra solo il
    // giudizio, e l'attesta' la si vede dal punto che pulsa. Cio' che conta qui e'
    // che il tono NON sia `ok`: un "correct" sul silenzio e' la bugia proibita.
    expect(p.text).toBe('');
  });

  it('il verdetto vuoto perche\' non era premuto niente non e\' "correct"', () => {
    // Il servizio risponde `verdicts: {}` quando non c'era niente da giudicare,
    // apposta per non premiare il silenzio.
    const p = stepProblem({
      last: daVerdetto(3, {}), stepIndex: 3, judging: false, error: null, dynamicsOn: true,
    });
    expect(p.tone).toBe('waiting');
  });

  it('un errore di rete non e\' un modo di suonare', () => {
    const p = stepProblem({ ...nessunVerdetto, error: 'the service responded with 502' });
    expect(p.tone).toBe('warn');
    expect(p.text).toBe('no verdict from the service');
  });
});
