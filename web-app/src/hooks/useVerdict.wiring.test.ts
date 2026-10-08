/**
 * Prova di confine: il payload che produce il frontend deve avere esattamente
 * la forma che server.py valida, e notes -> events -> notes deve tornare
 * indietro identico.
 *
 * Non ripete useVerdict.test.ts: qui si controlla il CONTRATTO col servizio,
 * su un numero di note che fa emergere gli errori di nome di campo e di unita'
 * che su due righe non si vedono.
 */
import { describe, expect, it } from 'vitest';
import { toPerformance } from './useVerdict';
import type { MidiEvent } from './useMidi';

const NOTE_COUNT = 216;
const MAX_GAP_MS = 700;

/** Esecuzione sintetica ma irregolare: durate e pitch diversi, ordine sparso. */
function buildSource(): { notes: { time_ms: number; dur_ms: number; pitch: number; velocity: number }[] } {
  const notes = [];
  let t = 0;
  for (let i = 0; i < NOTE_COUNT; i += 1) {
    // il tempo avanza a salti irregolari, come un演奏 reale
    t += 60 + (i * 37) % MAX_GAP_MS;
    notes.push({
      time_ms: t,
      dur_ms: 120 + (i * 53) % 400,
      pitch: 36 + ((i * 7) % 60),
      velocity: 40 + ((i * 11) % 80),
    });
  }
  return { notes };
}

/** Ricostruisce il flusso MIDI che il browser avrebbe visto. */
function toEvents(notes: { time_ms: number; dur_ms: number; pitch: number; velocity: number }[]): MidiEvent[] {
  const events: MidiEvent[] = notes.map((n) => ({
    type: 'noteon', timestamp: n.time_ms, note: n.pitch, rawAttack: n.velocity,
  }));
  for (const n of notes) {
    events.push({ type: 'noteoff', timestamp: n.time_ms + n.dur_ms, note: n.pitch });
  }
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

describe('payload del frontend -> servizio', () => {
  const src = buildSource();
  const out = toPerformance(toEvents(src.notes));

  it('ricostruisce tutte le note', () => {
    expect(out.notes).toHaveLength(NOTE_COUNT);
  });

  it('ritorna indietro gli stessi attacchi, pitch, durate e velocita\'', () => {
    const original = [...src.notes].sort((a, b) => a.time_ms - b.time_ms);
    out.notes.forEach((n, i) => {
      expect(n.pitch).toBe(original[i].pitch);
      expect(n.velocity).toBe(original[i].velocity);
      expect(n.time_ms).toBeCloseTo(original[i].time_ms, 6);
      expect(n.dur_ms).toBeCloseTo(original[i].dur_ms, 6);
    });
  });

  it('produce esattamente i campi che server.py valida', () => {
    // Se un nome cambiasse qui, server.py risponderebbe 400 e la pagina
    // mostrerebbe "nessuna nota registrata", senza dire quale campo manca.
    // tempo_factor e' l'unico campo che non riguarda le note: e' la scala con
    // cui il servizio riporta i tempi su quello che l'utente ha scelto.
    expect(Object.keys(out).sort()).toEqual(['control_changes', 'notes', 'tempo_factor']);
    for (const n of out.notes) expect(Object.keys(n).sort()).toEqual(['dur_ms', 'pitch', 'time_ms', 'velocity']);
    for (const c of out.control_changes) expect(Object.keys(c).sort()).toEqual(['controller', 'time_ms', 'value']);
  });

  it('il fattore di tempo viaggia al servizio', () => {
    // 155 -> 80 e' 1,9375: il brano suona a meta' velocita' e ogni millisecondo
    // scritto nello spartito vale quasi due millisecondi reali.
    expect(toPerformance(toEvents(src.notes)).tempo_factor).toBe(1);
    expect(toPerformance(toEvents(src.notes), 155 / 80).tempo_factor).toBeCloseTo(1.9375, 6);
    expect(toPerformance(toEvents(src.notes), 1).tempo_factor).toBe(1);
  });

  it('il corpo inviato e\' JSON serializzabile senza circoli', () => {
    expect(() => JSON.stringify({ score: '<score/>', ...out })).not.toThrow();
  });
});