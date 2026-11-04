import React from 'react';
import './PracticeBar.css';
import { Piano } from 'lucide-react';
import { noteName } from '../hooks/practiceSteps';
import type { StepProblem, StepStatus } from '../hooks/practiceSteps';
import type { HandInfo, PracticeHand } from '../hooks/usePractice';

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
  hand: PracticeHand;
  /** che cosa questo spartito permette di separare; null finche' non si e' risposto */
  hands: HandInfo | null;
  onHandChange: (hand: PracticeHand) => void;
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
  stepIndex, total, measure, expected, status, problem, verdictStep, judging, hand, hands,
  onHandChange, dynamicsOn, onDynamicsChange, keyboardOpen, onKeyboardToggle, suspended, error,
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

  // ── I due pulsanti della mani, L e R ──
  // Il pezzo d'inglese "Tutte" era un terzo pulsante che diceva "tutti e due", la
  // stessa cosa che dicono i due accesi insieme: ora lo stato "tutte le mani" e'
  // semplicemente L e R entrambi premuti. Se il brano ha un solo rigo si mostra
  // quel pulsante solo, non una coppia di cui meta' non puo' fare niente.
  const rightNotes = hands !== null && hands.right > 0;
  const leftNotes = hands !== null && hands.left > 0;
  const entrambe = rightNotes && leftNotes;
  // Esattamente un rigo con delle note: allora il pulsante dell'altro non avrebbe
  // niente da escludere, e mostrarlo spento vuol dire offrire un tocco che non fa
  // niente. Si mostra uno solo, acceso, e il perche' sta nel titolo.
  const unaSola = hands !== null && rightNotes !== leftNotes;
  const manoUnica = rightNotes && !leftNotes ? 'right'
    : leftNotes && !rightNotes ? 'left' : null;

  const percheMani = hands === null
    ? 'Waiting to learn whether this score separates the hands.'
    : entrambe
      ? 'Study one staff at a time: pressing L or R picks that hand, and the other staff\'s notes are not asked for, they do not stop the cursor and they are not judged. Press the same key again to go back to both hands.'
      : unaSola
        // Un pulsante spento che non puo' fare niente deve dire perche': uguale a
        // uno che non c'e', tranne per lo spazio che occupa.
        ? `This score has only the ${manoUnica} staff: there is nothing to exclude.`
        : 'This file does not declare staves, so there is no right or left hand to isolate: the whole piece is practised.';

  // Le note senza rigo riconosciuto restano nell'esercizio con qualsiasi mano: dirlo
  // qui, perche' altrimenti un esercizio "a mano destra" che chiede comunque una nota
  // fuori dai due righi sembra un bug.
  const senzaRigo = hands !== null && hands.unknown > 0
    ? ` ${hands.unknown} notes declare no staff: they stay in the exercise with either hand.`
    : '';

  // Schiacciare un rigo LO SCELGE, non lo spegne: con tutti e due accesi, premere
  // "R" deve dare l'esercizio a mano destra, non il suo contrario. Se il rigo e'
  // gia' quello scelto, lo stesso tocco si torna a tutte e due — lo stato "tutte le
  // mani" sono i due pulsanti accesi insieme, e un terzo pulsante che lo diceva era
  // il pulsante inutile che chi usa l'app ha chiesto di togliere.
  const premiMano = (h: Exclude<PracticeHand, null>) => {
    onHandChange(hand === h ? null : h);
  };

  const acceso = (h: Exclude<PracticeHand, null>) => hand === null || hand === h;

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
        {(problem.text || judging) && (
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
          {(entrambe || manoUnica === 'left') && (
            <button
              id="bar-hand-left"
              className={`pb-chip${unaSola ? ' pb-chip-on pb-chip-stuck' : acceso('left') ? ' pb-chip-on' : ''}`}
              onClick={() => premiMano('left')}
              disabled={unaSola}
              aria-pressed={unaSola ? true : acceso('left')}
              aria-label="Left hand"
            >
              L
            </button>
          )}
          {(entrambe || manoUnica === 'right') && (
            <button
              id="bar-hand-right"
              className={`pb-chip${unaSola ? ' pb-chip-on pb-chip-stuck' : acceso('right') ? ' pb-chip-on' : ''}`}
              onClick={() => premiMano('right')}
              disabled={unaSola}
              aria-pressed={unaSola ? true : acceso('right')}
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
