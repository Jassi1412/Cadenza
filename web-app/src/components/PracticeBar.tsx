import React from 'react';
import './PracticeBar.css';
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
 * tasto sulla tastiera. Chi usa l'app ha chiesto il minimo, e il minimo qui e' una
 * riga che risponde a due domande sole: "quanto manca" e "cosa ho sbagliato".
 *
 * PRESENTAZIONALE, come quello che sostituisce: non decide niente, non chiama il
 * servizio. Il testo del verdetto compatto lo ha gia' deciso `stepProblem` nel
 * modulo puro (dove viene provato dai test), e la completezza dei tasti arriva gia'
 * calcolata in `status`.
 *
 * LE TRE REGOLE SOSPESE NON SPARISCONO, cambiano posto. Stanno nel `title` del
 * contatore dei passi: un verdetto che tace si legge come "conforme", e in un lavoro
 * il cui oggetto e' il verdetto quella era la bugia peggiore da accettare. Erano
 * quattro righe di testo da leggere una volta, non a ogni passo: un pannello alto le
 * pagava lo stesso prezzo che si voleva togliere.
 */

export interface PracticeBarProps {
  stepIndex: number;
  total: number;
  measure: number;
  /** i tasti che questo passo chiede, per il tooltip */
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
  /** le regole che qui non si applicano, con il loro motivo */
  suspended: Record<string, string>;
  error: string | null;
}

const PracticeBar: React.FC<PracticeBarProps> = ({
  stepIndex, total, measure, expected, status, problem, verdictStep, judging, hand, hands,
  onHandChange, dynamicsOn, onDynamicsChange, suspended, error,
}) => {
  const attesi = expected.length;
  const suonati = status
    ? expected.filter((p) => status.pressed.includes(p)).length
    : 0;
  const completo = status?.advance === true;
  const altraMano = status?.other_hand ?? [];

  // Il tooltip del contatore porta dentro quello che una volta stava nel pannello:
  // i tasti attesi, e le regole che qui non giudicano. La prova la si fa col dito
  // sui tasti, ma la risposta a "perche' non vedo il pedale?" deve restare da
  // qualche parte, e un titolo esplode in una riga mentre un pannello no.
  const perche = Object.entries(suspended)
    .map(([nome, motivo]) => `${nome}: ${motivo}`)
    .join('\n');
  const titoloPassi = [
    expected.length > 0 ? `Tasti di questo passo: ${expected.map(noteName).join(', ')}` : '',
    measure > 0 ? `Battuta ${measure}` : '',
    perche ? `\nNon si applicano in questa modalita':\n${perche}` : '',
  ].filter(Boolean).join('\n');

  const manoDisponibile = hands?.split === true;
  const percheMano = manoDisponibile
    ? 'Studia solo un rigo per volta: le note dell\'altro rigo non vengono chieste, non fermano il cursore e non finiscono nel verdetto.'
    : hands === null
      ? 'Aspetto di sapere se questo spartito separa le mani.'
      // Dichiarato perche' spento: un pulsante muto che non si puo' premere e'
      // identico a uno che non c'e', tranne che per lo spazio che occupa.
      : 'Questo file non dichiara i righi: non c\'e\' una mano destra da isolare, quindi si studia tutto il brano.';

  return (
    <section className="practice-bar" aria-label="Comandi della pratica">
      {/* Passo e completezza: la colonna di sinistra e' l'unica cosa da guardare
          mentre le dita cercano i tasti. */}
      <span className="pb-step" title={titoloPassi}>
        {stepIndex + 1}<span className="pb-step-total">/{total}</span>
      </span>

      <span
        className={`pb-keys${completo ? ' pb-keys-ok' : ''}`}
        title={titoloPassi}
      >
        <span className="pb-dot pb-dot-keys" aria-hidden="true" />
        {suonati}/{attesi} tasti
        {/* I tasti dell'altro rigo premuti comunque si dichiarano: non sono errori
            e non sono spariti. */}
        {altraMano.length > 0 && (
          <span className="pb-other">
            · {altraMano.length} nota{altraMano.length > 1 ? 'i' : ''} dell\'altro
            rigo ignorata{altraMano.length > 1 ? 'te' : 'a'}
          </span>
        )}
      </span>

      {/* Il verdetto compatto: una parola, non un elenco. `judging` e' la richiesta
          in volo, che sul servizio deployato dura un paio di secondi; il testo
          vecchio va dichiarato come vecchio perche' arriva dopo, mentre le dita
          sono gia' al passo successivo. */}
      <span
        className={`pb-problem pb-${problem.tone}`}
        id="practice-problem"
        title={error && !problem.stale ? error : 'Il verdetto di RML su questo passo'}
      >
        <span className="pb-dot" aria-hidden="true" />
        {problem.text}
        {/* Il verdetto arriva dopo, e quando arriva l'allievo e' gia' oltre. Dirlo
            senza che glielo si chieda: un verdetto del passo 11 mostrato mentre
            suona il 12 altrimenti sembra il verdetto del 12. */}
        {problem.stale && (
          <span className="pb-checking">· passo {verdictStep + 1}</span>
        )}
        {judging && <span className="pb-checking">· verifico…</span>}
      </span>

      {/* I due comandi extra, a destra: la mano e la dinamica. */}
      <span className="pb-controls">
        <span className="pb-seg" role="group" aria-label="Mano da studiare" title={percheMano}>
          <button
            id="bar-hand-all"
            className={`pb-chip${hand === null ? ' pb-chip-on' : ''}`}
            onClick={() => onHandChange(null)}
            disabled={!manoDisponibile}
          >
            Tutte
          </button>
          <button
            id="bar-hand-right"
            className={`pb-chip${hand === 'right' ? ' pb-chip-on' : ''}`}
            onClick={() => onHandChange('right')}
            disabled={!manoDisponibile}
          >
            Dx
          </button>
          <button
            id="bar-hand-left"
            className={`pb-chip${hand === 'left' ? ' pb-chip-on' : ''}`}
            onClick={() => onHandChange('left')}
            disabled={!manoDisponibile}
          >
            Sx
          </button>
        </span>

        <button
          id="bar-dyn-btn"
          className={`pb-chip${dynamicsOn ? ' pb-chip-on' : ''}`}
          onClick={() => onDynamicsChange(!dynamicsOn)}
          aria-pressed={dynamicsOn}
          title={dynamicsOn
            ? 'Controlla anche la dinamica: la velocity viene confrontata con la dinamica scritta nello spartito.'
            // Spenta deve dire cosa non si guarda piu', non limitarsi a spegnersi.
            : 'Spenta: la dinamica non viene mostrata fra i problemi del passo. Le note vengono comunque verificate, e il servizio continua a giudicarla.'}
        >
          Dinamica
        </button>
      </span>
    </section>
  );
};

export default PracticeBar;
