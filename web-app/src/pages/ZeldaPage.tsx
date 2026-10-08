import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '../hooks/useVerdict';
import type { VerdictMap } from '../hooks/useVerdict';
import { METRIC_LABELS } from '../metrics';
import {
  ZELDA_PERFORMANCE,
  ZELDA_SCORE_URL,
  ZELDA_TEMPO_FACTOR,
  ZELDA_WRITTEN_MS,
  ZELDA_WRITTEN_REPEAT_MS,
} from '../data/zelda-performance';
import './ZeldaPage.css';
import './ScorePage.css';

/**
 * Pagina dimostrativa, interamente scritta a mano: lo spartito di "The Great
 * Fairy Fountain" (Zelda) e una esecuzione registrata vera sono embedded, non
 * arrivano da upload né da MIDI live. L'unica interazione è il bottone che
 * manda l'esecuzione al servizio RML e mostra i sette verdetti.
 *
 * Il verdetto non si calcola qui: si trasporta la richiesta e si legge la
 * risposta, come fa useVerdict per la prova dal vivo.
 */

type Status = 'idle' | 'working' | 'done' | 'error';

const { notes, control_changes } = ZELDA_PERFORMANCE;

const VEL_MIN = Math.min(...notes.map((n) => n.velocity));
const VEL_MAX = Math.max(...notes.map((n) => n.velocity));
const DURATION_S = (notes[notes.length - 1].time_ms + notes[notes.length - 1].dur_ms) / 1000;

/** Curva velocity/tempo della registrazione: i valori sono quelli realmente suonati. */
function VelocityChart() {
  const points = notes
    .map((n) => {
      const x = (n.time_ms / (DURATION_S * 1000)) * 480;
      const y = 120 - (n.velocity / 127) * 110;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <figure className="zelda-chart">
      <figcaption>
        Velocity delle {notes.length} note registrate, da {VEL_MIN} a {VEL_MAX} — seguono le
        dinamiche scritte nello spartito (p → f)
      </figcaption>
      <svg viewBox="0 0 480 120" role="img" aria-label="Curva della velocity nel tempo">
        <polyline
          points={points}
          fill="none"
          stroke="var(--accent-primary, #C5A880)"
          strokeWidth="1.5"
        />
      </svg>
    </figure>
  );
}

const ZeldaPage: React.FC = () => {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [scoreXml, setScoreXml] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [verdicts, setVerdicts] = useState<VerdictMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(ZELDA_SCORE_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`spartito non trovato (${r.status})`);
        return r.text();
      })
      .then(setScoreXml)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // OSMD è già una dipendenza, ma pesa: si carica solo quando serve, come il
  // player nella pagina della prova.
  useEffect(() => {
    if (!scoreXml || !sheetRef.current) return;
    let destroyed = false;
    void (async () => {
      try {
        const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
        const osmd = new OpenSheetMusicDisplay(sheetRef.current!, {
          backend: 'svg',
          autoResize: true,
        });
        await osmd.load(scoreXml);
        if (destroyed) return;
        osmd.render();
      } catch (err) {
        console.error('[ZeldaPage] rendering dello spartito:', err);
      }
    })();
    return () => {
      destroyed = true;
    };
  }, [scoreXml]);

  const askMonitor = useCallback(async () => {
    setStatus('working');
    setError(null);
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          score: scoreXml,
          notes,
          control_changes,
          tempo_factor: ZELDA_TEMPO_FACTOR,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? `il servizio ha risposto ${response.status}`);
      }
      setVerdicts(payload.verdicts as VerdictMap);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [scoreXml]);

  return (
    <div className="zelda-page">
      <header className="zelda-head">
        <h1 className="heading">Zelda — The Great Fairy Fountain</h1>
        <p>
          Demo con spartito (con dinamiche) ed esecuzione già registrata: valori
          reali di una prova al pianoforte, non simulati. Il bottone la manda al
          monitor RML e restituisce i verdetti.
        </p>
        <p className="verdict-note">
          Lo spartito al tempo scritto (155 BPM) dura {(ZELDA_WRITTEN_MS / 1000).toFixed(1)} s,
          {' '}{(ZELDA_WRITTEN_REPEAT_MS / 1000).toFixed(1)} s col ritornello. La registrazione
          qui sotto è una prova reale suonata al 129% del tempo scritto: dura{' '}
          {(DURATION_S).toFixed(1)} s.
        </p>
      </header>

      <ul className="zelda-stats">
        <li>
          <span className="zelda-stat-value">{notes.length}</span>
          <span className="zelda-stat-label">note registrate</span>
        </li>
        <li>
          <span className="zelda-stat-value">{(DURATION_S).toFixed(1)} s</span>
          <span className="zelda-stat-label">durata registrazione</span>
        </li>
        <li>
          <span className="zelda-stat-value">
            {VEL_MIN}–{VEL_MAX}
          </span>
          <span className="zelda-stat-label">velocity</span>
        </li>
        <li>
          <span className="zelda-stat-value">{control_changes.length}</span>
          <span className="zelda-stat-label">eventi pedale</span>
        </li>
      </ul>

      <VelocityChart />

      <div className="zelda-sheet" ref={sheetRef} />

      <div className="zelda-actions">
        <button
          className="btn btn-primary"
          onClick={() => void askMonitor()}
          disabled={!scoreXml || status === 'working'}
        >
          {status === 'working' ? 'Verifica in corso…' : 'Invia al monitor'}
        </button>
        <p className="zelda-coldstart">
          Il servizio su Render si addormenta: il primo verdetto può richiedere ~1 minuto.
        </p>
      </div>

      {status !== 'idle' && (
        <section className="verdict-panel">
          <div className="verdict-panel-head">
            <h2 className="heading">Il verdetto</h2>
            {status === 'done' && (
              <button
                className="btn btn-outline"
                onClick={() => {
                  setStatus('idle');
                  setVerdicts(null);
                }}
              >
                Chiudi
              </button>
            )}
          </div>
          {status === 'working' && (
            <p className="verdict-note">Allineamento e verifica delle sette regole…</p>
          )}
          {status === 'error' && <p className="verdict-note verdict-error">{error}</p>}
          {status === 'done' && verdicts && (
            <>
              <p className="verdict-note">{notes.length} note analizzate</p>
              {verdicts['syncopated-pedal'] && !verdicts['syncopated-pedal'].ok && (
                <p className="verdict-note">
                  Il pedale sincopato suona la nota e preme subito dopo: la specifica
                  riscritta (nel repository, non ancora sul servizio) accetta questa
                  esecuzione — verificato in locale, exit 0. Il servizio deployato
                  compila ancora la versione precedente, che la conta come violazione.
                </p>
              )}
              <ul className="verdict-list">
                {Object.entries(verdicts).map(([key, v]) => (
                  <li key={key} className={v.ok ? 'verdict-ok' : 'verdict-bad'}>
                    <span className="verdict-mark">{v.ok ? '✓' : '✗'}</span>
                    <span className="verdict-name">{METRIC_LABELS[key] ?? key}</span>
                    <span className="verdict-detail">{v.ok ? 'conforme' : 'violata'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
};

export default ZeldaPage;
