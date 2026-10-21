import React from 'react';
import './PlaybackBar.css';

/** Estremi dello slider, in battute al minuto. */
const BPM_MIN = 40;
const BPM_MAX = 240;

interface PlaybackBarProps {
  isPlaying: boolean;
  isTakeActive: boolean;
  isLoading: boolean;
  progress: number; // 0–100
  onPlayPause: () => void;
  onStop: () => void;
  onPlayAlong: () => void;
  /** Battute al minute scelte, e quelle scritte nello spartito. */
  bpm: number;
  scoreBpm: number;
  onBpmChange: (bpm: number) => void;
  /**
   * Modalità a passi: il brano sta fermo e avanza di un passo per volta.
   *
   * È il modo in cui si impara un passaggio; la modalità normale è dove si va
   * quando lo si sa già, ed è lì che il tempo conta. Sono due esercizi diversi
   * sullo stesso motore, non due versioni della stessa cosa.
   */
  isPractice: boolean;
  onPractice: () => void;
  onPracticeStop: () => void;
}

/** Stopwatch SVG — the play-along button */
const PlayAlongIcon: React.FC = () => (
  <div className="bar-btn-icon-wrap">
    <svg
      className="practice-stopwatch"
      fill="none"
      stroke="currentColor"
      strokeWidth="0.75"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="13" r="8" />
      <circle cx="12" cy="13" r="7.2" strokeDasharray="0.5 1.5" />
      <rect height="2" rx="0.5" width="3" x="10.5" y="2" />
      <path d="M12 4V5" />
      <path d="M15.5 4.5L16.5 5.5" />
      <path d="M8.5 4.5L7.5 5.5" />
      <path d="M12 13L12 9" strokeLinecap="round" />
      <path d="M12 13L15 15" strokeLinecap="round" strokeWidth="0.5" />
      <path d="M12 5.5V6.5" />
      <path d="M12 19.5V20.5" />
      <path d="M4.5 13H5.5" />
      <path d="M18.5 13H19.5" />
      <circle cx="12" cy="13" fill="currentColor" r="0.8" />
    </svg>
  </div>
);

const PlaybackBar: React.FC<PlaybackBarProps> = ({
  isPlaying,
  isTakeActive,
  isLoading,
  progress,
  onPlayPause,
  onStop,
  onPlayAlong,
  bpm,
  scoreBpm,
  onBpmChange,
  isPractice,
  onPractice,
  onPracticeStop,
}) => {
  const slowed = bpm < scoreBpm;

  return (
    <div className="playback-bar" id="playback-bar">
      {/* Thin progress line at the top of the pill */}
      {!isTakeActive && !isPractice && (
        <div className="bar-progress">
          <div className="bar-progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}

      {/* Play / Pause — ascolto puro, non registra nulla. Spento in pratica: lì
          il brano non scorre, e un tasto che sembra avviarlo sarebbe una bugia. */}
      <button
        className={`bar-btn ${isPlaying ? 'active' : ''}`}
        onClick={onPlayPause}
        disabled={isLoading || isTakeActive || isPractice}
        title={isPlaying ? 'Pause' : 'Play'}
        id="bar-play-btn"
      >
        <span
          className="material-symbols-outlined bar-icon vintage-icon"
          style={{
            fontVariationSettings: "'FILL' 0, 'wght' 100, 'GRAD' 0, 'opsz' 48",
          }}
        >
          {isPlaying ? 'pause_circle' : 'play_circle'}
        </span>
        <span className="bar-btn-label">{isPlaying ? 'Pause' : 'Play'}</span>
      </button>

      {/* Stop / Rewind */}
      <button
        className="bar-btn"
        onClick={onStop}
        disabled={isLoading}
        title="Stop & Rewind"
        id="bar-stop-btn"
      >
        <span
          className="material-symbols-outlined bar-icon vintage-icon"
          style={{
            fontVariationSettings: "'FILL' 0, 'wght' 100, 'GRAD' 0, 'opsz' 48",
          }}
        >
          stop_circle
        </span>
        <span className="bar-btn-label">Stop</span>
      </button>

      {/* Play along — countdown, score plays, keyboard is recorded, verdict at the end */}
      <button
        className={`bar-btn ${isTakeActive ? 'practice-active' : ''}`}
        onClick={onPlayAlong}
        disabled={isLoading || isTakeActive || isPractice}
        title={isTakeActive ? 'Prova in corso' : 'Suona insieme allo spartito'}
        id="bar-practice-btn"
      >
        <PlayAlongIcon />
        <span className="bar-btn-label">{isTakeActive ? 'In corso' : 'Suona insieme'}</span>
      </button>

      {/* Modalità a passi: il brano sta fermo e avanza di una nota alla volta.
          Il tasto cambia funzione quando è attiva, invece di aggiungerne un
          altro: durante la pratica non c'è niente da avviare, solo da fermare. */}
      <button
        className={`bar-btn ${isPractice ? 'practice-active' : ''}`}
        onClick={isPractice ? onPracticeStop : onPractice}
        disabled={isLoading || isTakeActive}
        title={isPractice ? 'Esci dalla pratica' : 'Brano fermo, un passo per volta'}
        id="bar-step-btn"
      >
        <span
          className="material-symbols-outlined bar-icon vintage-icon"
          style={{
            fontVariationSettings: "'FILL' 0, 'wght' 100, 'GRAD' 0, 'opsz' 48",
          }}
        >
          {isPractice ? 'close' : 'piano'}
        </span>
        <span className="bar-btn-label">{isPractice ? 'Esci' : 'Un passo'}</span>
      </button>

      {/* Il tempo sparisce in pratica. Non e' disabilitato: qui non esiste.
          Nella modalita' a passi la durata di una nota non ha un ruolo, e uno
          slider che sembra regolare qualcosa che non conta sarebbe peggio che
          non averlo. */}
      {!isTakeActive && !isPractice && (
        <div className="bar-tempo">
          <input
            type="range"
            className="bar-tempo-slider"
            min={BPM_MIN}
            max={BPM_MAX}
            step={1}
            value={bpm}
            disabled={isLoading}
            onChange={(e) => onBpmChange(Number(e.target.value))}
            aria-label="Tempo in battute al minuto"
            aria-valuetext={`${bpm} battute al minuto`}
            id="bar-bpm-slider"
          />
          <span className="bar-tempo-value">
            {bpm}
            <span className="bar-tempo-unit">BPM</span>
          </span>
          {slowed && <span className="bar-tempo-note">da {scoreBpm}</span>}
        </div>
      )}
    </div>
  );
};

export default PlaybackBar;
