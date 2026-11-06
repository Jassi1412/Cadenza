import { useCallback, useRef, useState } from 'react';
import type { MidiEvent } from './useMidi';
import type { ScoreLocation } from './scoreMarks';

export type { ScoreLocation };

/**
 * Trasforma il flusso MIDI in esecuzione da mandare al servizio, e ne legge i
 * sette verdetti. Il verdetto NON e' calcolato qui: viene da RML.
 *
 * Il servizio legge lo spartito, costruisce la mappa dei tempi da quello che e'
 * scritto e ci mette dentro le aspettazioni. Qui si fa solo trasporto.
 */

/**
 * Endpoint del servizio.
 *
 * Il default e' il servizio deployato, non 127.0.0.1: questo URL e' pubblico e
 * non e' un segreto, quindi non ha senso proteggerlo dietro una variabile
 * d'ambiente da ricordare a ogni deploy. Senza questo, dimenticare la variabile
 * significa un frontend che punta silenziosamente al portatile di chi l'ha
 * scritto, e il pannello dei verdetti fallisce solo sul computer del relatore.
 *
 * VITE_CADENZA_API resta per lo sviluppo in locale.
 */
export const API_URL =
  (import.meta.env.VITE_CADENZA_API as string | undefined) ??
  'https://cadenza-etji.onrender.com';

export interface PerformedNote {
  time_ms: number;
  dur_ms: number;
  pitch: number;
  velocity: number;
}

export interface ControlChange {
  time_ms: number;
  controller: number;
  value: number;
}

export interface Verdict {
  ok: boolean;
  exit: number;
  /**
   * I punti dello spartito che questa regola ha colto in fallo, presenti solo
   * quando exit vale 1. Li produce il servizio (batch.pl dice QUALE evento ha
   * fermato la macchina RML, server.py lo traduce in battuta e battitura): la
   * pagina ci colora di rosso le note e il tooltip sopra porta i nomi delle
   * regole. exit 2 non ha MAI posizioni: li' il servizio non ha giudicato nulla,
   * e una nota rossa sarebbe un'accusa inventata. Vedi hooks/scoreMarks.ts.
   */
  locations?: ScoreLocation[];
}

export type VerdictMap = Record<string, Verdict>;

export interface PerformancePayload {
  notes: PerformedNote[];
  control_changes: ControlChange[];
  /** ms reali per ms scritti nello spartito: 1 al tempo originale, 2 a meta' */
  tempo_factor: number;
}

/** Soglia sotto la quale una nota non e' mai stata suonata davvero. */
const MIN_DURATION_MS = 30;

/**
 * Un note-on con velocita' 0 e' un note-off. Lo strumento lo invia e Web MIDI
 * non sempre lo normalizza: se lo trattassimo come attacco, la nota resterebbe
 * premuta per sempre e il successivo note-off chiuderebbe l'attacco sbagliato.
 */
function isNoteOff(event: MidiEvent): boolean {
  return event.type === 'noteoff' || (event.type === 'noteon' && (event.rawAttack ?? 0) === 0);
}

/**
 * Accorcia gli eventi al payload del servizio.
 *
 * Le durate si ricavano accoppiando note-on e note-off dello stesso pitch. Se lo
 * stesso pitch suona due volte prima del rilascio, l'accoppiamento e' FIFO: il
 * primo note-off chiude il primo attacco.
 *
 * Una nota senza note-off (interrotta, o finita la registrazione) riceve la
 * durata fino all'ultimo evento visto. Non viene buttata: una nota premuta e
 * tenuta e' informazione, e soprattutto buttarla nasconderebbe proprio il caso
 * che la regola di legatura deve vedere.
 *
 * ponytail: i timestamp sono relativi alla pagina (DOMHighResTimeStamp).
 * L'allineatore ricava la scala dal fondo, quindi l'origine non conta. Passare
 * a tempo assoluto serve solo se un giorno dovessi confrontare due prove.
 */
export function toPerformance(
  events: readonly MidiEvent[],
  tempoFactor = 1.0,
): PerformancePayload {
  const notes: PerformedNote[] = [];
  const control_changes: ControlChange[] = [];

  /** attacchi in attesa di note-off, per pitch, in ordine di arrivo */
  const pending = new Map<number, PendingAttack[]>();
  let last = 0;

  for (const event of events) {
    last = event.timestamp;
    const pitch = event.note;

    if (event.type === 'controlchange') {
      if (event.controller === undefined || event.value === undefined) continue;
      control_changes.push({ time_ms: event.timestamp, controller: event.controller, value: event.value });
      continue;
    }

    if (pitch === undefined) continue;

    if (isNoteOff(event)) {
      const queue = pending.get(pitch);
      const attack = queue?.shift();
      if (queue && queue.length === 0) pending.delete(pitch);
      if (attack === undefined) continue; // note-off senza attacco: nulla da chiudere
      const dur = event.timestamp - attack.time_ms;
      // La nota entra anche se e' stata tenuta pochissimo.
      //
      // Qui prima c'era un filtro: sotto i 30 ms la nota non veniva registrata.
      // Ma allora non era la regola di verdetto a non segnalarla, era proprio
      // l'assenza dell'evento: nessuna soglia, dentro o fuori, poteva vederla.
      // E non era solo un caso, perche' due tasti premuti insieme a pugni chiusi
      // si presentano spesso come due note da pochi millisecondi, e quelle
      // sparivano.
      //
      // Ora il dato arriva col suo valore vero, e a confrontarlo con la soglia
      // e' la regola, che e' l'unica cosa che deve decidere quanto si puo' stare
      // sotto un tasto.
      notes.push({ time_ms: attack.time_ms, dur_ms: dur, pitch, velocity: attack.velocity });
      continue;
    }

    const queue = pending.get(pitch) ?? [];
    queue.push({ time_ms: event.timestamp, velocity: event.rawAttack ?? 64 });
    pending.set(pitch, queue);
  }

  // note mai rilasciate: durata fino all'ultimo evento
  for (const [pitch, queue] of pending) {
    for (const attack of queue) {
      notes.push({
        time_ms: attack.time_ms,
        dur_ms: Math.max(last - attack.time_ms, MIN_DURATION_MS),
        pitch,
        velocity: attack.velocity,
      });
    }
  }

  notes.sort((a, b) => a.time_ms - b.time_ms);
  control_changes.sort((a, b) => a.time_ms - b.time_ms);
  return { notes, control_changes, tempo_factor: tempoFactor };
}

interface PendingAttack {
  time_ms: number;
  velocity: number;
}

export type VerdictStatus = 'idle' | 'working' | 'done' | 'error';

export interface UseVerdictReturn {
  status: VerdictStatus;
  verdicts: VerdictMap | null;
  error: string | null;
  noteCount: number;
  analyse: (scoreXml: string, tempoFactor?: number) => Promise<void>;
  reset: () => void;
}

/**
 * @param events esecuzione completa, non troncata
 */
export function useVerdict(events: readonly MidiEvent[]): UseVerdictReturn {
  const [status, setStatus] = useState<VerdictStatus>('idle');
  const [verdicts, setVerdicts] = useState<VerdictMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteCount, setNoteCount] = useState(0);
  const busy = useRef(false);

  const analyse = useCallback(async (scoreXml: string, tempoFactor = 1.0) => {
    if (busy.current) return;
    const { notes, control_changes, tempo_factor } = toPerformance(events, tempoFactor);
    if (notes.length === 0) {
      setError('Nothing was recorded: play the piece before asking for a verdict.');
      setStatus('error');
      return;
    }
    busy.current = true;
    setStatus('working');
    setError(null);
    setNoteCount(notes.length);
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: scoreXml, notes, control_changes, tempo_factor }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? `the service responded with ${response.status}`);
      }
      setVerdicts(payload.verdicts as VerdictMap);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    } finally {
      busy.current = false;
    }
  }, [events]);

  const reset = useCallback(() => {
    setStatus('idle');
    setVerdicts(null);
    setError(null);
    setNoteCount(0);
  }, []);

  return { status, verdicts, error, noteCount, analyse, reset };
}