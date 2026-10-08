import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useMidi } from '../hooks/useMidi';
import { useVerdict } from '../hooks/useVerdict';
import { METRIC_LABELS } from '../metrics';
import PlaybackBar from '../components/PlaybackBar';
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
  // quello che ha già suonato, e "Suona insieme" riparte comunque da zero.
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
            {phase === 'countdown' ? 'Pronti…' : 'Prova in corso'}
          </div>
        )}
      </div>

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
            <div className="countdown-value" key={count}>{count > 0 ? count : 'Via'}</div>
            <p className="countdown-hint">Preparati, si parte fra poco</p>
          </div>
        )}
      </div>

      {/* Verdicts — appear only after the performance has been analysed */}
      {verdict.status !== 'idle' && (
        <section className="verdict-panel" ref={verdictPanelRef}>
          <div className="verdict-panel-head">
            <h2 className="heading">Il verdetto</h2>
            {verdict.status === 'done' && (
              <button className="btn btn-outline" onClick={verdict.reset}>Chiudi</button>
            )}
          </div>

          {verdict.status === 'working' && <p className="verdict-note">Allineamento e verifica delle sette regole…</p>}

          {verdict.status === 'error' && <p className="verdict-note verdict-error">{verdict.error}</p>}

          {verdict.status === 'done' && verdict.verdicts && (
            <>
              <p className="verdict-note">{verdict.noteCount} note analizzate</p>
              <ul className="verdict-list">
                {Object.entries(verdict.verdicts).map(([key, v]) => (
                  <li key={key} className={v.ok ? 'verdict-ok' : 'verdict-bad'}>
                    <span className="verdict-mark">{v.ok ? '✓' : '✗'}</span>
                    <span className="verdict-name">{METRIC_LABELS[key] ?? key}</span>
                    <span className="verdict-detail">{v.ok ? 'conforme' : 'violata'}</span>
                  </li>
                ))}
              </ul>
              <button className="btn btn-outline verdict-retry" onClick={() => void handlePlayAlong()}>
                Suona di nuovo
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
          onStop={handleStop}
          onPlayAlong={handlePlayAlong}
          bpm={bpm}
          scoreBpm={scoreBpm}
          onBpmChange={setBpm}
        />
      )}
    </div>
  );
};

export default ScorePage;
