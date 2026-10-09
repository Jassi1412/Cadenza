# pages — Route-Level Page Components

## Purpose

Top-level page components — one per application route. Each page composes hooks and presentational components to deliver a full screen of the app. Pages are registered in `src/App.tsx`.

## Ownership

- `HomePage.tsx` / `.css` — Landing page. Minimal hero section with the Cadenza logo and a single CTA linking to `/upload`.
- `UploadPage.tsx` / `.css` — Score upload screen. Drag-and-drop or browse for a MusicXML file (`.xml`, `.musicxml`, `.mxl`). Hosts the `MidiPanel` so the user can connect a MIDI device before opening the score. Passes the selected `File`, `midiEnabled`, and `midiInputId` to `/score` via `react-router-dom` `location.state`.
- `ScorePage.tsx` / `.css` — The main score viewer and play-along surface. Dynamically imports `@music-i18n/musicxml-player` (Player + OSMD renderer + Verovio converter). Owns the take lifecycle as an explicit state machine, `phase: 'idle' | 'countdown' | 'playing'`: a countdown holds the player while the musician gets to the keyboard, then the score plays and the keyboard is recorded, then the verdict posts itself. Composes `PlaybackBar`, `useMidi`, and `useVerdict`. The verdict panel shows each rule by its English name (the `.rml` filename).
- `MetricsTestPage.tsx` / `.css` — REMOVED. It recomputed six metrics in TypeScript with thresholds hardcoded in the page (`LEGATO_GAP_MS = 30`, attack ≥ 80, chord 30 ms, pedal 200 ms), duplicating the ones inside the RML `.rml` specs. Two copies of the same number diverge as soon as one is edited. Verdicts come from the service via `useVerdict` and are rendered by `ScorePage`; a removed page must not be reintroduced as an in-browser reimplementation.

## Local Contracts

- Route → page mapping is defined in `src/App.tsx`: `/` → `HomePage`, `/upload` → `UploadPage`, `/score` → `ScorePage`
- Thresholds and verdicts live only in `RML_DOCS/RML_TESTS/metrics/*.rml`. No page may contain a numeric threshold that decides pass/fail
- `ScorePage` shows the verdict panel only after `verdict.status !== 'idle'`, and the analysis posts itself when the score ends: there is no "Analizza la prova" button, because waiting for it only added a way to forget it
- `ScorePage` starts a take by calling `midi.clearRecording()` then `player.rewind()` — without the reset, a second take concatenates onto the first and the aligner reads both as one performance
- The end of the score has no event: `PlayerState` is only `Stopped`/`Playing`/`Paused` and the player exposes no emitter, so the end is deduced in a `requestAnimationFrame` loop from `position >= duration - END_TOLERANCE_MS` (250 ms, without it the last millisecond is cut)
- `UploadPage` → `ScorePage` handoff contract via `location.state`:
  - `file: File` — the selected MusicXML file (required; `ScorePage` redirects to `/upload` if absent)
  - `midiEnabled: boolean` — whether MIDI was enabled on the upload page
  - `midiInputId: string | null` — the selected MIDI input device ID, if any
- `ScorePage` owns the `playerRef` and `osmdRef`; `osmdRef` is kept only for diagnostics, since `followCursor: true` on both the renderer and the player already makes the cursor follow playback without a practice engine
- Space bar toggles play/pause on `ScorePage` (suppressed while loading and during a take)
- A take and plain playback are mutually exclusive — pressing Play mid-take does nothing, Stop aborts the take

## Work Guidance

- The `@music-i18n/musicxml-player`, `opensheetmusicdisplay`, and `webmidi` libraries are dynamically or lazily loaded where possible to keep the initial bundle small
- `ScorePage` uses module-level `let` refs for dynamically-imported library classes (`Player`, `OpenSheetMusicDisplayRenderer`, `VerovioConverter`) — these are populated on first load
- Verovio converter uses the `Bravura` font to avoid Leipzig font-loading errors
- Loading states must show a spinner and message; errors must offer a "Try Another File" path back to `/upload`

## Verification

- `npm run lint` — ESLint
- `npm run build` — TypeScript type-check + Vite build
- Manual: upload a `.musicxml` file, verify rendering, then press "Suona insieme" and check that the countdown runs, the score plays, and the verdict arrives without pressing anything

## Child DOX Index

No child documents. All files in this directory are leaf pages.
