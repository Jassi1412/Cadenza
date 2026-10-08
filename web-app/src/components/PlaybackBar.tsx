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
}) => {
  const slowed = bpm < scoreBpm;

  return (
    <div className="playback-bar" id="playback-bar">
      {/* Thin progress line at the top of the pill */}
      {!isTakeActive && (
        <div className="bar-progress">
          <div className="bar-progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}

      {/* Play / Pause — ascolto puro, non registra nulla */}
      <button
        className={`bar-btn ${isPlaying ? 'active' : ''}`}
        onClick={onPlayPause}
        disabled={isLoading || isTakeActive}
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
        disabled={isLoading || isTakeActive}
        title={isTakeActive ? 'Prova in corso' : 'Suona insieme allo spartito'}
        id="bar-practice-btn"
      >
        <PlayAlongIcon />
        <span className="bar-btn-label">{isTakeActive ? 'In corso' : 'Suona insieme'}</span>
      </button>

      {/* Tempo. Sparisce durante la prova, e non è solo disabilitato: durante
          la prova il fattore che il verdetto usa è già stato letto, e lasciare
          un cursore che sembra regolabile ma non conta sarebbe peggio che
          non averlo. */}
      {!isTakeActive && (
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
