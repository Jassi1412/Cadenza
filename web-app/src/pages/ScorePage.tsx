import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useMidi } from '../hooks/useMidi';
import { useVerdict } from '../hooks/useVerdict';
import { usePractice } from '../hooks/usePractice';
import { pressedPitches, stepProblem } from '../hooks/practiceSteps';
import PlaybackBar from '../components/PlaybackBar';
import PracticeBar from '../components/PracticeBar';
import PianoKeyboard from '../components/PianoKeyboard';
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
 * eventi, quindi la fine del brano non si può osservare: si deduce qui,
 * interrogando position >= duration. La tolleranza evita che l'ultimo
 * millisecondo venga tagliato.
 */
type Phase = 'idle' | 'countdown' | 'playing';

/**
 * Margine con cui `position` si considera arrivato alla fine.
 *
 * Non è una tolleranza arbitraria: `Player.position` è definito come
 * `min(currentTime * 1000, duration - 1)`, quindi non può MAI raggiungere
 * `duration`. Con un margine generoso il brano finiva 250 ms prima del vero
 * fondo e l'ultima nota restava fuori dal verdetto. Qui si segue il tetto
 * reale, con 1 ms di respiro per l'arrotondamento in virgola mobile.
 */
const END_SLACK_MS = 2;

/**
 * Se `position` resta fermo mentre si dovrebbe sentire qualcosa, il sequencer
 * non arrivera' mai al fondo. Chiudere la prova e' meglio che non darla mai.
 */
const STALL_MS = 2000;

/** Silenzio fra un numero e l'altro del countdown, in ms. */
const COUNTDOWN_STEP_MS = 750;

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
  const runAnalysis = useCallback(async () => {
    if (!file) return;
    try {
      const scoreXml = await file.text();
      await verdict.analyse(scoreXml, scoreBpm / bpm);
    } catch (err) {
      console.error('[ScorePage] Non sono riuscito a leggere lo spartito:', err);
    }
  }, [file, verdict, scoreBpm, bpm]);

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

  /**
   * La tastiera di richiamo, aperta o chiusa dal pulsante a forma di pianoforte.
   *
   * Parte APERTA: da quando la riga non porta piu' "1/128" e "0/2 tasti", la
   * tastiera accesa e' l'equivalente visivo di quel contatore, e chi entra in
   * pratica deve trovare il tasto subito, non dopo un clic su un'icona. Si puo'
   * chiudere in qualunque momento con lo stesso pulsante, e la scelta non tocca
   * niente dell'esercizio: e' solo vista.
   */
  const [keyboardOpen, setKeyboardOpen] = useState(true);

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
    setKeyboardOpen(true);
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
    setKeyboardOpen(false);
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
    if (!isPractice || practice.phase !== 'ready') return;
    const rec = midi.recording;
    if (rec.length === lastLenRef.current) return;
    lastLenRef.current = rec.length;

    const eventi = rec.slice(stepStartRef.current);
    const sig = pressedPitches(eventi).join(',');
    if (sig === lastSigRef.current) return;   // solo rilasci: niente da dire
    lastSigRef.current = sig;

    practice.submit(eventi);
  }, [midi.recording, midi.recording.length, isPractice, practice]);

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

  // Il verdetto arriva da solo, a fine brano, mentre l'attenzione è sullo
  // spartito: senza questo il pannello si aprirebbe sotto la piega e sembrerebbe
  // non essere arrivato. Lo scroll-margin-bottom in .verdict-panel gli impedisce
  // di fermarsi sotto la barra dei comandi.
  const verdictPanelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (verdict.status === 'done') {
      verdictPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [verdict.status]);

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
    setProgress(0);
    setCount(3);
    setPhase('countdown');
  }, [isLoading, midi]);

  /** Il countdown tiene premuto il musicista al tastierino, poi parte tutto. */
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (count > 0) {
      const timer = setTimeout(() => setCount((c) => c - 1), COUNTDOWN_STEP_MS);
      return () => clearTimeout(timer);
    }
    playerRef.current?.play();
    setIsPlaying(true);
    setPhase('playing');
  }, [phase, count]);

  // Avanziamento e fine brano. PlayerState non ha uno stato "finito" e il player
  // non emette eventi, quindi la fine si deduce da position contro duration.
  // position è bloccato a duration - 1 dal player stesso: la soglia segue quel
  // tetto, non un margine arbitrario, altrimenti il brano chiude prima del
  // fondo reale e l'ultima nota resta fuori dal verdetto.
  useEffect(() => {
    if (phase === 'countdown') return;
    if (phase === 'idle' && !isPlaying) return;
    let animationId: number;
    let lastPos = -1;
    let stalledSince = 0;
    const tick = (now: number) => {
      const player = playerRef.current;
      if (player) {
        const dur = player.duration;
        const pos = player.position;
        if (dur > 0) {
          setProgress((pos / dur) * 100);
          if (phase === 'playing') {
            if (pos >= dur - END_SLACK_MS) {
              void finishPlayAlong();
              return;
            }
            // Rete di sicurezza: il sequencer fermo prima del fondo non
            // arriverebbe mai a duration, e la prova resterebbe aperta per
            // sempre senza che nessuno lo noti.
            if (pos === lastPos) {
              if (stalledSince === 0) stalledSince = now;
              else if (now - stalledSince > STALL_MS) {
                void finishPlayAlong();
                return;
              }
            } else {
              lastPos = pos;
              stalledSince = 0;
            }
          }
        }
      }
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
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
          sarebbe un disegno che mente. */}
      {isPractice && keyboardOpen && passoCorrente && (
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
            stepIndex={practice.index}
            total={practice.steps.length}
            measure={practice.steps[practice.index]?.measure ?? 0}
            expected={practice.steps[practice.index]?.pitch ?? []}
            status={practice.status}
            problem={problem}
            verdictStep={practice.verdictStep}
            judging={practice.judging}
            hand={practice.hand}
            hands={practice.hands}
            onHandChange={(h) => void practice.setHand(h)}
            dynamicsOn={practice.dynamicsOn}
            onDynamicsChange={practice.setDynamicsOn}
            keyboardOpen={keyboardOpen}
            onKeyboardToggle={() => setKeyboardOpen((v) => !v)}
            suspended={practice.suspended}
            /* Un errore di rete non ferma l'esercizio: si segnala qui e si
               continua a suonare. Interrompere un allievo per un problema del
               servizio sarebbe la cosa peggiore che questa pagina possa fare. */
            error={practice.error}
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
            <div className="countdown-value" key={count}>{count > 0 ? count : 'Go'}</div>
            <p className="countdown-hint">Get ready, starting shortly</p>
          </div>
        )}
      </div>

      {/* Verdicts — appear only after the performance has been analysed */}
      {!isPractice && verdict.status !== 'idle' && (
        <section className="verdict-panel" ref={verdictPanelRef}>
          <div className="verdict-panel-head">
            <h2 className="heading">Verdicts</h2>
            {verdict.status === 'done' && (
              <button className="btn btn-outline" onClick={verdict.reset}>Close</button>
            )}
          </div>

          {verdict.status === 'working' && <p className="verdict-note">Aligning the performance and checking the seven rules…</p>}

          {verdict.status === 'error' && <p className="verdict-note verdict-error">{verdict.error}</p>}

          {verdict.status === 'done' && verdict.verdicts && (
            <>
              <p className="verdict-note">{verdict.noteCount} notes analysed</p>
              <ul className="verdict-list">
                {Object.entries(verdict.verdicts).map(([key, v]) => (
                  <li key={key} className={v.ok ? 'verdict-ok' : 'verdict-bad'}>
                    <span className="verdict-mark">{v.ok ? '✓' : '✗'}</span>
                    <span className="verdict-name">{key}</span>
                    <span className="verdict-detail">{v.ok ? 'passed' : 'violated'}</span>
                  </li>
                ))}
              </ul>
              <button className="btn btn-outline verdict-retry" onClick={() => void handlePlayAlong()}>
                Play again
              </button>
            </>
          )}
        </section>
      )}

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
