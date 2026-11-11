import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useMidi } from '../hooks/useMidi';
import { useVerdict } from '../hooks/useVerdict';
import { usePractice } from '../hooks/usePractice';
import { handSelection, pressedPitches, staffGray, stepProblem, type HandsSwitch } from '../hooks/practiceSteps';
import { consumedFullTrack, endSignal, markTipFor, performanceScore, planMarks, summaryLines, type GreenSpot, type MarkTip } from '../hooks/scoreMarks';
import type { MarkColumn } from '../hooks/scoreMarks';
import PlaybackBar from '../components/PlaybackBar';
import PracticeBar from '../components/PracticeBar';
import PianoKeyboard from '../components/PianoKeyboard';
import PerformanceCard from '../components/PerformanceCard';
import ErrorHoverCard from '../components/ErrorHoverCard';
import './ScorePage.css';

// Module-level refs for dynamic imports
let Player: any = null;
let OpenSheetMusicDisplayRenderer: any = null;
let VerovioConverter: any = null;

/** Se lo spartito non dichiara un tempo, si parte da qui. */
const BPM_FALLBACK = 120;

/**
 * Il tempo scritto nello spartito, in battute al minuto.
 *
 * Lo slider deve mostrare i BPM e non un moltiplicatore: un musicista che
 * rallenta per imparare una parte ragiona in battute al minuto, e il numero
 * che vede è confrontabile con quello di qualsiasi altro brano.
 *
 * `<sound tempo>` è la dichiarazione esplicita; se manca si prova il metronomo.
 * Se non c'è nemmeno quello si torna a un valore plausibile: peggio un numero
 * approssimato che uno slider che non parte.
 *
 * Nei brani con cambi di tempo si prende il primo. Lo slider scala tutta la
 * durata dello stesso fattore, quindi i rallentamenti interni restano: è il
 * tempo di apertura quello che l'utente vede.
 */
function readScoreBpm(scoreXml: string): number {
  const sound = /<sound\b[^>]*\btempo="([^"]+)"/.exec(scoreXml);
  if (sound) {
    const bpm = Number(sound[1]);
    if (Number.isFinite(bpm) && bpm > 0) return Math.round(bpm);
  }
  const perMinute = /<per-minute>([^<]+)<\/per-minute>/.exec(scoreXml);
  if (perMinute) {
    const bpm = Number(perMinute[1]);
    if (Number.isFinite(bpm) && bpm > 0) return Math.round(bpm);
  }
  return BPM_FALLBACK;
}

/**
 * Fasi della prova.
 *
 * `idle`      spartito fermo, si può ascoltare senza registrarsi
 * `countdown` lo spartito è pronto ma non parte ancora: il musicista si mette
 *             al tastierino. È l'unica differenza rispetto a premere Play.
 * `playing`   lo spartito suona e la tastiera viene registrata.
 *
 * `PlayerState` del player contiene solo Stopped/Playing/Paused e non espone
 * eventi (verificato nel bundle: `_state` viene scritto solo nel costruttore,
 * in play() e in pause()), quindi la fine del brano non arriva mai come
 * segnale. La decide `endSignal` in scoreMarks.ts — due fatti certi, il tetto
 * di position o un riavvolgimento a traccia già consumata — letta qui dal tick
 * del player. Niente soglie percentuali: l'utente le ha respinte.
 */
type Phase = 'idle' | 'countdown' | 'playing';

/**
 * Se `position` resta fermo mentre si dovrebbe sentire qualcosa, il sequencer
 * non arrivera' mai al fondo. Chiudere la prova e' meglio che non darla mai.
 * Non è una fine "certa" come le due di `endSignal` (scoreMarks.ts): è il
 * lasciarsi andare onesto, e per questo resta qui nel page, fuori dalla regola.
 */
const STALL_MS = 2000;

/**
 * Gli interruttori della pratica — tastiera di richiamo, L e R — sopravvivono
 * alla sessione (richiesta esplicita 2026-11-10: "se la disattivo e faccio
 * ripartire da capo il brano ricompare di nuovo ... rendile persistenti, non
 * si devono resettare a meno che non lo scelga l'utente"). L'unica cosa che li
 * cambia è il click su di essi; né entrare né uscire dalla pratica li tocca.
 * Si salvano nel browser così che restino tali anche ricaricando la pagina.
 */
interface PracticePrefs { kb: boolean; left: boolean; right: boolean }

const PREFS_KEY = 'cadenza-practice-controls';

/** Prime visite: tutto acceso, come era prima che la persistenza venisse chiesta. */
function loadPracticePrefs(): PracticePrefs {
  const fresh: PracticePrefs = { kb: true, left: true, right: true };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fresh;
    const p = JSON.parse(raw) as Partial<PracticePrefs>;
    // ogni campo si convalida da solo: un pezzo scritto male non porta dentro
    // uno stato inventato, e nemmeno uno buono si perde per culpa dell'altro
    return {
      kb: typeof p.kb === 'boolean' ? p.kb : fresh.kb,
      left: typeof p.left === 'boolean' ? p.left : fresh.left,
      right: typeof p.right === 'boolean' ? p.right : fresh.right,
    };
  } catch { return fresh; } // quota, modalità privata, JSON corrotto: scelta persa, pagina viva
}

/**
 * Il countdown fa DA 4 A 1, un secondo per numero (chiarimento dell'utente del
 * 2026-11-06: "intendevo un countdown da 4 a 1, ogni numero vale 1 secondo").
 * Quattro numeri veri alla stessa distanza di un battito da 60: come la battuta
 * d'attacco di un direttore. Il click accentato sul "Go" coincide con l'attacco
 * del brano (secondo il chiarimento, e secondo la musica).
 */
const COUNTDOWN_STEP_MS = 1000;

/** Da quale numero si comincia: 4, come una ripresa vera. */
const COUNTDOWN_FROM = 4;

/**
 * Un click di metronomo, generato al volo con WebAudio: nessun file, nessun player.
 * Il fischio acuto e corto è il battito forte dell'ultimo numero ("Go"): come
 * un metronomo vero, l'attacco del brano cade sul colpo accentato.
 */
let audioCtx: AudioContext | null = null;
function playTick(accent: boolean) {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = accent ? 1560 : 1040;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  } catch {
    // niente audio su questo browser: i numeri bastano comunque a contare
  }
}

/**
 * Porta il cursore di OSMD sul passo indicato, e dice dove e' arrivato.
 *
 * PERCHE' SI CONTA E NON SI CONFRONTANO LE NOTE. La prima versione cercava la
 * voce le cui note coincidessero con quelle del passo. In un browser vero non
 * combacia MAI, e la ragione e' che i due lati parlano di ottave diverse: su
 * questo brano OSMD riporta ogni nota 36 semitoni (tre ottave) sotto il piano,
 * in modo uniforme, per via di una direzione `<octave-shift type="down" size="8">`
 * scritta sul rigo di violino. Il passo 0 chiede [46, 93] e la voce
 * corrispondente dice [10, 57]; il passo 1 chiede [46, 86] e la voce dice
 * [10, 50]. Scrivere "-36" nel codice sarebbe un bug travestito da costante:
 * cambierebbe con il primo spartito che non ha quel segno.
 *
 * QUELLO CHE INVECE TORNA, misurato sul brano intero. Sia il piano sia
 * l'iteratore elencano gli ATTACCHI in ordine cronologico, e il k-esimo
 * dell'uno e' il k-esimo dell'altro: su 128 passi la fermata k dell'iteratore
 * cade nella battuta del passo k 128 volte su 128, senza un solo scarto. Quindi
 * si conta, e non si legge nessun pitch.
 *
 * L'iteratore fa 256 fermate contro 128 passi perche' lo spartito ha un
 * ritorno di ripetizione: il secondo giro ripete il primo esattamente. Non e'
 * un problema qui — la pratica si ferma al passo 127, cioe' alla fine del primo
 * giro — ed e' il motivo per cui il conteggio si ferma a `stepIndex` invece di
 * pretendere di aver finito lo spartito.
 *
 * Ritorna la posizione raggiunta, oppure -1 se non ce l'ha fatta. Chi chiama
 * conserva il valore perche' la pratica avanza solo in avanti e ricominciare il
 * cammino da capo a ogni passo costerebbe un salto dello schermo.
 */
function moveCursorToStep(osmd: any, stepIndex: number, fromStep: number): number {
  const cursor = osmd?.cursors?.[0];
  if (!cursor) return -1;
  try {
    // Si torna all'inizio solo se si va indietro o se non si sa dove si e'.
    // Senza il reset, dopo un ascolto completo il cursore resterebbe in fondo e
    // il primo passo non lo troverebbe mai; con un reset a ogni passo, invece,
    // lo spartito salterebbe all'inizio 128 volte.
    let pos = fromStep;
    if (pos < 0 || pos > stepIndex) {
      cursor.reset();
      pos = 0;
    }
    cursor.show();

    // Rete di sicurezza: un brano lungo ha migliaia di fermate, e un ciclo
    // senza fine bloccherebbe la pagina. Non e' un limite musicale, e' il
    // punto in cui rinunciare e' meglio che piantarsi.
    for (let guard = 0; pos < stepIndex && guard < 6000; guard++) {
      if (cursor.Iterator?.EndReached) break;
      cursor.next();
      pos++;
    }
    // `show()` dopo il cammino: `update()` non disegna nulla mentre il cursore
    // e' nascosto, quindi mostrarlo alla fine e' l'unico ordine che lo fa
    // comparire davvero nella posizione raggiunta.
    cursor.show();
    return pos;
  } catch (err) {
    console.warn('[ScorePage] posizionamento del cursore:', err);
    try {
      cursor.hide();
    } catch {
      // gia' nascosto, o l'istanza e' stata distrutta: niente da fare
    }
    return -1;
  }
}

/**
 * Il rosso delle dite sbagliate: la famiglia d'errore già usata dalla barra di
 * pratica e dalla tastiera di richiamo. In tutta l'app una sola parola, "sbagliato",
 * ha una tinta sola: qui non si inventa niente.
 */
const MARK_RED = '#a0442c';
/** Il verde delle note giuste: stesso peso cromatico del rosso, e il verde
 *  che il tema gia' usa per "tutto rispettato" (il #2e7d32 del pannello dei
 *  verdetti). Nessun hover gli appartiene: deve solo dire "li' ok". */
const MARK_GREEN = '#2e7d32';

/** Ciò che è stato colorato, per toglierlo quando il verdetto si chiude o la
 *  prova ricomincia: un rosso lasciato addosso alla nota sbagliata GIUSTA
 *  diventerebbe l'accusa di una prova che non è quella in corso. */
interface MarkState {
  paths: Array<{ el: SVGPathElement; fill: string | null; stroke: string | null }>;
  /** le teste bagnate nel rosso, per togliere anche la loro card d'hover */
  heads: SVGGElement[];
}

/**
 * Cosa mostrare sopra ogni testa rossa. Non è più un `<title>` nativo — il
 * rettolino grigio del browser è stato eliminato su richiesta esplicita
 * (2026-11-10: "l'errore dentro un rettangolino brutto... lo voglio come
 * componente in tema col sito"): la mappa alimenta la card React
 * `ErrorHoverCard`, stessa pelle delle barre mobili. È una WeakMap perché le
 * teste vengono ricreate a ogni re-render di OSMD (zoom): se ne vanno loro,
 * se ne va la voce; il clear le toglie comunque esplicitamente, perché una
 * testa scolorita non deve più rispondere all'hover.
 */
const markTips = new WeakMap<SVGGElement, MarkTip>();

function clearScoreMarks(state: MarkState | null): void {
  if (!state) return;
  for (const { el, fill, stroke } of state.paths) {
    if (fill === null) el.removeAttribute('fill');
    else el.setAttribute('fill', fill);
    if (stroke === null) el.removeAttribute('stroke');
    else el.setAttribute('stroke', stroke);
  }
  for (const h of state.heads) markTips.delete(h);
}

/** Una testa di nota, la sua x e il suo gruppo: la geometria è l'unico ponte
 *  verso il modello — nella build minificata di OSMD le teste NON espongono
 *  alcun riferimento all'elemento SVG (misurato con una sonda su Chromium). */
interface NoteheadHit {
  el: SVGGElement;
  cx: number;
}

/** Tinge una testa di nota: rosso dove il verdetto ha colpito, verde dove
 *  l'esecuzione ha centrato il tasto scritto al momento giusto. La card
 *  dell'hover non si appende qui: sta nel DOM della pagina, alimentata dalla
 *  mappa markTips, per restare nel tema e morire quando la testa torna pulita. */
function paintNotehead(head: SVGGElement, state: MarkState, color: string): void {
  for (const p of head.querySelectorAll<SVGPathElement>('path')) {
    state.paths.push({ el: p, fill: p.getAttribute('fill'), stroke: p.getAttribute('stroke') });
    p.setAttribute('fill', color);
    p.setAttribute('stroke', color);
  }
}

/**
 * Dipingere di rosso i punti in cui il verdetto ha colto l'esecuzione in fallo,
 * e preparare sopra ognuno la sua card d'hover con le regole cascate lì.
 *
 * COME ARRIVA ALLA NOTA — contando. Ogni punto arriva dal servizio con `attack`:
 * l'indice assoluto dell'attacco nello spartito completo, ed è ciò che il
 * cursore di OSMD sa raggiungere contando (moveCursorToStep qua sopra: misurato
 * 128 fermate su 128 sulla misura giusta). Riconoscere la nota dall'altezza
 * sbagliherebbe ovunque: OSMD disegna tutto tre ottave sotto il piano, e i due
 * lati non combinano mai (alignment/_probe_osmd.mjs). Il pitch qui non si legge.
 *
 * Una volta su quella fermata, quali teste dipingere? La riga del cursore dice
 * DOVE, e a quel punto la scelta è geometrica: sono tutte le teste di nota il
 * cui centro cade sulla perpendicolare della riga, dentro una banda di mezze
 * colonne — cioè l'accordo (e l'eventuale rigo sotto) che parte in quell'istante.
 * La soglia NON è un numero assoluto: la larghezza delle colonne dipende dallo
 * zoom, quindi si misura lo spazio fra colonne vicine e si accetta chi ci sta
 * dentro. Se nulla cade sulla riga si dichiara il punto "non raggiunto": meglio
 * una riga sotto che dire "è colpa tua" alla nota del vicino.
 */
function paintScoreMarks(osmd: any, columns: MarkColumn[], green?: GreenSpot[]): {
  state: MarkState;
  painted: number;
  firstEl: SVGGElement | null;
  missed: string[];
} {
  const state: MarkState = { paths: [], heads: [] };
  const missed: string[] = [];
  let firstEl: SVGGElement | null = null;
  let painted = 0;

  // Senza indice dell'attacco non c'è da contare: questi punti finiscono dichiarati,
  // non colorati a caso sul primo che passa.
  // Rosso e verde viaggiano su UN SOLO cammino: il cursore avanza e non torna
  // indietro, quindi le due liste si fondono in ordine cronologico. Non stanno
  // mai sulla stessa fermata — planMarks separa le sovrapposizioni — e ogni
  // tappa e' o rossa o verde; `col` vale null per le tappe verdi.
  const walk: Array<{ col: MarkColumn | null; attack: number }> = [
    ...columns
      .filter((c) => c.attack !== null && c.attack >= 0)
      .map((c) => ({ col: c as MarkColumn, attack: c.attack as number })),
    ...(green ?? []).map((g) => ({ col: null, attack: g.attack })),
  ];
  for (const c of columns) {
    if (c.attack === null || c.attack < 0) missed.push(...c.rules.map((r) => r.name));
  }
  // Il cammino procede solo in avanti (il cursore non torna indietro), quindi si
  // visita in ordine cronologico. L'ordine di lettura resta quello del piano.
  walk.sort((x, y) => x.attack - y.attack);

  if (!osmd?.cursors?.[0] || !walk.length) {
    return { state, painted, firstEl, missed };
  }

  let pos = -1;
  for (const { col, attack } of walk) {
    pos = moveCursorToStep(osmd, attack, pos);
    if (pos < attack) {
      // la fermata non c'è (brano più corto del previsto, o iteratore rotto)
      if (col) missed.push(...col.rules.map((r) => r.name));
      continue;
    }
    // moveCursorToStep ha già reso il cursore visibile su questo punto: la sua
    // immagine è l'unica cosa che sa dove IL SISTEMA in corso sta sullo schermo.
    const img = Array.from(document.querySelectorAll<HTMLElement>('[id^="cursorImg-"]'))
      .find((el) => el.style.display !== 'none');
    if (!img) {
      if (col) missed.push(...col.rules.map((r) => r.name));
      continue;
    }
    const ir = img.getBoundingClientRect();
    let bandTop = ir.top;
    let bandBottom = ir.bottom;
    if (bandBottom - bandTop < 10) {
      // una linea troppo corta per distinguere i righi: allarga con giudizio,
      // restando dentro il sistema che il cursore sta indicando
      bandTop -= 80;
      bandBottom += 80;
    }
    const cursorX = ir.left + ir.width / 2;

    const heads: NoteheadHit[] = [];
    for (const h of document.querySelectorAll<SVGGElement>('#sheet-container g.vf-notehead')) {
      const r = h.getBoundingClientRect();
      if (r.width === 0) continue;
      const cy = (r.top + r.bottom) / 2;
      if (cy < bandTop - 4 || cy > bandBottom + 4) continue;
      heads.push({ el: h, cx: r.left + r.width / 2 });
    }
    if (!heads.length) {
      if (col) missed.push(...col.rules.map((r) => r.name));
      continue;
    }

    // spazio fra colonne vicine: è lui la tolleranza, non un numero assoluto
    const xs = [...new Set(heads.map((h) => Math.round(h.cx * 2) / 2))].sort((a, b) => a - b);
    let gap = Infinity;
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (d > 3 && d < gap) gap = d;
    }
    if (!Number.isFinite(gap)) gap = 90; // unica colonna in vista: margine largo
    const accept = Math.min(gap * 0.55, 45);

    let best: NoteheadHit | null = null;
    let bestD = Infinity;
    for (const h of heads) {
      const d = Math.abs(h.cx - cursorX);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    if (!best || bestD > accept) {
      if (col) missed.push(...col.rules.map((r) => r.name));
      continue;
    }

    // l'accordo intero: tutte le teste alla stessa ascissa della scelta migliore
    const cluster = Math.max(3, gap * 0.3);
    // la card d'hover si prepara UNA per la colonna e vale per tutte le teste
    // dell'istessa istante: è lo stesso errore visto da due righi. Il verde
    // non ha niente da raccontare e nella mappa delle punte non ci entra mai:
    // hoverare una nota verde non deve aprire nessuna card.
    const tip = col ? markTipFor(col) : null;
    let any = false;
    for (const h of heads) {
      if (Math.abs(h.cx - best.cx) > cluster) continue;
      paintNotehead(h.el, state, col ? MARK_RED : MARK_GREEN);
      if (col && tip) markTips.set(h.el, tip);
      state.heads.push(h.el);
      any = true;
    }
    if (!any) {
      if (col) missed.push(...col.rules.map((r) => r.name));
      continue;
    }
    painted++;
    // lo scorrimento porta al primo errore, non alla prima nota verde: chi ha
    // sbagliato deve vedere il proprio errore per primo.
    if (col) firstEl ??= best.el;
  }

  // Il cursore aveva finito di servire: fuori dal playback e fuori dalla pratica
  // non deve indicare niente, come ricorda l'effetto che lo nasconde alla fine
  // della pratica.
  try {
    osmd.cursors[0].hide();
  } catch {
    // istanza già distrutta: il foglio sta già sparendo
  }
  return { state, painted, firstEl, missed };
}

const ScorePage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const osmdRef = useRef<any>(null); // OSMD instance

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('Preparing the score...');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(3);
  // Tempo scelto dall'utente, in battute al minuto, e quello scritto nello
  // spartito. Il secondo serve solo per ricavare il fattore.
  const [scoreBpm, setScoreBpm] = useState(BPM_FALLBACK);
  const [bpm, setBpm] = useState(BPM_FALLBACK);

  const file = location.state?.file as File | undefined;
  const midiEnabled = location.state?.midiEnabled as boolean | undefined;
  const midiInputId = location.state?.midiInputId as string | undefined;

  // MIDI hook
  const midi = useMidi();

  // Verdicts — the seven RML specs, computed server-side. The verdict is not
  // decided here: this hook only carries the performance over and reads the
  // answer back.
  const verdict = useVerdict(midi.recording);
  // `verdict` è un oggetto nuovo a ogni render (lo costruisce il hook). Se lo si
  // mette nelle dipendenze di `runAnalysis`/`finishPlayAlong`, quegli stessi
  // callback cambiano identità a ogni render — e l'effetto di fine-presa, che li
  // cita, si resetta: azzera l'odometro `percorso`, il flag `chiuso` e
  // ricancia l'animation-frame a ogni frame di playback. La presa non chiude più
  // per "salto di loop a traccia consumata" e l'overlay del voto non appare.
  // Il ref tiene sempre l'ultima versione senza reinnescare nulla.
  const verdictRef = useRef(verdict);
  verdictRef.current = verdict;
  // L'istante in cui il brano comincia davvero (il "Go" del countdown), letto
  // sullo stesso orologio dei timestamp MIDI: DOMHighResTimeStamp, ms dalla
  // navigazione della pagina. La registrazione parte prima, col countdown, e
  // Web MIDI data gli eventi con quell'orologio assoluto mentre lo spartito
  // conta da 0: senza questa sottrazione ogni nota cade sull'ultimo attacco,
  // "never played" quasi ovunque e nessun verde (misurato il 2026-11-10 sulla
  // stessa esecuzione: a tempi relativi 128 verdi, traslati di 60 s 0 verdi).
  const takeStartRef = useRef<number | null>(null);
  const runAnalysis = useCallback(async () => {
    if (!file) return;
    try {
      const scoreXml = await file.text();
      await verdictRef.current.analyse(scoreXml, scoreBpm / bpm, takeStartRef.current ?? 0);
    } catch (err) {
      console.error('[ScorePage] Non sono riuscito a leggere lo spartito:', err);
    }
  }, [file, scoreBpm, bpm]);

  // ── Modalità a passi ───────────────────────────────────────────────
  //
  // Il brano non scorre: sta fermo sul passo corrente e avanza quando l'allievo
  // ha premuto i tasti di quel passo. È l'altro modo di usare lo stesso motore
  // RML, e non tocca quello normale: qui non si tocca il player, non si legge
  // `position`, non c'è nessun fattore di tempo da mandare al servizio.
  const practice = usePractice();
  const [isPractice, setIsPractice] = useState(false);
  /**
   * Cosa sta aspettando l'avvio della pratica, se qualcosa.
   *
   * `'midi'` = il browser sta chiedendo il permesso MIDI, e nessuno ha
   * risposto ancora. `'piano'` = il servizio sta leggendo lo spartito e
   * preparando i passi.
   *
   * Non e' un dettaglio: senza questo stato l'attesa e' muta, e il pulsante
   * sembra non funzionare. Vedi `startPractice`.
   */
  const [preparing, setPreparing] = useState<'midi' | 'piano' | null>(null);

  // L e R sono diventati due interruttori indipendenti (richiesta esplicita
  // 2026-11-07): la lettera accesa partecipa, quella spenta no, e "tutte e due
  // le mani" significa premerle entrambe. Il piano da mandare al servizio lo
  // decide `handSelection` nel modulo puro; qui sta solo lo stato dei due
  // interruttori. Dal 2026-11-10 quello stato è PERSISTENTE: si riapre la
  // pratica, o si ricarica la pagina, e le lettere restano dove le ha lasciate
  // chi suona — solo i loro click le cambiano ("non si devono resettare a meno
  // che non lo scelga l'utente").
  const [handsOn, setHandsOn] = useState<HandsSwitch>(() => {
    const p = loadPracticePrefs();
    return { left: p.left, right: p.right };
  });
  const handSel = handSelection(practice.hands, handsOn);

  /**
   * La tastiera di richiamo, aperta o chiusa dal pulsante a forma di pianoforte.
   *
   * All'inizio dei tempi partiva APERTA: da quando la riga non porta piu'
   * "1/128" e "0/2 tasti", la tastiera accesa e' l'equivalente visivo di quel
   * contatore, e chi entra in pratica deve trovare il tasto subito. Dal
   * 2026-11-10 resta pero' quello che chi suona ne ha fatto: si chiude una
   * volta, e alla prossima sessione la si trova chiusa. Uscire dalla pratica
   * non è una scelta sull'interruttore, quindi non lo tocca; la tastiera non si
   * vede comunque fuori dalla pratica (il render la lega a `isPractice`).
   */
  const [keyboardOpen, setKeyboardOpen] = useState(() => loadPracticePrefs().kb);

  // Scritta a ogni movimento degli interruttori: la scelta di chi suona vive
  // quanto il browser, non quanto la sessione. Se il salvataggio fallisce
  // (quota, modalità privata) la scelta resta valida per questa pagina.
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        kb: keyboardOpen, left: handsOn.left, right: handsOn.right,
      }));
    } catch { /* persistenza optional, l'esercizio no */ }
  }, [keyboardOpen, handsOn]);

  // Dove comincia, dentro `midi.recording`, la roba del passo corrente.
  //
  // `recording` e' la registrazione intera e non si azzera fra un passo e
  // l'altro: quello che va mandato al servizio e' solo cio' che e' stato suonato
  // davanti a QUESTO passo. Questo indice e' il confine, e si sposta quando il
  // cursore avanza.
  //
  // Il motivo per cui l'indice serve davvero, e non basta mandare tutto: se
  // mandassi l'intera registrazione, al passo 20 la traccia conterrebbe le note
  // dei 19 passi precedenti, e `pitch-agreement` le giudicherebbe al passo
  // sbagliato. Il verdetto sarebbe pieno di violazioni inventate.
  const stepStartRef = useRef(0);
  const lastLenRef = useRef(0);
  const lastSigRef = useRef('');
  // Dove il cursore di OSMD e' fermo adesso, in numero di fermate: -1 = non
  // posizionato. Serve per non ricominciare il cammino a ogni passo.
  const cursorStepRef = useRef(-1);

  const startPractice = useCallback(async () => {
    if (!file) return;
    playerRef.current?.pause();
    playerRef.current?.rewind();
    setIsPlaying(false);
    setProgress(0);
    setPhase('idle');
    setIsPractice(true);
    // Gli interruttori NON si toccano: chi rientra in pratica trova la tastiera
    // e le mani dove le ha lasciate (vedi `loadPracticePrefs`), non una
    // reimpostazione decisa dalla pagina. Il piano giusto per le lettere attuali
    // lo chiede da sé l'effetto che confronta `handSel` con il piano in carica.
    midi.clearRecording();
    stepStartRef.current = 0;
    lastLenRef.current = 0;
    lastSigRef.current = '';
    // L'attesa del permesso MIDI e' DICHIARATA, non muta.
    //
    // Il permesso Web MIDI e' una richiesta del browser: se nessuno risponde,
    // `midi.enable()` non risolve e non respinge — resta li'. Senza un avviso,
    // il bottone passava a "Exit" e non succedeva NULLA per due minuti: si
    // credeva che il pulsante non funzionasse. In pratica, in un browser dove
    // nessuno clicca "Consenti", l'esercizio era irraggiungibile senza
    // nessuna spiegazione.
    setPreparing('midi');
    if (!midi.isEnabled) {
      try {
        await midi.enable();
      } catch (err) {
        console.error('[ScorePage] permesso MIDI negato:', err);
        setPreparing(null);
        practice.reset();
        setIsPractice(false);
        return;
      }
      // L'input si popola al tick successivo: senza questa attesa le prime note
      // del primo passo non arriverebbero a nessuno.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    setPreparing('piano');
    await practice.start(await file.text());
    setPreparing(null);
  }, [file, midi, practice]);

  const stopPractice = useCallback(() => {
    setIsPractice(false);
    // Nessuna mano da riaccendere, nessuna tastiera da richiudere: uscire dalla
    // pratica non è un gesto sugli interruttori, e dal 2026-11-10 non ne tocca
    // nessuno. La prossima sessione riparte dalle scelte già fatte.
    // Anche l'attesa va interrotta: senza questo, uscire mentre il browser
    // chiede il permesso lascerebbe a schermo il pannello "concedi il
    // permesso", con la pratica gia' chiusa.
    setPreparing(null);
    practice.reset();
    stepStartRef.current = 0;
    lastLenRef.current = 0;
    lastSigRef.current = '';
  }, [practice]);

  /**
   * Manda al servizio gli eventi suonati davanti al passo corrente.
   *
   * Scatta quando l'insieme dei tasti premuti CAMBIA, non a ogni evento: un
   * rilascio non cambia niente di quello che una regola di pratica guarda, e
   * far partire una richiesta anche per i rilasci significherebbe quattro
   * richieste per un accordo invece di due. Il verdetto di un passo costa ~2 s
   * sul servizio deployato, quindi i rilasci in coda terrebbero il pannello
   * indietro di parecchi secondi senza aggiungere nessuna informazione.
   *
   * L'avanzamento del cursore NON dipende da questa richiesta: lo decide
   * `usePractice` in locale, ed è la ragione per cui la latenza del verdetto non
   * si sente mentre si suona.
   */
  useEffect(() => {
    // Con tutti e due gli interruttori spenti non si chiede niente: le note
    // suonate in pausa restano nella registrazione e vengono giudicate quando
    // si riaccende, come pressioni extra del passo corrente. Il confine
    // lastLenRef resta indietro di proposito, cosi' al ritorno non si perdono.
    if (!isPractice || practice.phase !== 'ready' || handSel.paused) return;
    const rec = midi.recording;
    if (rec.length === lastLenRef.current) return;
    lastLenRef.current = rec.length;

    const eventi = rec.slice(stepStartRef.current);
    const sig = pressedPitches(eventi).join(',');
    if (sig === lastSigRef.current) return;   // solo rilasci: niente da dire
    lastSigRef.current = sig;

    practice.submit(eventi);
  }, [midi.recording, midi.recording.length, isPractice, practice, handSel.paused]);

  // Gli interruttori L/R diventano la mano da chiedere al servizio solo quando
  // il risultato e' DIVERSO da quella gia' scelta: `setHand` rifà il piano ogni
  // volta che lo si richiama, anche con lo stesso valore, e una richiesta
  // inutile a ogni render sarebbe un esercizio che si rifiatta da capo. In
  // pausa non si chiama proprio: il piano resta quello che c'e', cosi'
  // riaccendere un interruttore non costa nessuna richiesta.
  useEffect(() => {
    if (!isPractice || handSel.paused) return;
    const h = handSel.target === 'both' ? null : handSel.target;
    if (h !== practice.hand) void practice.setHand(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPractice, handSel.paused, handSel.target]);

  // La mano spenta spegne di grigio ANCHE il suo rigo nello spartito, come il
  // suo tasto sulla barra (richiesta esplicita 2026-11-07: "quando L o R sono
  // spenti il pentagramma rispettivo diventi grigio come il tasto; se non e'
  // possibile tutto il pentagramma almeno le sue note"). Si puo' fare tutto il
  // rigo: OSMD racchiude le misure di ogni singolo rigo in un gruppo
  // `g.staffline` con id che finisce -1 (sopra, la destra) o -2 (sotto, la
  // sinistra), misurato nel DOM il 2026-11-07. Il numero di rigo e' un dato del
  // rendering, non un'altezza delle note: le altezze non sono mai affidabili
  // oltre i confini (lezione dell'octave-shift, vedi il cursore).
  //
  // Qui la pagina applica solo una classe, che vive nel CSS di questo file:
  // nessun colore per singolo tracciato, quindi nessuna collisione con i
  // salvataggi di fill/stroke dei marchi rossi a fine prova, e ripristinare
  // significa togliere la classe. Uscire dalla pratica o rientrarvi la toglie
  // da ogni rigo: fuori dalla pratica nessun rigo e' mai "spento".
  useEffect(() => {
    const gray = staffGray(practice.hands, handsOn);
    const apply = () => {
      for (const [suffix, off] of [['-1', isPractice && gray.upper], ['-2', isPractice && gray.lower]] as const) {
        for (const g of document.querySelectorAll<SVGGElement>(`#sheet-container g.staffline[id$="${suffix}"]`)) {
          g.classList.toggle('osmd-staff-off', off);
        }
      }
    };
    apply();
    // Se il rendering si rifà (ridimensionamento della finestra), i gruppi sono
    // nuovi e la classe e' persa: un rigo spento sembrerebbe vivo. E' l'unico
    // evento per cui vale la pena riapplicare.
    const reapply = () => apply();
    window.addEventListener('resize', reapply);
    return () => window.removeEventListener('resize', reapply);
  }, [isPractice, practice.hands, handsOn]);

  // Il cursore e' avanzato: il prossimo passo comincia da dove siamo ora.
  //
  // Sta in un effetto e non dentro `submit` perche' l'avanzamento lo decide
  // l'hook, e leggerne l'esito subito dopo la chiamata darebbe il valore
  // vecchio. Cosi' invece si sposta il confine quando React ha gia' reso il
  // nuovo indice, che e' esattamente quando serve.
  useEffect(() => {
    if (!isPractice) return;
    stepStartRef.current = lastLenRef.current;
    lastSigRef.current = '';
  }, [practice.index, isPractice]);

  // Il cursore segue il passo. E' l'unica cosa che muove lo spartito in questa
  // modalita': il player non parte mai, quindi `followCursor` non ha niente da
  // seguire e il cursore lo si guida a mano.
  //
  // Il posizionamento e' per POSIZIONE, non per nota: la fermata k del cursore
  // corrisponde al passo k del piano (misurato: 128 su 128). Il confronto per
  // pitch non e' usabile, perche' OSMD riporta le note tre ottave sotto rispetto
  // al piano, e un offset scritto nel codice cambierebbe col prossimo spartito.
  // Vedi la funzione `moveCursorToStep` per la misura.
  //
  // LA POSIZIONE DA RAGGIUNGERE E' `attack`, NON `index`. Il cursore di OSMD
  // cammina su TUTTI gli attacchi della partitura; un esercizio a mano sola ne
  // salta una parte, e allora il quinto passo dell'esercizio non e' piu' la quinta
  // fermata del rigo: il servizio lo sa e lo manda gia' scritto nel passo. Passare
  // `index` con una mano sola non da' nessun errore: il segno si posiziona sulla
  // nota sbagliata due volte su tre, e l'allievo suona quella che vede.
  useEffect(() => {
    if (!isPractice || practice.phase !== 'ready') return;
    const passo = practice.steps[practice.index];
    if (!passo) return;
    cursorStepRef.current = moveCursorToStep(
      osmdRef.current, passo.attack, cursorStepRef.current,
    );
  }, [isPractice, practice.phase, practice.index, practice.steps]);

  // Uscendo dalla pratica il cursore si nasconde: era li' per indicare dove
  // sei nell'esercizio, e fuori dall'esercizio non indica niente. Tornando alla
  // modalita' normale lo riprende in carico il player, con followCursor.
  useEffect(() => {
    if (isPractice) return;
    cursorStepRef.current = -1;
    try {
      osmdRef.current?.cursors?.[0]?.hide();
    } catch {
      // OSMD non ancora pronto, o gia' distrutto
    }
  }, [isPractice]);

  // Il verdetto non elenca più le regole:colora di rosso i punti dello spartito
  // in cui l'esecuzione è caduta, e il mouse sopra una nota nomina ciò che non
  // è stato rispettato lì. È quello che serviva davvero: un riquadro che dice
  // "pitch-agreement violato" senza dire DOVE obbliga l'allievo a cercarsi
  // l'errore da solo, nota per nota.
  //
  // Il cammino verso la nota conta — lo stesso primitivo della modalità pratica,
  // misurato lì 128 fermate su 128 — perché le altezze fra i due lati non
  // combinano mai (octave-shift; allineamento/_probe_osmd.mjs).
  //
  // I colori si cancellano da soli quando arriva un verdetto nuovo: la
  // dipendenza che riaccende l'effetto è anche quella che spazza la pennellata
  // prima. "Close" NON cancella più niente (richiesta 2026-11-10: quando si
  // clicca close si deve poter vedere lo spartito finché non si ricomincia da
  // capo, azione fatta dall'utente): a portare via i colori ci pensa il reset
  // che handlePlayAlong fa al riavvio, e un verdetto che torna a null — caso
  // solo teorico ora — ripulisce comunque la tela dall'effetto stesso.
  const marksRef = useRef<MarkState | null>(null);
  const [markedSpots, setMarkedSpots] = useState(0);
  const [missedRules, setMissedRules] = useState<string[]>([]);
  // "Close" nasconde la carta centrata e basta: rossi, verdi e punte hover
  // restano dove sono. Questa bandierina si alza alla crocetta e si abbassa
  // solo quando una nuova prova parte — nessun altro la tocca.
  const [cardDismissed, setCardDismissed] = useState(false);

  // La card che appare mentre il mouse sta su una nota rossa: coordinate del
  // puntatore e contenuto preso dalla mappa markTips. Niente <title> nativo —
  // la richiesta del 2026-11-10 vuole una card nel tema del sito.
  const [tipHover, setTipHover] = useState<{ x: number; y: number; tip: MarkTip } | null>(null);

  useEffect(() => {
    clearScoreMarks(marksRef.current);
    marksRef.current = null;
    setMarkedSpots(0);
    setMissedRules([]);
    setTipHover(null); // il verdetto che si rinnova non deve lasciare una card su una nota ormai scolorita
    if (verdict.status !== 'done' || !verdict.verdicts || isPractice) return;
    const plan = planMarks(verdict.verdicts, verdict.correct);
    const out = paintScoreMarks(osmdRef.current, plan.columns, plan.green);
    marksRef.current = out.state;
    setMarkedSpots(out.painted);
    setMissedRules(out.missed);
    if (out.firstEl) {
      // il punto in cui andare a vedere per primo: un verdetto che dice dove è
      // successo e ti lascia in cima alla pagina ti fa comunque cercare l'errore.
      // Se di rossi non c'è niente, non si scorre da nessuna parte: la carta del
      // punteggio arriva da sola davanti agli occhi, dove lo sguardo sta già.
      out.firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [verdict.status, verdict.verdicts, verdict.correct, isPractice]);

  /** Il voto 0-100 della carta centrata — lo decide `performanceScore`, qui si legge e basta. */
  const scoreOutcome = useMemo(
    () => (verdict.status === 'done' && verdict.verdicts
      ? performanceScore(verdict.verdicts, verdict.noteCount)
      : null),
    [verdict.status, verdict.verdicts, verdict.noteCount],
  );

  // Un solo ascoltatore di hover per tutta la pagina, attaccato a window: le
  // teste rosse nascono e muoiono a ogni verdetto e a ogni re-render di OSMD,
  // e rincorrerle con i listener sarebbe l'ennesimo posto dove il conto può
  // divergere. Si guarda cosa c'è sotto il puntatore, e se la mappa ce l'ha fra
  // le bagne del rosso si mostra la sua card — una sola alla volta, quella che
  // interessa. La pagina che scorre o gira la rotellina la nasconde: una card
  // ferma nel punto vecchio mentre la nota è volata via mentirebbe.
  useEffect(() => {
    const headUnder = (t: EventTarget | null) =>
      (t as Element | null)?.closest?.('g.vf-notehead') ?? null;
    const onOver = (e: PointerEvent) => {
      const head = headUnder(e.target);
      if (!head) return;
      const tip = markTips.get(head as SVGGElement);
      if (tip) setTipHover({ x: e.clientX, y: e.clientY, tip });
    };
    const onOut = (e: PointerEvent) => {
      const head = headUnder(e.target);
      if (!head) return;
      // dentro la stessa testa si passa fra path figli: non è un'uscita
      if (headUnder(e.relatedTarget) === head) return;
      setTipHover(null);
    };
    const hide = () => setTipHover(null);
    window.addEventListener('pointerover', onOver);
    window.addEventListener('pointerout', onOut);
    window.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('scroll', hide, { passive: true });
    return () => {
      window.removeEventListener('pointerover', onOver);
      window.removeEventListener('pointerout', onOut);
      window.removeEventListener('wheel', hide);
      window.removeEventListener('scroll', hide);
    };
  }, []);

  // Re-enable MIDI from upload page state
  useEffect(() => {
    if (midiEnabled && !midi.isEnabled) {
      midi.enable().then(() => {
        if (midiInputId) {
          // Wait a tick for inputs to populate
          setTimeout(() => midi.selectInput(midiInputId), 200);
        }
      });
    }
  }, [midiEnabled, midiInputId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Fine della prova: lo spartito si ferma e il verdetto parte da solo. */
  const finishPlayAlong = useCallback(async () => {
    setPhase('idle');
    setIsPlaying(false);
    setProgress(100);
    playerRef.current?.pause();
    await runAnalysis();
  }, [runAnalysis]);

  /** Inizia la prova: conta alla rovescia, poi lo spartito suona e registra. */
  const handlePlayAlong = useCallback(async () => {
    const player = playerRef.current;
    if (!player || isLoading) return;
    if (!midi.isEnabled) {
      await midi.enable();
      // L'input MIDI si popola al tick successivo: senza questa attesa i primi
      // eventi della prova verrebbero persi e l'analisi partirebbe zoppa.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    player.pause();
    player.rewind();
    midi.clearRecording();
    takeStartRef.current = null;
    // Il referto della prova precedente resta sulla pagina finché l'utente non
    // ricomincia da capo, e "Play along" E quel riavvio: qui carta, rossi e
    // verdi se ne vanno insieme (richiesta 2026-11-10). Il voto nuovo non deve
    // poter accusare la prova due con gli errori della prova uno.
    verdict.reset();
    setCardDismissed(false);
    setProgress(0);
    setCount(COUNTDOWN_FROM);
    setPhase('countdown');
    // Il click sul "3" si sente subito: qui c'è ancora il gesto utente che
    // autorizza l'audio, dopo sarà troppo tardi per lo sblocco del contesto.
    playTick(false);
  }, [isLoading, midi, verdict]);

  /**
   * Il countdown tiene premuto il musicista al tastierino, poi parte tutto.
   * I click si suonano nel callback del timer, non nel corpo dell'effetto:
   * in dev StrictMode l'effetto viene montato due volte e dal corpo partirebbero
   * doppi flam; dal callback, che il cleanup disarma insieme al timer, uno solo.
   */
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (count > 0) {
      const timer = setTimeout(() => {
        const next = count - 1;
        playTick(next === 0);
        setCount(next);
      }, COUNTDOWN_STEP_MS);
      return () => clearTimeout(timer);
    }
    // Il brano parte ADESSO: e' l'origine dei tempi della presa, e va letta
    // prima di play(), dallo stesso orologio dei timestamp MIDI.
    takeStartRef.current = performance.now();
    playerRef.current?.play();
    setIsPlaying(true);
    setPhase('playing');
  }, [phase, count]);

  // Avanziamento e fine brano. La fine non si deduce dal comportamento: la
  // dichiarano il motore audio stesso o i suoi fatti nudi, in questo ordine —
  // (1) `songEnded` dall'eventHandler del sequencer: parte SOLO quando il
  //     worklet ha esaurito la traccia (bundle: pausa con isFinished →
  //     callEventInternal songEnded); (2) il CALO di `.loopCount` sul thread
  //     principale, che è come il messaggio loopCountChange del worklet arriva
  //     davvero (il caso nel sorgente aggiorna il campo e non chiama
  //     l'eventHandler): salto dichiarato, e `consumedFullTrack` risponde se
  //     quel salto era la fine travestita da ripartenza (il bug denunciato
  //     dall'utente) o la ripetizione scritta del brano, che si registra e si
  //     continua a suonare; (3-4) le due regole di `endSignal` (scoreMarks.ts)
  //     come rete quando il canale eventi tace: il tetto del getter di
  //     position, impossibile prima del consumo, o la caduta a traccia già
  //     consumata. In cima a tutto, la verità del worklet; sotto, solo fatti
  //     letti con certezza; nessuna soglia percentuale — quella l'utente l'ha
  //     respinta il 2026-11-10.
  useEffect(() => {
    if (phase === 'countdown') return;
    if (phase === 'idle' && !isPlaying) return;
    let animationId: number;
    let lastPos = -1;
    let prevPos = -1;
    let stalledSince = 0;
    // Contatore di bordo: somma degli avanzamenti POSITIVI di position. Su una
    // sequenza che sale e basta (o risale solo riavvolgendo) vale quanto la
    // posizione reale, ed è l'unica cosa che può dirlo quando la cima da 2 ms
    // non viene mai campita perché il passo del tick la scavalca. Serve anche
    // come misura per la domanda sul salto di loop dichiarato (punto 2).
    let percorso = 0;
    let passoMax = 0;
    // Una sola chiusura per presa, chiunque l'abbia trovata: songEnded e il
    // tick possono arrivare nello stesso battito, e una doppia analisi
    // pubblicherebbe due verdetti sullo stesso tiro.
    let chiuso = false;
    const chiudi = () => {
      if (chiuso) return;
      chiuso = true;
      void finishPlayAlong();
    };
    const inPresa = phase === 'playing';
    const seq = (playerRef.current as any)?._sequencer;
    const eventi = seq?.eventHandler;
    let contLoops: number | null = typeof seq?.loopCount === 'number' ? seq.loopCount : null;
    if (inPresa && eventi?.addEvent) {
      try {
        eventi.addEvent('songEnded', 'cadenza-take', () => chiudi());
      } catch {
        /* build sconosciuta del sequencer: restano i fatti letti dal tick */
      }
    }
    const tick = (now: number) => {
      const player = playerRef.current;
      if (player) {
        const dur = player.duration;
        const pos = player.position;
        if (dur > 0) {
          setProgress((pos / dur) * 100);
          if (inPresa) {
            // Fatto dichiarato 2: il worklet ha contato un salto di loop e il
            // thread principale l'ha scritto in .loopCount. La domanda "fine o
            // ripetizione?" la decide il modulo puro, col contatore di bordo.
            const loops = typeof seq?.loopCount === 'number' ? seq.loopCount : null;
            if (loops !== null && contLoops !== null && loops < contLoops) {
              contLoops = loops;
              if (consumedFullTrack(dur, percorso, passoMax)) {
                chiudi();
                return;
              }
              //else: salto a metà brano = la ripetizione scritta che torna
              // indietro: fa parte dell'esecuzione, si continua a registrare.
            } else if (loops !== null) {
              contLoops = loops;
            }
            // Il contatore di bordo si aggiorna prima di ogni giudizio: i passi
            // positivi sono distanza percorsa sulla traccia; cadute e fermate
            // non vi aggiungono niente.
            const passo = pos - prevPos;
            if (passo > 0) {
              percorso += passo;
              if (passo > passoMax) passoMax = passo;
            }
            // Fatti 3-4: tetto toccato, o caduta a traccia già consumata.
            const esito = endSignal(dur, pos, prevPos, percorso, passoMax);
            if (esito !== null) {
              chiudi();
              return;
            }
            // Rete di sicurezza: il sequencer fermo prima del fondo non
            // arriverebbe mai a duration, e la prova resterebbe aperta per
            // sempre senza che nessuno lo noti.
            if (pos === lastPos) {
              if (stalledSince === 0) stalledSince = now;
              else if (now - stalledSince > STALL_MS) {
                chiudi();
                return;
              }
            } else {
              lastPos = pos;
              stalledSince = 0;
            }
          }
          prevPos = pos; // il prelievo precedente: base della differenza, non soglia
        }
      }
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animationId);
      if (eventi?.removeEvent) {
        try {
          eventi.removeEvent('songEnded', 'cadenza-take');
        } catch {
          /* il player è già stato distrutto: l'ascoltatore muore con lui */
        }
      }
    };
  }, [phase, isPlaying, finishPlayAlong]);

  // Initialize player with OSMD renderer
  useEffect(() => {
    if (!file) {
      navigate('/upload');
      return;
    }

    let destroyed = false;

    const initPlayer = async () => {
      try {
        setLoadingMessage('Loading the music engine...');

        // Dynamically import the library
        const lib = await import('@music-i18n/musicxml-player');
        Player = lib.Player;
        OpenSheetMusicDisplayRenderer = lib.OpenSheetMusicDisplayRenderer;
        VerovioConverter = lib.VerovioConverter;

        if (destroyed) return;

        setLoadingMessage('Reading the score file...');

        // Read the file as ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();

        if (destroyed) return;

        setLoadingMessage('Rendering the notation...');

        const renderer = new OpenSheetMusicDisplayRenderer(
          {
            backend: 'svg',
            followCursor: true,
            drawCredits: true,
            drawTitle: true,
            drawComposer: true,
            drawPartNames: true,
            // Configure cursors for practice mode
            cursorsOptions: [
              {
                type: 0,         // Standard vertical line
                color: '#C5A880',
                alpha: 0.6,
                follow: true,
              },
            ],
          }
        );

        // VerovioConverter generates MIDI + timemap in-browser. 
        // We use Bravura (which is completely standard) to bypass Leipzig font loading errors.
        const converter = new VerovioConverter({
          font: 'Bravura'
        });

        // Il tempo scritto nello spartito decide il valore iniziale dello slider: chi
        // preme play sente il brano come e' scritto, e chi vuole rallentare lo
        // fa apposta.
        const written = readScoreBpm(await file.text());
        setScoreBpm(written);
        setBpm(written);

        // Create the player
        const player = await Player.create({
          musicXml: arrayBuffer,
          container: containerRef.current!,
          renderer,
          converter,
          followCursor: true,
          velocity: 1,
          repeat: 1,
        });

        if (destroyed) {
          player.destroy();
          return;
        }

        playerRef.current = player;

        // Extract the OSMD instance from the renderer
        console.log('[ScorePage] Renderer keys:', Object.keys(renderer));
        const osmd = (renderer as any).osmd || (renderer as any)._osmd;
        if (osmd) {
          osmdRef.current = osmd;
          console.log('[ScorePage] OSMD instance acquired. Cursors:', osmd.cursors?.length ?? 0);

          // Rimosso l'override manuale forzato - ci affidiamo al comportamento naturale di OSMD
          // una volta risolto il caricamento del font SMuFL in Verovio


          // Ensure cursors are initialized — hide them initially
          if (osmd.cursors?.length > 0) {
            osmd.cursors[0].hide();
          }
        } else {
          console.warn('[ScorePage] OSMD instance not found on renderer._osmd');
        }

        setIsLoading(false);
      } catch (err: any) {
        console.error('Player initialization error:', err);
        if (!destroyed) {
          setError(err.message || 'Failed to load the score. Please try another file.');
          setIsLoading(false);
        }
      }
    };

    initPlayer();

    return () => {
      destroyed = true;
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
      osmdRef.current = null;
    };
  }, [file, navigate]);

  // ── Playback Controls ──────────────────────────────

  /**
   * Lo slider cambia solo il fattore di riascolto. Non ricostruisce il MIDI:
   * il player lo converte una volta sola al caricamento, e i tempi che ci sono
   * dentro restano quelli del tempo scritto. Per questo chi imposta un tempo
   * diverso da quello di apertura non ottiene lo spartito riscritto, ottiene lo
   * stesso spartito riprodotto piu' piano — che e' quello che serve, e molto
   * meno caro.
   *
   * Il tempo non si tocca durante la prova: il fattore che va al servizio
   * viene letto una volta sola, all'inizio, e se cambiasse a metà il verdetto
   * sarebbe calcolato con una scala sbagliata per tutta la seconda parte.
   */
  useEffect(() => {
    if (phase === 'playing' || phase === 'countdown') return;
    const player = playerRef.current;
    if (player) player.velocity = bpm / scoreBpm;
  }, [bpm, scoreBpm, phase]);

  const handlePlayPause = useCallback(() => {
    const player = playerRef.current;
    if (!player || phase === 'countdown' || phase === 'playing') return;
    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    } else {
      player.play();
      setIsPlaying(true);
    }
  }, [isPlaying, phase]);

  // Stop interrompe anche una prova in corso. La registrazione resta: se il
  // brano è stato interrotto a metà, il musicista di solito vuole riascoltare
  // quello che ha già suonato, e "Play along" riparte comunque da zero.
  const handleStop = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    player.pause();
    player.rewind();
    setProgress(0);
    setIsPlaying(false);
    setPhase('idle');
  }, []);

  // Space bar play/pause (only in playback mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ' && !isLoading && phase !== 'countdown' && phase !== 'playing') {
        e.preventDefault();
        handlePlayPause();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePlayPause, isLoading, phase]);

  // ── Render ─────────────────────────────────────────

  // La riga compatta del verdetto. La decisione di COSA mostrare sta nel modulo
  // puro (`stepProblem`), dove i test la provano: qui non c'e' nessuna soglia e
  // nessun giudizio, come recita il contratto di questa cartella.
  const problem = stepProblem({
    last: practice.last,
    stepIndex: practice.index,
    judging: practice.judging,
    error: practice.error,
    dynamicsOn: practice.dynamicsOn,
  });

  // La tastiera si disegna per com'e' lo strumento, non per quanto e' largo il
  // brano: tutti e 88 i tasti (A0-C8), voluti dall'utente. Qui prima c'era una
  // finestra calcolata sui passi, e aveva un bug che vale la pena raccontare perche'
  // il tipo non lo vedeva: `min` teneva il massimo e `max` il minimo, cosi' l'altezza
  // della finestra veniva chiusa sul pitch PIU' BASSO del brano. Sul brano di prova
  // (46..93) usciva una tastiera di un'ottava sola, e il secondo tasto del passo —
  // l'A5 — non era nemmeno disegnato. Il compilatore non dice niente perche' i conti
  // erano legibili; quello che mancava era la prova visiva, che qui non puo' girare.
  const passoCorrente = practice.steps[practice.index];

  if (error) {
    return (
      <div className="score-page container">
        <div className="score-error">
          <h2 className="heading">Unable to Load Score</h2>
          <p>{error}</p>
          <button className="btn btn-primary" onClick={() => navigate('/upload')}>
            <ArrowLeft size={18} /> Try Another File
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="score-page">
      {/* Simplified Header — back button + status of the take */}
      <div className="score-header container">
        <button className="back-btn" onClick={() => navigate('/upload')}>
          <ArrowLeft size={20} />
        </button>

        {(phase === 'countdown' || phase === 'playing') && (
          <div className="practice-status">
            <span className="practice-status-dot" />
            {phase === 'countdown' ? 'Ready…' : 'Take in progress'}
          </div>
        )}
      </div>

      {/* La tastiera di richiamo, sopra la striscia dei comandi. C'e' solo quando
          l'esercizio e' pronto: durante l'attesa del permesso MIDI o del piano non
          c'e' nessun passo da accendere, e una tastiera con i tasti tutti spenti
          sarebbe un disegno che mente. Con le mani tutte spente vale la stessa
          ragione: nessun tasto viene chiesto, e una tastiera buia mentirebbe. */}
      {isPractice && keyboardOpen && passoCorrente && !handSel.paused && (
        <PianoKeyboard
          expected={passoCorrente.pitch}
          pressed={practice.status?.pressed ?? []}
          extra={practice.status?.extra ?? []}
          offhand={passoCorrente.offhand ?? []}
        />
      )}

      {/* Gli stati della pratica: la barra dei comandi quando si suona, una riga
          di avviso mentre si aspetta o quando qualcosa e' andato storto. Sta al
          posto dei verdetti, non accanto: sono due modi diversi di giudicare la
          stessa esecuzione, e mostrarli insieme farebbe credere che il verdetto a
          fine brano valga anche qui. */}
      {isPractice && (practice.phase !== 'idle' || preparing !== null) && (
        preparing === 'midi' ? (
          /* L'attesa del permesso. Il browser ha aperto una finestra di
             conferma: se nessuno risponde, questa resta l'unica cosa che si
             vede, ed e' gia' il motivo per cui non succede nient'altro. */
          <section className="practice-bar practice-notice">
            <p>
              Allow the MIDI keyboard so the steps can be played. The browser&apos;s
              prompt may already be open behind this window.
            </p>
            <button className="pb-chip" onClick={stopPractice}>Exit</button>
          </section>
        ) : preparing === 'piano' ? (
          <section className="practice-bar practice-notice">
            <p>Reading the score and preparing the steps…</p>
          </section>
        ) : practice.phase === 'error' ? (
          <section className="practice-bar practice-notice practice-notice-bad">
            <p>
              {practice.error ?? 'Could not prepare the steps for this score.'}
            </p>
            <button className="pb-chip" onClick={stopPractice}>Exit</button>
          </section>
        ) : practice.phase === 'loading' ? (
          <section className="practice-bar practice-notice">
            <p>Switching hand and re-preparing the steps…</p>
          </section>
        ) : (
          <PracticeBar
            problem={problem}
            judging={practice.judging}
            hands={practice.hands}
            handsOn={handsOn}
            onHandToggle={(h) => setHandsOn((s) => ({ ...s, [h]: !s[h] }))}
            handsOff={handSel.paused}
            dynamicsOn={practice.dynamicsOn}
            onDynamicsChange={practice.setDynamicsOn}
            keyboardOpen={keyboardOpen}
            onKeyboardToggle={() => setKeyboardOpen((v) => !v)}
          />
        )
      )}

      {/* Score Container */}
      <div className="score-container">
        {isLoading && (
          <div className="loading-overlay">
            <div className="loading-spinner" />
            <p className="loading-text">{loadingMessage}</p>
          </div>
        )}
        <div ref={containerRef} className="sheet-container" id="sheet-container" />

        {/* Countdown. Copre lo spartito per non distrarre: il musicista sta
            guardando le mani, non la pagina. */}
        {phase === 'countdown' && (
          <div className="countdown-overlay">
            {/* La durata del disegno arriva dallo stesso COUNTDOWN_STEP_MS che
                batte i click: l'animazione occupa tutto il secondo del numero e
                non può mai restare congelata a metà (vedi ScorePage.css). */}
            <div className="countdown-value" key={count}
                 style={{ animationDuration: `${COUNTDOWN_STEP_MS}ms` }}>
              {count > 0 ? count : 'Go'}
            </div>
            <p className="countdown-hint">Get ready, starting shortly</p>
          </div>
        )}
      </div>

      {/* Il verdetto adesso è una carta centrata su ciò che si sta guardando,
          non un riquadro da raggiungere col mouse in fondo al foglio (richiesta
          2026-11-10): il numero sale davanti agli occhi, i rossi sulla partitura
          restano visibili dietro e intorno a dirne il dove. */}
      {!isPractice && verdict.status !== 'idle' && !cardDismissed && (
        <PerformanceCard
          status={verdict.status}
          error={verdict.error}
          outcome={scoreOutcome}
          lines={verdict.status === 'done' && verdict.verdicts
            ? summaryLines(
              planMarks(verdict.verdicts),
              markedSpots,
              missedRules,
              verdict.noteCount,
            )
            : []}
          onClose={() => setCardDismissed(true)}
          onPlayAgain={() => void handlePlayAlong()}
        />
      )}

      {tipHover && <ErrorHoverCard tip={tipHover.tip} x={tipHover.x} y={tipHover.y} />}

      {/* Floating Bottom Bar — always visible */}
      {!isLoading && (
        <PlaybackBar
          isPlaying={isPlaying}
          isTakeActive={phase === 'countdown' || phase === 'playing'}
          isLoading={isLoading}
          progress={progress}
          onPlayPause={handlePlayPause}
          onStop={isPractice ? stopPractice : handleStop}
          onPlayAlong={handlePlayAlong}
          bpm={bpm}
          scoreBpm={scoreBpm}
          onBpmChange={setBpm}
          isPractice={isPractice}
          onPractice={() => void startPractice()}
          onPracticeStop={stopPractice}
        />
      )}
    </div>
  );
};

export default ScorePage;
