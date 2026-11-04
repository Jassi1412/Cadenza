# pages — Route-Level Page Components

## Purpose

Top-level page components — one per application route. Each page composes hooks and presentational components to deliver a full screen of the app. Pages are registered in `src/App.tsx`.

## Ownership

- `HomePage.tsx` / `.css` — Landing page. Minimal hero section with the Cadenza logo and a single CTA linking to `/upload`.
- `UploadPage.tsx` / `.css` — Score upload screen. Drag-and-drop or browse for a MusicXML file (`.xml`, `.musicxml`, `.mxl`). Hosts the `MidiPanel` so the user can connect a MIDI device before opening the score. Passes the selected `File`, `midiEnabled`, and `midiInputId` to `/score` via `react-router-dom` `location.state`.
- `ScorePage.tsx` / `.css` — The main score viewer, play-along surface, and step-by-step practice surface. Dynamically imports `@music-i18n/musicxml-player` (Player + OSMD renderer + Verovio converter). Owns the take lifecycle as an explicit state machine, `phase: 'idle' | 'countdown' | 'playing'`: a countdown holds the player while the musician gets to the keyboard, then the score plays and the keyboard is recorded, then the verdict posts itself. Composes `PlaybackBar`, `PracticeBar`, `useMidi`, `useVerdict`, and `usePractice`. The verdict panel shows each rule by its English name (the `.rml` filename).
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

### The two modes are separate on purpose

- `isPractice` switches between them. Practice NEVER touches the player: no `position`, no `requestAnimationFrame` loop, no time factor sent to the service. The score stands still and the cursor marks one step of the exercise (positioned by that step's `attack`, not by its index), which is why the temporal alignment of the normal mode is not needed here at all
- The two panels are mutually exclusive. The verdict panel is hidden during practice and the practice panel is hidden outside it: they judge the same performance in two different ways, and showing them together would suggest the end-of-piece verdict also applies to the step mode
- `stepStartRef` marks where the current step begins inside `midi.recording`. The recording is NOT cleared between steps, so without that boundary the twentieth step would carry the notes of the previous nineteen and `pitch-agreement` would judge them against the wrong step, producing invented violations
- The step boundary moves in an effect keyed on `practice.index`, not right after `submit`, because the hook decides the advance and reading its result immediately would give the stale value
- The submit effect fires when the set of pressed pitches CHANGES, not on every MIDI event: a note-off changes nothing a practice rule looks at, and requesting a verdict for each release would queue four requests for a chord instead of two

### The cursor in practice mode

- `moveCursorToStep` drives the OSMD cursor by hand. `followCursor` is on, but it follows the **player**, and in practice the player never starts — so nothing would ever move it
- It counts POSITIONS, and does not compare pitches. This is the second version of this function, and the change is forced by a measurement, not by taste.
- The first version searched for the voice whose notes matched the step's. In a real browser it NEVER matched. OSMD reports every note 36 semitones (three octaves) below the plan, uniformly across the piece, because the score carries an `<octave-shift type="down" size="8">` on the violin staff. Step 0 asks for `[46, 93]` and the matching voice says `[10, 57]`; step 1 asks for `[46, 86]` and the voice says `[10, 50]`
- Writing a `-36` in the code would be a bug dressed as a constant: it would change with the first score that lacks that sign. The height of a note is not a reliable link between the two sides
- What DOES hold is the POSITION, and it was measured on the whole piece: with no hand chosen, the iterator's stop `k` is the plan's step `k` — 128 of 128, with the measure matching 128 of 128. Both sides list the attacks in chronological order, so counting is enough and no pitch is read
- With a hand chosen, the position to reach is `steps[i].attack`, not `i`. The cursor walks **every** attack of the score; an exercise for one hand skips some. The service already sends `attack` inside each step, and passing `index` instead fails *silently*: the mark lands on a neighbouring note, and the student plays what they see
- The iterator makes 256 stops for 128 steps because the score has a repeat: the second pass is byte-for-byte the first. Practice stops at step 127, i.e. at the end of the first pass, and the count therefore stops at `stepIndex` instead of trying to reach the end of the score
- `cursorStepRef` holds where the cursor stopped, so each step walks forward instead of restarting. It resets only when moving backwards or when its position is unknown (`-1`)
- Bound: 6000 steps — not a musical limit, the point where giving up beats freezing the page
- Leaving practice hides the cursor; the normal mode's `followCursor` takes over again

### The practice strip sits above the playback pill

- `PracticeBar` is one fixed row, 2.4 rem tall, sitting directly above the pill (`bottom: calc(1.5rem + 5rem + 0.6rem)`) and sharing its width, radius and glass. It is the whole practice UI: step counter, key counter, one verdict word, hand chips, dynamics chip
- The box it replaced was `position: sticky; top: 0` over the score, 207 px closed and 471 px open, two columns of keys and verdicts. It hid the first systems — which is where the cursor is — and an explicit request asked for the minimum instead: cursor, one counter, one word
- It still renders *before* `.score-container` in the DOM. As a trailing element it used to land 2163 px down the document, two and a half screens below the fold
- The waiting and error states reuse the same row (`.practice-bar.practice-notice`, styles here in `ScorePage.css`) so nothing jumps when the plan turns out to be ready or a hand change is being re-planned
- The strip must never grow again: the cursor and the counter are the two things looked at together, and the whole exercise is the relation between them

## Work Guidance

- The `@music-i18n/musicxml-player`, `opensheetmusicdisplay`, and `webmidi` libraries are dynamically or lazily loaded where possible to keep the initial bundle small
- `ScorePage` uses module-level `let` refs for dynamically-imported library classes (`Player`, `OpenSheetMusicDisplayRenderer`, `VerovioConverter`) — these are populated on first load
- Verovio converter uses the `Bravura` font to avoid Leipzig font-loading errors
- Loading states must show a spinner and message; errors must offer a "Try Another File" path back to `/upload`
- Keep the practice surface in `ScorePage` rather than a new route: it needs the same player, the same MIDI hook instance, and the same rendered score, and a second route would duplicate the 11 MB player chunk

## Verification

- `npm run lint` — ESLint
- `npm run build` — TypeScript type-check + Vite build
- Manual: upload a `.musicxml` file, verify rendering, then press "Play along" and check that the countdown runs, the score plays, and the verdict arrives without pressing anything
- Manual (practice): press "Practice", check the plan loads, then play a step. The step counter must advance only when every key of the step has been pressed, an extra note must NOT block it, the key counter must react immediately while the verdict word arrives a couple of seconds later, and the tooltip of the step counter must carry the three suspended rules with their reason
- Manual (hands): press **Dx**, then **Sx**, then **Tutte**. What must change is what each step asks for, not necessarily how many steps there are — measured on the deployed service with Great Fairy Fountain: **Dx** keeps all 128 steps (that hand attacks at every position) but now asks one key instead of two and declares the other as ignored, while **Sx** drops to 88. The cursor must land on the notes of the chosen staff, an ignored key must not block and must not be judged, and **Tutte** must restore the whole exercise. On a file that declares no staves the three chips are disabled and their tooltip says why
- `node ../alignment/_probe_browser.mjs` — about 40 checks in a real browser (Chromium via CDP): the score renders; the strip appears with the step counter and the key counter and **no panel above the score**; it stays one row under 70 px and above the pill, clear of the first systems; the suspended rules are declared in the counter's title; the dynamics chip changes without costing a request; the right notes advance the counter and the OSMD cursor element really moves; **Dx** asks one key where the full plan asked two; **Sx** has fewer steps, declares the other-staff key as ignored without judging it, and its step requests carry `"hand":"left"`; a wrong note does not advance; the verdict word is "conforme" and never `pb-broken`; on exit the strip and the cursor are gone. It needs the dev server on port 5173 and the service on 8080, and it fakes `navigator.requestMIDIAccess` so no keyboard is required

## Child DOX Index

No child documents. All files in this directory are leaf pages.
