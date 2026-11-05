import React from 'react';
import './PianoKeyboard.css';
import { noteName } from '../hooks/practiceSteps';

/**
 * La tastiera di richiamo della pratica: si apre e si chiude col pulsante a forma
 * di pianoforte nella striscia, e sta sopra le due barre.
 *
 * PERCHE' UNA TASTIERA E NON UN CONTATORE. La riga compatta dice UNA parola
 * ("wrong note"), ma non dice QUALE tasto: finche' il passo aveva i tasti contati
 * a schermo, "0/2" bastava per capire se mancava ancora qualcuno. Tolti quei
 * numeri, l'unica cosa che puo' dire "questo e' il tasto, premi questo" e' la
 * tastiera stessa: un disegno della tastiera reale, con il do centrale marcato e i
 * punti di riferimento scritti, dove i tasti del passo si accendono.
 *
 * DISPLAY, NON STRUMENTO. Nessun suono, nessun click: `pointer-events: none`. La
 * mano dell'allievo e' gia' su una tastiera vera, e una seconda tastiera che
 * risponde ai tocchi accanto a quella vera sarebbe un oggetto con due funzioni, di
 * cui nessuna utile.
 *
 * NIENTE DIPENDENZE. Sono rettangoli di DOM: lucide serve solo per l'icona del
 * pulsante che la apre. Una libreria di tastiere porterebbe via un pezzo di bundle
 * per disegnare quaranta rettangoli, e qui la forma la sa chiunque suoni: tasti
 * bianchi in fila, neri alti il 62% fra un bianco e l'altro.
 */

/** I semitoni che stanno sui tasti neri, modulo 12 (C=0). */
const BLACK = new Set([1, 3, 6, 8, 10]);

/**
 * Gli estremi della tastiera: tutti e 88 i tasti, A0 (21) fino a C8 (108), che sono
 * gli stessi estremi citati dalle specifiche RML.
 *
 * LA SCELTA E' DELL'UTENTE, E VA DETTA PERCHE' NON E' OVVIA. La prima versione
 * disegnava solo l'estensione chiesta dal brano — su uno schermo da tredici pollici
 * ottantotto tasti vogliono dire sei pixel l'uno. Poi e' arrivata la richiesta
 * contraria: la tastiera deve mostrare tutti i tasti, perche' una tastiera tagliata
 * non dice dove si trova il brano RISPETTO allo strumento, e chi suona si orienta
 * proprio con quello. Il compromesso e' la larghezza: qui la tastiera prende il
 * doppio della striscia dei comandi, cosi' un tasto bianco resta ~23 pixel largo e
 * non sei, che e' il motivo per cui la prima versione tagliava l'estensione.
 */
export const PIANO_LOW = 21;
export const PIANO_HIGH = 108;

/** Il do centrale. La convenzione e' quella di `noteName`: MIDI 60 = C4. */
const MIDDLE_C = 60;

export interface PianoKeyboardProps {
  /**
   * Estensione da mostrare: il default e' la tastiera intera di 88 tasti. Un
   * chiamante puo' restringerla (i test, o una schermata molto stretta), ma non
   * deve farlo per convenienza: chi legge deve riconoscere lo strumento.
   */
  low?: number;
  high?: number;
  /** i tasti che questo passo chiede alla mano studiata */
  expected: number[];
  /** i risultati premuti adesso, per far vedere cosa manca senza aspettare il verdetto */
  pressed: number[];
  /** premuti ma non chiesti: rosso, perche' e' l'unico caso in cui un tasto acceso fa male */
  extra?: readonly number[];
  /** i tasti dell'altro rigo nello stesso istante: viola, dichiarati e non giudicati */
  offhand?: readonly number[];
}

const has = (list: readonly number[] | undefined, pitch: number): boolean =>
  (list ?? []).includes(pitch);

const PianoKeyboard: React.FC<PianoKeyboardProps> = ({
  low = PIANO_LOW, high = PIANO_HIGH, expected, pressed, extra, offhand,
}) => {
  // I tasti bianchi in ordine, e per ognuno il nero che lo segue. Un nero esiste
  // solo dove il semitono successivo e' davvero della fila dei neri: fra E-F e B-C
  // non c'e', e un disegno che lo disegna lo stesso sposta tutta la tastiera di un
  // tasto, che e' l'errore peggiore per un disegno di riferimento.
  const whites: number[] = [];
  for (let m = low; m <= high; m++) if (!BLACK.has(m % 12)) whites.push(m);

  const unit = 100 / Math.max(whites.length, 1);
  // Larghezza del nero in percentuale sulla riga: un nero e' largo il 62% di un
  // bianco, e la percentuale va passata dal codice perche' il numero di bianchi
  // cambia con il brano. Una larghezza fissa in rem renderebbe i neri tutti uguali
  // fra una parte da due ottave e una da cinque, e su quella stretta si toccherebbero.
  const bw = unit * 0.62;
  const blacks: { pitch: number; left: number }[] = [];
  whites.forEach((pitch, i) => {
    const above = pitch + 1;
    if (above <= high && BLACK.has(above % 12)) {
      blacks.push({ pitch: above, left: (i + 1) * unit - bw / 2 });
    }
  });

  const daPremere = expected.length > 0
    ? expected.map((p) => noteName(p)).join(' · ')
    : '';

  return (
    <section
      className="piano-kbd"
      aria-label={expected.length > 0
        ? `Piano keyboard hint. Press ${expected.map((p) => noteName(p)).join(', ')}.`
        : 'Piano keyboard reference'}
      data-testid="piano-keyboard"
    >
      <div className="pk-row">
        {whites.map((pitch, i) => {
          const cls = [
            'pk-key', 'pk-white',
            has(expected, pitch) ? 'pk-expected' : '',
            has(pressed, pitch) && has(expected, pitch) ? 'pk-down' : '',
            has(extra, pitch) ? 'pk-extra' : '',
            has(offhand, pitch) && !has(expected, pitch) ? 'pk-offhand' : '',
            pitch === MIDDLE_C ? 'pk-middle' : '',
          ].filter(Boolean).join(' ');
          // Solo i do e i fa si scrivono: sono i punti d'appoggio che chi suona
          // usa per orientarsi, e scrivere ogni nota renderebbe il disegno un
          // elenco fitto di lettere invece che una tastiera.
          const nome = noteName(pitch);
          const daScrivere = pitch % 12 === 0 || pitch % 12 === 5;
          return (
            <div className={cls} key={pitch} data-pitch={pitch} data-index={i}
              title={pitch === MIDDLE_C ? `${nome} — middle C` : nome}>
              {daScrivere && (
                <span className={`pk-label${pitch % 12 === 0 ? ' pk-ref-c' : ''}`}>{nome}</span>
              )}
              {pitch === MIDDLE_C && <span className="pk-dot" aria-hidden="true" />}
            </div>
          );
        })}
        {blacks.map(({ pitch, left }) => {
          const cls = [
            'pk-key', 'pk-black',
            has(expected, pitch) ? 'pk-expected' : '',
            has(pressed, pitch) && has(expected, pitch) ? 'pk-down' : '',
            has(extra, pitch) ? 'pk-extra' : '',
            has(offhand, pitch) && !has(expected, pitch) ? 'pk-offhand' : '',
          ].filter(Boolean).join(' ');
          // Su un tasto nero il nome lo si scrive solo quando quel tasto e' dentro
          // una delle quattro storie: con ottanta tasti in fila, un diesis acceso
          // senza nome e' una figurina scura e basta, e l'allievo deve contare i
          // semitoni partendo dal do vicino — esattamente il lavoro che questo
          // disegno doveva togliergli. Gli altri neri restano muti per non
          // trasformare la tastiera in un elenco di lettere.
          const acceso = has(expected, pitch) || has(pressed, pitch) || has(extra, pitch)
            || has(offhand, pitch);
          return (
            <div className={cls} key={pitch} data-pitch={pitch} style={{ left: `${left}%`, width: `${bw}%` }}
              title={noteName(pitch)}>
              {acceso && <span className="pk-tag">{noteName(pitch)}</span>}
            </div>
          );
        })}
      </div>

      {/* Cosa chiedere ai tasti accesi, scritto sotto. Senza questa riga il disegno
          dice "un tasto e' acceso" e lascia all'allievo il lavoro di capire quale
          sia il proprio, che e' esattamente il lavoro che la tastiera doveva togliere. */}
      {daPremere && <p className="pk-caption">{`press ${daPremere}`}</p>}
    </section>
  );
};

export default PianoKeyboard;
