import { describe, expect, it, vi } from 'vitest';
import { fetchHands, toPerformance, verdictBody } from './useVerdict';
import type { MidiEvent } from './useMidi';

const on = (timestamp: number, note: number, rawAttack: number): MidiEvent =>
  ({ type: 'noteon', note, rawAttack, timestamp });
const off = (timestamp: number, note: number): MidiEvent =>
  ({ type: 'noteoff', note, timestamp });
const cc = (timestamp: number, controller: number, value: number): MidiEvent =>
  ({ type: 'controlchange', controller, value, timestamp });

describe('toPerformance', () => {
  it('abbina attacco e rilascio sulla durata', () => {
    const { notes } = toPerformance([on(0, 60, 90), off(250, 60)]);
    expect(notes).toEqual([{ time_ms: 0, dur_ms: 250, pitch: 60, velocity: 90 }]);
  });

  it('un note-on con velocita\' 0 e\' un note-off', () => {
    const { notes } = toPerformance([on(0, 60, 90), on(300, 60, 0)]);
    expect(notes).toEqual([{ time_ms: 0, dur_ms: 300, pitch: 60, velocity: 90 }]);
  });

  it('accoppia in FIFO quando lo stesso pitch suona due volte', () => {
    // primo rilascio chiude il primo attacco, non il secondo
    const { notes } = toPerformance([on(0, 60, 70), on(100, 60, 90), off(200, 60), off(400, 60)]);
    expect(notes).toEqual([
      { time_ms: 0, dur_ms: 200, pitch: 60, velocity: 70 },
      { time_ms: 100, dur_ms: 300, pitch: 60, velocity: 90 },
    ]);
  });

  it('una nota mai rilasciata arriva fino all\'ultimo evento', () => {
    const { notes } = toPerformance([on(0, 60, 90), on(500, 64, 80)]);
    expect(notes).toEqual([
      { time_ms: 0, dur_ms: 500, pitch: 60, velocity: 90 },
      { time_ms: 500, dur_ms: 30, pitch: 64, velocity: 80 },
    ]);
  });

  it('un note-off senza attacco non crea una nota', () => {
    const { notes } = toPerformance([off(100, 60)]);
    expect(notes).toEqual([]);
  });

  it('un tasto tenuto poco arriva comunque, con la durata vera', () => {
    // Prima questa nota veniva scartata qui, e quindi non finiva nella traccia:
    // non era la regola a non segnalarla, era l'assenza dell'evento. Ora passa,
    // col suo valore vero, e a confrontarlo con i 30 ms e' la regola.
    const { notes } = toPerformance([on(0, 60, 90), off(5, 60)]);
    expect(notes).toEqual([{ time_ms: 0, dur_ms: 5, pitch: 60, velocity: 90 }]);
  });

  it('un tasto premuto e mai rilasciato riceve il minimo di 30 ms', () => {
    // Caso diverso e dichiarato: qui il dato non c'e'. La durata e' inventata
    // dal browser per non lasciare la nota appesa, quindi la regola su questo
    // caso non puo' pronunciarsi.
    const { notes } = toPerformance([on(0, 60, 90)]);
    expect(notes).toEqual([{ time_ms: 0, dur_ms: 30, pitch: 60, velocity: 90 }]);
  });

  it('ordina note e control change per tempo', () => {
    const { notes, control_changes } = toPerformance([
      on(400, 64, 80), cc(100, 64, 127), on(0, 60, 90), off(600, 60), cc(500, 64, 0),
    ]);
    expect(notes.map((n) => n.time_ms)).toEqual([0, 400]);
    expect(control_changes.map((c) => c.time_ms)).toEqual([100, 500]);
    expect(control_changes[0]).toEqual({ time_ms: 100, controller: 64, value: 127 });
  });

  it('un accordo tiene separate le due note', () => {
    const { notes } = toPerformance([on(0, 60, 90), on(20, 64, 85), off(300, 60), off(300, 64)]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ pitch: 60, dur_ms: 300 });
    expect(notes[1]).toMatchObject({ pitch: 64, dur_ms: 280 });
  });

  // Il difetto che rendeva inutile tutto il resto (2026-11-10): il browser data
  // i MIDI con DOMHighResTimeStamp, ms dalla navigazione, mentre lo spartito e
  // il servizio contano da 0. Senza sottrarre l'istante del "Go" ogni nota
  // finiva sull'ultimo attacco: "never played" quasi ovunque, nessun verde.
  it('i timestamp assoluti della pagina diventano relativi all\'istante del "Go"', () => {
    const { notes } = toPerformance([on(42500, 60, 90), off(42750, 60)], 1, 42000);
    expect(notes).toEqual([{ time_ms: 500, dur_ms: 250, pitch: 60, velocity: 90 }]);
  });

  it('quello che si preme durante il countdown non entra nella presa', () => {
    const { notes } = toPerformance([
      on(41500, 72, 80), off(41600, 72), on(42100, 60, 90), off(42300, 60),
    ], 1, 42000);
    expect(notes).toEqual([{ time_ms: 100, dur_ms: 200, pitch: 60, velocity: 90 }]);
  });

  it('anche i control change seguono l\'istante del "Go"', () => {
    const { control_changes } = toPerformance([cc(42100, 64, 127), cc(41500, 64, 0)], 1, 42000);
    expect(control_changes).toEqual([{ time_ms: 100, controller: 64, value: 127 }]);
  });

  it('senza origine il payload resta quello di sempre: chi manda tempi da zero non cambia', () => {
    const { notes } = toPerformance([on(0, 60, 90), off(250, 60)]);
    expect(notes).toEqual([{ time_ms: 0, dur_ms: 250, pitch: 60, velocity: 90 }]);
  });
});

describe('corpo della presa e mani dello spartito', () => {
  const perf = {
    notes: [{ time_ms: 0, dur_ms: 250, pitch: 60, velocity: 90 }],
    control_changes: [],
    tempo_factor: 2,
  };

  it('i due filtri della striscia viaggiano nel corpo di POST /', () => {
    // E' la stessa coppia di comandi della pratica: L/R scelgono la mano da
    // giudicare, D decide se la regola della dinamica entra nel verdetto.
    expect(verdictBody('<score/>', perf, { hand: 'left', dynamics: false }))
      .toEqual({
        score: '<score/>', ...perf, hand: 'left', dynamics: false,
      });
  });

  it('senza scelte la presa e\' intera e la dinamica si giudica', () => {
    const body = verdictBody('<score/>', perf);
    expect(body.hand).toBe('both');
    expect(body.dynamics).toBe(true);
  });

  it('legge il riassunto delle mani da /hands', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hands: { right: 128, left: 88, unknown: 0, split: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchHands('<score/>')).resolves
      .toEqual({ right: 128, left: 88, unknown: 0, split: true });
    expect(fetchMock.mock.calls[0][0]).toContain('/hands');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ score: '<score/>' });
    vi.unstubAllGlobals();
  });

  it('se /hands non risponde non inventa mani: null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    await expect(fetchHands('<score/>')).resolves.toBeNull();
    vi.unstubAllGlobals();
  });
});