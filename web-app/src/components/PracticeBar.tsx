import React from 'react';
import './PracticeBar.css';
import { Piano } from 'lucide-react';
import { handSelection } from '../hooks/practiceSteps';
import type { HandsSwitch, StepProblem } from '../hooks/practiceSteps';
import type { HandInfo } from '../hooks/usePractice';

/**
 * La barra dei comandi della modalita' practice: una riga sola, sopra la pillola
 * del trasporto.
 *
 * PERCHE' UNA RIGA E NON IL PANNELLO. Il pannello in alto era arrivato a due
 * colonne, ai nomi delle note, all'elenco dei verdetti regola per regola e alle tre
 * regole sospese con il loro motivo: chiuso, 207 px; aperto, 471. Copriva mezza
 * partitura mentre la cosa che serve guardare insieme e' il cursore sul rigo e il
 * tasto sulla tastiera. Chi usa l'app ha chiesto il minimo.
 *
 * NIENTE PIU' TOOLTIP NATIVI (2026-11-10). Tutto quello che la riga ha tolto
 * dalla vista stava nel `title` del pulsante tastiera, e i `title` sono quei
 * rettolini grigi del browser che compaiono mezzo secondo dopo il mouse: chi
 * usa l'app li ha eliminati per tutti i comandi della striscia — pianoforte,
 * L, R, D. Da qui la regola: la riga NON mette informazioni nei tooltip; quel
 * che serve si guarda sulla tastiera disegnata (i tasti d'oro sono i tasti da
 * premere, la scritta "PRESS x" gia' lo dice) o si capisce dal colore dei tasti
 * stessi. I nomi restano negli `aria-label`, che non hanno rettangolo e li
 * leggono gli screen reader.
 *
 * PRESENTAZIONALE, come quello che sostituisce: non decide niente, non chiama il
 * servizio. Il testo del verdetto compatto lo ha gia' deciso `stepProblem` nel
 * modulo puro (dove viene provato dai test), e ogni colore dei tasti arriva gia'
 * calcolato dal piano locale.
 *
 * TUTTO CIO' CHE SI LEGGE E' IN INGLESE, perche' dal 2026-11-04 e' una regola di
 * chi usa l'app, non una preferenza di stile (vedi `User Preferences` in
 * ../../AGENTS.md). I commenti qui restano italiani perche' li legge chi mantiene.
 */

export interface PracticeBarProps {
  /** la riga gia' decisa da `stepProblem`: tono, testo, e se il verdetto e' vecchio */
  problem: StepProblem;
  judging: boolean;
  /** che cosa questo spartito permette di separare; null finche' non si e' risposto */
  hands: HandInfo | null;
  /** i due interruttori delle mani, nello stato lasciato da chi suona */
  handsOn: HandsSwitch;
  /** schiacciare una lettera cambia SOLO quell'interruttore */
  onHandToggle: (hand: 'left' | 'right') => void;
  /** spenti tutti gli interruttori disegnati: l'esercizio e' in pausa */
  handsOff: boolean;
  dynamicsOn: boolean;
  onDynamicsChange: (on: boolean) => void;
  /** la tastiera di richiamo e' aperta: il pulsante e' premuto e la tastiera sta sopra */
  keyboardOpen: boolean;
  onKeyboardToggle: () => void;
  /**
   * Nella PRESA INTERA la striscia c'e' ma il pulsante della tastiera no: li' non
   * c'e' nessun passo da accendere, e una tastiera senza passo sarebbe un disegno
   * che mente. Default true: la pratica lo mostra sempre.
   */
  showKeyboardToggle?: boolean;
}

const PracticeBar: React.FC<PracticeBarProps> = ({
  problem, judging, hands, handsOn, onHandToggle, handsOff,
  dynamicsOn, onDynamicsChange, keyboardOpen, onKeyboardToggle,
  showKeyboardToggle = true,
}) => {
  // ── I due pulsanti della mani, L e R: DUE INTERRUTTORI ──
  // Dal 2026-11-07 le lettere non "scelgono" piu' una mano: ognuna ACCENDE o
  // SPEGNE la propria, indipendentemente dall'altra. Accese tutte e due = brano
  // intero; spente tutte e due = pausa voluta, con la riga che lo dice. La
  // formula di questo bivio sta in `handSelection` (modulo puro, provato su
  // node): la striscia lo consulta per sapere quali lettere disegnare, la
  // pagina per sapere quale mano chiedere al servizio. La stessa formula, due
  // consultazioni: non puo' divergere.
  const sel = handSelection(hands, handsOn);
  const rightNotes = hands !== null && hands.right > 0;
  const leftNotes = hands !== null && hands.left > 0;
  // Esattamente un rigo con delle note: allora la lettera dell'altro non ha
  // niente da accendere, e disegnarla vuol dire offrire un tocco che non fa
  // niente. Si mostra una sola, e il perche' lo dice la riga di pausa, non un
  // tooltip da inseguire col mouse.
  const unaSola = hands !== null && rightNotes !== leftNotes;
  const manoUnica = rightNotes && !leftNotes ? 'right'
    : leftNotes && !rightNotes ? 'left' : null;

  return (
    <section className="practice-bar" aria-label="Practice controls">
      <span className="pb-left">
        {/* Il pulsante che apre la tastiera: e' lui il contatore dei tasti, adesso. */}
        {showKeyboardToggle && (
          <button
            id="bar-keys-btn"
            className={`pb-icon${keyboardOpen ? ' pb-icon-on' : ''}`}
            onClick={onKeyboardToggle}
            aria-pressed={keyboardOpen}
            aria-label="Show the keyboard for this step"
          >
            <Piano size={16} aria-hidden="true" />
          </button>
        )}

        {/* Il verdetto compatto: una parola, e nessuna parola quando non c'e' ancora
            niente da dire. `judging` non scrive "verifico…": lo dice il punto che
            pulsa. La scritta tolta era la stessa ragione per cui chi suona ha chiesto
            la riga minima. */}
        {/* Con le mani tutte spente la riga dice PERCHE' non succede niente:
            un silenzio muto su una scelta fatta a metà sembra un guasto. Il
            punto colorato qui non c'è: non sta volando nessuna richiesta, e
            il punto che pulsa mentirebbe. */}
        {handsOff ? (
          <span className="pb-problem pb-paused" id="practice-problem">
            {unaSola
              ? `The ${manoUnica} staff is switched off — press ${manoUnica === 'left' ? 'L' : 'R'} to continue`
              : 'Both hands are switched off — press L or R to continue'}
          </span>
        ) : (problem.text || judging) && (
          <span
            className={`pb-problem pb-${problem.tone}${problem.stale ? ' pb-stale' : ''}`}
            id="practice-problem"
          >
            {problem.text ? (
              <>
                <span className="pb-dot" aria-hidden="true" />
                {problem.text}
              </>
            ) : (
              /* Nessun verdetto da mostrare: resta il solo punto, che pulsa perche'
                 la richiesta e' in volo. Una parola d'attesa era rumore. */
              <span className="pb-dot" aria-hidden="true" />
            )}
          </span>
        )}
      </span>

      {/* I comandi a destra: le due mani e la dinamica, come lettere. */}
      <span className="pb-controls">
        <span
          className="pb-seg" role="group" aria-label="Hands to practise"
        >
          {sel.showLeft && (
            <button
              id="bar-hand-left"
              className={`pb-chip${handsOn.left ? ' pb-chip-on' : ' pb-chip-off'}`}
              onClick={() => onHandToggle('left')}
              aria-pressed={handsOn.left}
              aria-label="Left hand"
            >
              L
            </button>
          )}
          {sel.showRight && (
            <button
              id="bar-hand-right"
              className={`pb-chip${handsOn.right ? ' pb-chip-on' : ' pb-chip-off'}`}
              onClick={() => onHandToggle('right')}
              aria-pressed={handsOn.right}
              aria-label="Right hand"
            >
              R
            </button>
          )}
        </span>

        <button
          id="bar-dyn-btn"
          className={`pb-chip${dynamicsOn ? ' pb-chip-on' : ''}`}
          onClick={() => onDynamicsChange(!dynamicsOn)}
          aria-pressed={dynamicsOn}
          aria-label="Dynamics"
        >
          D
        </button>
      </span>
    </section>
  );
};

export default PracticeBar;
