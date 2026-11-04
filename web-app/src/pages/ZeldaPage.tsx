import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '../hooks/useVerdict';
import type { VerdictMap } from '../hooks/useVerdict';
import {
  ZELDA_PERFORMANCE,
  ZELDA_SCORE_URL,
  ZELDA_TEMPO_FACTOR,
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

const ZeldaPage: React.FC = () => {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [scoreXml, setScoreXml] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [verdicts, setVerdicts] = useState<VerdictMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(ZELDA_SCORE_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`score not found (${r.status})`);
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
        throw new Error(payload?.error ?? `the service responded with ${response.status}`);
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
      <div className="zelda-sheet" ref={sheetRef} />

      <div className="zelda-actions">
        <button
          className="btn btn-primary"
          onClick={() => void askMonitor()}
          disabled={!scoreXml || status === 'working'}
        >
          {status === 'working' ? 'Checking…' : 'Send to monitor'}
        </button>
        <p className="zelda-coldstart">
          The Render service falls asleep: the first verdict can take about a minute.
        </p>
      </div>

      {status !== 'idle' && (
        <section className="verdict-panel">
          <div className="verdict-panel-head">
            <h2 className="heading">Verdicts</h2>
            {status === 'done' && (
              <button
                className="btn btn-outline"
                onClick={() => {
                  setStatus('idle');
                  setVerdicts(null);
                }}
              >
                Close
              </button>
            )}
          </div>
          {status === 'working' && (
            <p className="verdict-note">Aligning the performance and checking the seven rules…</p>
          )}
          {status === 'error' && <p className="verdict-note verdict-error">{error}</p>}
          {status === 'done' && verdicts && (
            <>
              <p className="verdict-note">{notes.length} notes analysed</p>
              {verdicts['syncopated-pedal'] && !verdicts['syncopated-pedal'].ok && (
                <p className="verdict-note">
                  The syncopated pedal sounds the note and presses right after it: the
                  rewritten spec (in the repository, not yet on the service) accepts
                  this performance — verified locally, exit 0. The deployed service
                  still compiles the previous version, which counts it as violated.
                </p>
              )}
              <ul className="verdict-list">
                {Object.entries(verdicts).map(([key, v]) => (
                  <li key={key} className={v.ok ? 'verdict-ok' : 'verdict-bad'}>
                    <span className="verdict-mark">{v.ok ? '✓' : '✗'}</span>
                    <span className="verdict-name">{key}</span>
                    <span className="verdict-detail">{v.ok ? 'passed' : 'violated'}</span>
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
