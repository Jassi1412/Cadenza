import React from 'react';
import './PracticePanel.css';
import { noteName } from '../hooks/practiceSteps';
import type { StepStatus } from '../hooks/practiceSteps';
import type { StepResult } from '../hooks/usePractice';

/**
 * Il pannello della modalita' practice.
 *
 * Presentazionale: non decide niente e non chiama il servizio, riceve il passo,
 * lo stato e i verdetti. Il giudizio e' di RML e viaggia in `last`; `status` e'
 * la completezza del passo, calcolata in locale e disponibile subito.
 *
 * PERCHE' I TASTI NON DIPENDONO DAL VERDETTO. Il verdetto di un passo costa ~2 s
 * sul servizio deployato. Se l'evidenziazione dei tasti aspettasse lui, il dito
 * sarebbe gia' su un altro tasto quando lo schermo si accorge del primo. Quindi
 * il colore dei tasti segue `status` (locale, immediato) e il pannello dei
 * verdetti segue `last` (RML, piu' lento). Le due cose sono separate di
 * proposito, e il tempo di arrivo diverso e' la ragione.
 *
 * IL PUNTO DELICATO E' COME SI MOSTRA UNA REGOLA CHE NON SI APPLICA.
 *
 * In practice mode tre delle sette regole non hanno senso (articulation e le due
 * del pedale: vedi alignment/practice.py). Se il pannello le nascondesse, il
 * silenzio si leggerebbe come "conforme" — e in un lavoro sul runtime
 * monitoring sarebbe il modo peggiore di mentire, perche' la cosa che si sta
 * studiando e' proprio il verdetto. Quindi le regole sospese si MOSTRANO, con
 * scritto che non si applicano qui e perche'.
 *
 * E' la stessa distinzione fra "assente" e "zero" che le specifiche .rml fanno
 * gia' dappertutto: `dynExplicit` esiste per non confondere "qui non e' scritta
 * una dinamica" con "una dinamica che vale zero", e `pitchDist: null` non e'
 * `pitchDist: 0`.
 */

export interface PracticePanelProps {
  stepIndex: number;
  total: number;
  measure: number;
  /** i tasti attesi in questo passo */
  expected: number[];
  /** lo stato locale del passo corrente, o null se e' di un altro passo */
  status: StepStatus | null;
  last: StepResult | null;
  verdictStep: number;
  suspended: Record<string, string>;
  judging: boolean;
  error: string | null;
  /**
   * dynamics-adherence e' accesa? E' l'unica regola che si puo' spegnere.
   *
   * La specifica non guarda nessun istante di tempo, quindi funziona identica
   * accesa o spenta: la scelta e' pedagogica, ed e' dell'allievo. Quando e'
   * spenta la riga resta visibile come "spenta", non sparisce — l'interruttore
   * deve dire cosa hai scelto di non guardare.
   */
  dynamicsOn: boolean;
  onDynamicsChange: (on: boolean) => void;
}

const PracticePanel: React.FC<PracticePanelProps> = ({
  stepIndex, total, measure, expected, status, last, verdictStep, suspended, judging,
  error, dynamicsOn, onDynamicsChange,
}) => {
  const premuti = status?.pressed ?? [];
  const mancanti = status?.missing ?? [];
  const estranee = status?.extra ?? [];

  // Il verdetto mostrato non e' per forza quello del passo su cui sei fermo:
  // sul piano gratuito arriva in secondi, quindi mentre l'allievo legge il
  // verdetto del passo 11 sta gia' suonando il 12. Dirlo esplicitamente evita
  // che il ritardo sembri un verdetto sbagliato.
  const inRitardo = last !== null && verdictStep !== stepIndex;

  return (
    <section className="practice-panel">
      {/* Due colonne: la SINISTRA e' quello che serve per suonare adesso — i
          tasti, e il numero del passo. La destra e' la lettura del verdetto,
          che arriva dopo e si consulta con calma.

          La divisione non e' decorativa: il pannello intero era alto 553 px e
          finiva per coprire lo spartito, cioe' nascondeva il cursore mentre si
          guarda il tasto, o il tasto mentre si guarda il cursore. La colonna
          sinistra sta alta una manciata di righe e non copre niente. */}
      <div className="practice-left">
      <div className="practice-panel-head">
        <h2 className="heading">Pratica</h2>
        <span className="practice-counter">
          Passo {stepIndex + 1} di {total}
          <span className="practice-measure"> · battuta {measure}</span>
        </span>
      </div>

      <div className="practice-keys">
        {expected.map((p) => {
          const giusta = premuti.includes(p);
          return (
            <span
              key={p}
              className={`practice-key ${giusta ? 'practice-key-ok' : 'practice-key-todo'}`}
            >
              {noteName(p)}
            </span>
          );
        })}
      </div>

      {mancanti.length > 0 && (
        <p className="practice-hint">
          Mancano {mancanti.map(noteName).join(', ')}: il brano resta fermo qui.
        </p>
      )}

      {/* Una nota in piu' non blocca l'avanzamento, e il pannello non deve far
          credere il contrario: si segnala, e a dire che non c'entrava e' la
          regola pitch-agreement. */}
      {estranee.length > 0 && (
        <p className="practice-hint practice-hint-extra">
          In piu': {estranee.map(noteName).join(', ')} — fuori dallo spartito.
        </p>
      )}

      {error && <p className="practice-error">{error}</p>}

      </div>

      <div className="practice-right">
      <div className="practice-verdicts">
        <div className="practice-verdicts-head">
          <span>Come l&apos;hai suonato</span>
          {judging && <span className="practice-judging">verifica in corso…</span>}
          {inRitardo && !judging && (
            <span className="practice-judging">verdetto del passo {verdictStep + 1}</span>
          )}
        </div>

        {last === null && !judging && (
          <p className="practice-idle">Suona le note del passo per ricevere il verdetto.</p>
        )}

        {last && (
          <ul className="practice-list">
            {Object.entries(last.verdicts)
              // dynamics spenta: la riga resta, ma non si mostra il suo esito.
              // Nasconderla farebbe leggere il silenzio come "conforme", che e'
              // l'errore che tutto questo pannello cerca di non fare.
              .filter(([nome]) => nome !== 'dynamics-adherence' || dynamicsOn)
              .map(([nome, v]) => (
                <li
                  key={nome}
                  // Tre esiti, non due. `exit 2` e' il monitor che non e' partito
                  // (swipl mancante, una specifica che non compila): mostrarlo
                  // come "violata" direbbe all'allievo che ha suonato male quando
                  // invece e' il servizio che e' rotto — l'errore del software
                  // letto come giudizio sulla persona.
                  className={
                    v.exit === 2 ? 'practice-rule-error'
                      : v.ok ? 'practice-rule-ok' : 'practice-rule-bad'
                  }
                >
                  <span className="practice-mark">
                    {v.exit === 2 ? '!' : v.ok ? '✓' : '✗'}
                  </span>
                  <span className="practice-name">{nome}</span>
                  <span className="practice-detail">
                    {v.exit === 2 ? 'non verificabile' : v.ok ? 'conforme' : 'violata'}
                  </span>
                </li>
              ))}
          </ul>
        )}

        {/* dynamics-adherence si puo' spegnere: e' l'unica regola di pratica la
            cui attivazione e' una scelta e non un fatto tecnico. */}
        <label className="practice-toggle">
          <input
            type="checkbox"
            checked={dynamicsOn}
            onChange={(e) => onDynamicsChange(e.target.checked)}
            id="practice-dynamics-toggle"
          />
          <span>
            Controlla anche la dinamica
            <span className="practice-toggle-why">
              {dynamicsOn
                ? 'La velocity viene confrontata con la dinamica scritta nello spartito.'
                : 'Spenta: la dinamica non viene giudicata. Le note vengono comunque verificate.'}
            </span>
          </span>
        </label>
        </div>

        {/* Le regole che qui non si applicano, dichiarate invece che omesse.

            Stanno in un <details> chiuso perche' sono lunghe — il loro testo
            spiega PERCHE' non si applicano, e va letto una volta, non a ogni
            passo. tenerlo aperto rendeva il pannello alto 471 px: copriva il
            spartito per metà, e la colonna di sinistra — quella con i tasti da
            premere — restava vuota per due terzi. Chiuso, il pannello sta in
            poco piu' di quello che serve a suonare, e il sommario dichiara
            comunque che le tre regole non si applicano. */}
        {Object.keys(suspended).length > 0 && (
          <details className="practice-suspended-box">
            <summary className="practice-suspended-summary">
              Le {Object.keys(suspended).length} regole che qui non si applicano
            </summary>
            <ul className="practice-list practice-suspended">
              {Object.entries(suspended).map(([nome, motivo]) => (
                <li key={nome} className="practice-rule-suspended">
                  <span className="practice-mark">–</span>
                  <span className="practice-name">{nome}</span>
                  <span className="practice-detail">non si applica in questa modalità</span>
                  <span className="practice-why">{motivo}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
};

export default PracticePanel;
