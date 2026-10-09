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
      </header>

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
                    <span className="verdict-name">{key}</span>
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
