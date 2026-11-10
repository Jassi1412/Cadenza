import React, { useLayoutEffect, useRef } from 'react';
import './ErrorHoverCard.css';
import type { MarkTip } from '../hooks/scoreMarks';

/**
 * Cosa c'è sotto una nota rossa. Il rettangolo nativo del browser — quel
 * `<title>` grigio che appariva per una frazione e che chi usa l'app il
 * 2026-11-10 ha definito "brutto" — è morto: questa è la card vera, nella
 * pelle del tema, che compare mentre il mouse sta sulla nota.
 *
 * Presentazionale pura: le righe le ha già decise `markTipFor` nel modulo puro
 * (`hooks/scoreMarks.ts`) — una riga per ogni regola caduta su QUELLA nota, con
 * i numeri premuto/scritto dove il servizio li ha davvero. Qui si aggiunge solo
 * la geometria: il bordo non deve uscire dallo schermo, perché un tooltip a
 * metà fuori è peggio di niente.
 */

export interface ErrorHoverCardProps {
  tip: MarkTip;
  /** il punto del puntatore, in coordinate del viewport */
  x: number;
  y: number;
}

const OFFSET = 14; // distanza dal puntatore: la mano non copre quello che legge
const EDGE = 8;    // margine minimo dal bordo dello schermo

const ErrorHoverCard: React.FC<ErrorHoverCardProps> = ({ tip, x, y }) => {
  const ref = useRef<HTMLDivElement>(null);

  // La posizione definitiva si scrive SUL NODO, nel layout effect, prima che
  // il browser dipinga: misurare e rimandare in uno stato significherebbe un
  // secondo render per soli due numeri di css (e la regola del repo sui setState
  // negli effetti lo dice forte). Così non c'è flusso da innescare: il primo
  // frame della card è già quello giusto, con i bordi rincappati.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let left = x + OFFSET;
    let top = y + OFFSET;
    if (left + el.offsetWidth > window.innerWidth - EDGE) left = x - el.offsetWidth - OFFSET;
    if (top + el.offsetHeight > window.innerHeight - EDGE) top = y - el.offsetHeight - OFFSET;
    el.style.left = `${Math.max(EDGE, left)}px`;
    el.style.top = `${Math.max(EDGE, top)}px`;
  }, [tip, x, y]);

  return (
    <div ref={ref} className="ehc-card" role="tooltip">
      <p className="ehc-where">measure {tip.measure} · beat {Math.round(tip.beat * 100) / 100}</p>
      {tip.lines.map((line) => (
        <div className="ehc-line" key={line.rule}>
          <span className="ehc-rule">{line.rule}</span>
          {line.detail && <span className="ehc-values">{line.detail}</span>}
        </div>
      ))}
    </div>
  );
};

export default ErrorHoverCard;
