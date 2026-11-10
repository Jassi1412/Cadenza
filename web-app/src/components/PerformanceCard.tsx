import React, { useEffect, useState } from 'react';
import './PerformanceCard.css';
import type { ScoreOutcome } from '../hooks/scoreMarks';

/**
 * IL VERDETTO ORA È UN NUMERO, E STA DAVANTI AGLI OCCHI.
 *
 * Fino al 2026-11-10 la fine della prova finiva in un riquaccio sotto la partitura:
 * righe di testo che spiegavano quali regole erano cascate e dove. L'allievo che
 * ha appena finito di suonare non vuole leggere quelle righe — vuole sapere
 * COM'È ANDATA, un numero, adesso, nel punto dello schermo che sta guardando.
 * Così è nato questo componente: un'unica carta centrata sul viewport (la stessa
 * lezione del countdown: ciò che deve essere letto subito galleggia su ciò che
 * si sta già guardando, non in fondo a 250 m di documento) con il punteggio che
 * sale da 0 al suo valore.
 *
 * Il numero NON è deciso qui: viene da `performanceScore` nel modulo puro
 * (`hooks/scoreMarks.ts`, provato da alignment/run_scoremarks_tests.mjs). Questa
 * carta anima e mostra, e nient'altro — le righe di dettaglio glielo passano
 * già scritte in inglese, come in tutto il resto dell'app (User Preferences in
 * ../../AGENTS.md).
 */

export interface PerformanceCardProps {
  /** il momento della prova: richiesta in volo, errore, o verdetto arrivato */
  status: 'working' | 'error' | 'done';
  /** il messaggio dell'errore, quando status è 'error' */
  error?: string | null;
  /** il verdetto della metrica pura; null finché non è arrivato o se nulla era giudicabile */
  outcome: ScoreOutcome | null;
  /** le righe di dettaglio già pronte (`summaryLines`): macchie rosse, caveat */
  lines: string[];
  onClose: () => void;
  onPlayAgain: () => void;
}

/** Quanto dura la salita del numero. Abbastanza da seguirla, troppo poco da aspettare. */
const COUNT_MS = 1100;

/**
 * La salita 0 → valore con l'ultimo pezzo più lento (ease-out cubic): il numero
 * sembra arrivare da solo e atterra senza scatto. Con le animazioni ridotte la
 * prima fotogramma scrive già il valore finale — il movimento è una scorciatoia
 * per l'occhio, non l'informazione, e qui la regola del repo sui setState negli
 * effetti chiede pure che nessun setState cada nel corpo dell'effetto: tutto
 * passa dal callback di requestAnimationFrame.
 */
function useCountUp(target: number | null): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (target === null) return; // nessun voto da mostrare: niente animazione, niente stato
    const dur = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : COUNT_MS;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(dur === 0 ? 1 : (t - t0) / dur, 1);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return n;
}

/** La tinta del numero segue lo stesso linguaggio di colori di tutta l'app. */
function band(score: number | null): 'good' | 'fair' | 'poor' | 'none' {
  if (score === null) return 'none';
  if (score >= 85) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}

const PerformanceCard: React.FC<PerformanceCardProps> = ({
  status, error, outcome, lines, onClose, onPlayAgain,
}) => {
  const shown = useCountUp(status === 'done' && outcome ? outcome.score : null);
  const tone = band(status === 'done' && outcome ? outcome.score : null);

  return (
    <div className="pc-layer" role="dialog" aria-label="Performance score" aria-modal="false">
      <div className={`pc-card pc-${tone}`}>
        {status === 'working' && (
          <div className="pc-status">
            <span className="pc-dot" aria-hidden="true" />
            Aligning the performance and checking the seven rules…
          </div>
        )}

        {status === 'error' && (
          <>
            <p className="pc-error">{error}</p>
            <button className="btn btn-outline pc-btn" onClick={onClose}>Close</button>
          </>
        )}

        {status === 'done' && (
          <>
            <p className="pc-caption">your performance</p>
            {outcome && outcome.score !== null ? (
              <p className="pc-score" aria-live="polite">
                {shown}
                <span className="pc-of">/100</span>
              </p>
            ) : (
              // exit 2 su ogni regola: nessun monitor è partito. Dire 100 sarebbe
              // "tutto perfetto", dire 0 "hai suonato male": nessuna delle due.
              <p className="pc-none" aria-live="polite">Nothing could be judged</p>
            )}
            {lines.map((line) => (
              <p key={line} className="pc-line">{line}</p>
            ))}
            <div className="pc-actions">
              <button className="btn btn-outline" onClick={onClose}>Close</button>
              <button className="btn btn-primary" onClick={onPlayAgain}>Play again</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default PerformanceCard;
