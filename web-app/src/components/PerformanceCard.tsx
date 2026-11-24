import React, { useEffect, useState } from 'react';
import './PerformanceCard.css';
import type { ScoreOutcome } from '../hooks/scoreMarks';
import { VERDICT_INFO } from '../data/verdicts-en';
import type { VerdictMap } from '../hooks/useVerdict';

/**
 * IL VERDETTO È UN NUMERO, E SOTTO CI SONO LE SETTE REGOLE.
 *
 * Fino al 2026-11-10 la fine della prova finiva in un riquadro sotto la partitura:
 * righe di testo che spiegavano quali regole erano cascate e dove. L'allievo che
 * ha appena finito di suonare non vuole leggere quelle righe — vuole sapere
 * COM'È ANDATA, un numero, adesso, nel punto dello schermo che sta guardando.
 * Così è nato questo componente: un'unica carta centrata sul viewport (la stessa
 * lezione del countdown: ciò che deve essere letto subito galleggia su ciò che
 * si sta già guardando, non in fondo a 250 m di documento) con il punteggio che
 * sale da 0 al suo valore.
 *
 * Il 2026-11-21 l'utente ha chiesto di riportare dentro la carta i verdetti, uno
 * per regola, con il loro esito, cliccabili, e con una spiegazione in inglese di
 * cosa fa la regola, cosa misura e con quali dati. Le spiegazioni vivono in
 * `data/verdicts-en.ts` — un solo posto, scritto dalle specifiche RML e non
 * reinventato qui. Questa carta mostra e apre; non decide niente.
 *
 * Il numero NON è deciso qui: viene da `performanceScore` nel modulo puro
 * (`hooks/scoreMarks.ts`, provato da alignment/run_scoremarks_tests.mjs).
 */

export interface PerformanceCardProps {
  /** il momento della prova: richiesta in volo, errore, o verdetto arrivato */
  status: 'working' | 'error' | 'done';
  /** il messaggio dell'errore, quando status è 'error' */
  error?: string | null;
  /** il verdetto della metrica pura; null finché non è arrivato o se nulla era giudicabile */
  outcome: ScoreOutcome | null;
  /** i verdetti delle sette regole, come li ha restituiti il servizio */
  verdicts?: VerdictMap | null;
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

/**
 * L'esito di una regola, in una parola. `exit` è a tre valori e non va appiattito:
 * 0 conforma, 1 è violata, 2 è il monitor che non è partito — dire "violated"
 * quando il servizio è rotto accusa chi ha suonato.
 */
function outcomeOf(exit: unknown): { word: string; tone: 'pass' | 'fail' | 'broken' } {
  const n = Number(exit);
  if (n === 0) return { word: 'conforms', tone: 'pass' };
  if (n === 2) return { word: 'not judged', tone: 'broken' };
  return { word: 'violated', tone: 'fail' };
}

const PerformanceCard: React.FC<PerformanceCardProps> = ({
  status, error, outcome, verdicts, onClose, onPlayAgain,
}) => {
  const shown = useCountUp(status === 'done' && outcome ? outcome.score : null);
  const tone = band(status === 'done' && outcome ? outcome.score : null);
  const [openRow, setOpenRow] = useState<string | null>(null);

  // Le regole che il servizio non ha restituito restano fuori: una riga inventata
  // sarebbe una promozione, e le due sospese (una mano sola, dinamica spenta)
  // arrivano dichiarate altrove, non come verdetto.
  const rows = status === 'done' && verdicts
    ? VERDICT_INFO.filter(info => info.key in verdicts)
    : [];

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
            {outcome && outcome.score !== null ? (
              <p className="pc-score" aria-live="polite">{shown}</p>
            ) : (
              // exit 2 su ogni regola: nessun monitor è partito. Dire 100 sarebbe
              // "tutto perfetto", dire 0 "hai suonato male": nessuna delle due.
              <p className="pc-none" aria-live="polite">Nothing could be judged</p>
            )}

            {rows.length > 0 && (
              <ul className="pc-rules">
                {rows.map(info => {
                  const v = verdicts?.[info.key];
                  const { word, tone: rowTone } = outcomeOf(v?.exit);
                  const open = openRow === info.key;
                  return (
                    <li key={info.key} className={`pc-rule pc-rule-${rowTone}`}>
                      <button
                        type="button"
                        className="pc-rule-head"
                        aria-expanded={open}
                        onClick={() => setOpenRow(open ? null : info.key)}
                      >
                        <span className="pc-rule-name">{info.name}</span>
                        <span className="pc-rule-word">{word}</span>
                        <span className="pc-rule-caret" aria-hidden="true">{open ? '−' : '+'}</span>
                      </button>
                      {open && (
                        <div className="pc-rule-body">
                          <p>{info.does}</p>
                          <p className="pc-rule-label">What it measures</p>
                          <p>{info.measures}</p>
                          <p className="pc-rule-label">Data it reads</p>
                          <p>{info.data}</p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

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
