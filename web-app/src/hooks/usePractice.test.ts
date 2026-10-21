import { describe, expect, it } from 'vitest';
import { noteName, pressedPitches, stepStatus } from './practiceSteps';
import type { PracticeStep } from './practiceSteps';
import type { MidiEvent } from './useMidi';

const on = (timestamp: number, note: number, rawAttack = 90): MidiEvent =>
  ({ type: 'noteon', note, rawAttack, timestamp });
const off = (timestamp: number, note: number): MidiEvent =>
  ({ type: 'noteoff', note, timestamp });

const passo = (pitch: number[]): PracticeStep =>
  ({ index: 0, total: 10, measure: 1, pitch, articulation: null });

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
