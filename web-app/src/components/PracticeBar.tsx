import React from 'react';
import './PracticeBar.css';
import { Piano } from 'lucide-react';
import { handSelection, noteName } from '../hooks/practiceSteps';
import type { HandsSwitch, StepProblem, StepStatus } from '../hooks/practiceSteps';
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
 * COSA E' CADUTO DALLA RIGA, E DOVE E' FINITO. Il contatore dei passi (1/128) e
 * quello dei tasti (0/2) non compaiono piu': al loro posto c'e' il pulsante a forma
 * di pianoforte, che apre la tastiera dove i tasti del passo si accendono. Il
 * numero non diceva quale tasto fosse, il disegno si. Tutte le informazioni tolte
 * dalla vista (passo, battuta, nomi dei tasti, quante note dell'altro rigo sono
 * state ignorate, le regole sospese) stanno ora nel `title` di quel pulsante: un
 * titolo si legge una volta, un pannello se ne paga l'altezza a ogni passo.
 *
 * PRESENTAZIONALE, come quello che sostituisce: non decide niente, non chiama il
 * servizio. Il testo del verdetto compatto lo ha gia' deciso `stepProblem` nel
 * modulo puro (dove viene provato dai test), e la completezza dei tasti arriva gia'
 * calcolata in `status`.
 *
 * TUTTO CIO' CHE SI LEGGE E' IN INGLESE, titoli compresi: dal 2026-11-04 e' una
 * regola di chi usa l'app, non una preferenza di stile (vedi `User Preferences` in
 * ../../AGENTS.md). I commenti qui restano italiani perche' li legge chi mantiene.
 */

export interface PracticeBarProps {
  stepIndex: number;
  total: number;
  measure: number;
  /** i tasti che questo passo chiede — finiscono nel `title` e nella tastiera */
  expected: number[];
  /** lo stato locale del passo corrente, o null se riguarda un altro passo */
  status: StepStatus | null;
  /** la riga gia' decisa da `stepProblem`: tono, testo, e se il verdetto e' vecchio */
  problem: StepProblem;
  /** a quale passo appartiene l'ultimo verdetto ricevuto, per dirlo nel tooltip */
  verdictStep: number;
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
  /** le regole che qui non si applicano, con il loro motivo */
  suspended: Record<string, string>;
  error: string | null;
}

const PracticeBar: React.FC<PracticeBarProps> = ({
  stepIndex, total, measure, expected, status, problem, verdictStep, judging, hands,
  handsOn, onHandToggle, handsOff, dynamicsOn, onDynamicsChange, keyboardOpen, onKeyboardToggle, suspended, error,
}) => {
  const altraMano = status?.other_hand ?? [];
  const estranee = status?.extra ?? [];

  // Il titolo del pulsante tastiera porta dentro tutto quello che la riga ha smesso
  // di mostrare. E' lo stesso principio del pannello sospeso: l'informazione non
  // deve essere visibile, deve essere disponibile — e un titolo non ruba centimetri
  // alla partitura, che e' la cosa per cui lo spazio serve.
  const perche = Object.entries(suspended)
    .map(([nome, motivo]) => `${nome}: ${motivo}`)
    .join('\n');
  const passo = [
    total > 0 ? `Step ${stepIndex + 1} of ${total}` : '',
    measure > 0 ? `bar ${measure}` : '',
    expected.length > 0 ? `press ${expected.map((p) => noteName(p)).join(', ')}` : '',
    altraMano.length > 0
      ? `Ignored and not judged: ${altraMano.length} note${altraMano.length > 1 ? 's' : ''} of the other staff`
      : '',
    estranee.length > 0
      ? `Pressed but not asked for: ${estranee.map((p) => noteName(p)).join(', ')}`
      : '',
  ].filter(Boolean).join(' · ');
  const titoloTastiera = [
    keyboardOpen
      ? 'Hide the keyboard.'
      : 'Show the keyboard: the keys of this step light up, middle C is marked.',
    passo,
    perche ? `\nNot judged in this mode:\n${perche}` : '',
  ].filter(Boolean).join('\n');

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
  const entrambe = rightNotes && leftNotes;
  // Esattamente un rigo con delle note: allora la lettera dell'altro non ha
  // niente da accendere, e disegnarla vuol dire offrire un tocco che non fa
  // niente. Si mostra una sola, e il perche' sta nel titolo.
  const unaSola = hands !== null && rightNotes !== leftNotes;
  const manoUnica = rightNotes && !leftNotes ? 'right'
    : leftNotes && !rightNotes ? 'left' : null;

  const percheMani = hands === null
    ? 'Waiting to learn whether this score separates the hands.'
    : entrambe
      ? 'L and R are switches, each on its own: lit means that hand takes part, grey means it is off — its staff is not asked for, does not stop the cursor and is not judged. Press a letter to switch just that hand. Both letters on: the whole piece; both off: nothing is asked until one goes back on.'
      : unaSola
        // Un pulsante spento che non puo' fare niente deve dire perche': uguale a
        // uno che non c'e', tranne per lo spazio che occupa.
        ? `This score has only the ${manoUnica} staff: there is nothing to exclude. Its letter switches the exercise off and on; with it off, nothing is asked or judged.`
        : 'This file does not declare staves, so there is no right or left hand to isolate: the whole piece is practised.';

  // Le note senza rigo riconosciuto restano nell'esercizio con qualsiasi mano: dirlo
  // qui, perche' altrimenti un esercizio "a mano destra" che chiede comunque una nota
  // fuori dai due righi sembra un bug.
  const senzaRigo = hands !== null && hands.unknown > 0
    ? ` ${hands.unknown} notes declare no staff: they stay in the exercise with either hand.`
    : '';

  // Nessun "premi per scegliere": qui ogni lettera vale per la propria mano e
  // basta. L'accensione dell'altra non spegne questa, e lo stato in pausa ha
  // una riga sua, non un terzo pulsante.

  return (
    <section className="practice-bar" aria-label="Practice controls">
      <span className="pb-left">
        {/* Il pulsante che apre la tastiera: e' lui il contatore dei tasti, adesso. */}
        <button
          id="bar-keys-btn"
          className={`pb-icon${keyboardOpen ? ' pb-icon-on' : ''}`}
          onClick={onKeyboardToggle}
          aria-pressed={keyboardOpen}
          aria-label="Show the keyboard for this step"
          title={titoloTastiera}
        >
          <Piano size={16} aria-hidden="true" />
        </button>

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
            title={problem.stale
              ? `This verdict belongs to step ${verdictStep + 1}; you are already on step ${stepIndex + 1}.`
              : error ?? 'The RML verdict on this step'}
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
          title={`${percheMani}${entrambe ? senzaRigo : ''}`}
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
          title={dynamicsOn
            ? 'Dynamics is being watched too: the velocity is compared with the dynamics written in the score.'
            // Spento deve dire cosa non si guarda piu', non limitarsi a spegnersi.
            : 'Dynamics off: it is no longer shown among the step problems. The notes are still checked, and the service keeps judging dynamics anyway.'}
        >
          D
        </button>
      </span>
    </section>
  );
};

export default PracticeBar;
