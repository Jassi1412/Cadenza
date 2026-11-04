# pages — Route-Level Page Components

## Purpose

Top-level page components — one per application route. Each page composes hooks and presentational components to deliver a full screen of the app. Pages are registered in `src/App.tsx`.

## Ownership

- `HomePage.tsx` / `.css` — Landing page. Minimal hero section with the Cadenza logo and a single CTA linking to `/upload`.
- `UploadPage.tsx` / `.css` — Score upload screen. Drag-and-drop or browse for a MusicXML file (`.xml`, `.musicxml`, `.mxl`). Hosts the `MidiPanel` so the user can connect a MIDI device before opening the score. Passes the selected `File`, `midiEnabled`, and `midiInputId` to `/score` via `react-router-dom` `location.state`.
- `ScorePage.tsx` / `.css` — The main score viewer, play-along surface, and step-by-step practice surface. Dynamically imports `@music-i18n/musicxml-player` (Player + OSMD renderer + Verovio converter). Owns the take lifecycle as an explicit state machine, `phase: 'idle' | 'countdown' | 'playing'`: a countdown holds the player while the musician gets to the keyboard, then the score plays and the keyboard is recorded, then the verdict posts itself. Composes `PlaybackBar`, `PracticeBar`, `PianoKeyboard`, `useMidi`, `useVerdict`, and `usePractice`. It also owns `keyboardOpen` (the drawn hint keyboard: opened when practice starts, closed on exit, toggled by the strip) and the range it is drawn over, derived with a `useMemo` from the plan's own pitches. The verdict panel shows each rule by its English name (the `.rml` filename).
- `ZeldaPage.tsx` / `.css` — `/zelda`, a demonstration page written by hand: the Great Fairy Fountain score and a real recorded performance are embedded in `src/data/zelda-performance.ts`, no upload and no live MIDI. Its only control sends that performance to the RML service and shows the seven verdicts, which is why it imports `API_URL`/`VerdictMap` from `useVerdict` rather than the hook itself. It reuses `ScorePage.css` for the sheet container, and there is no MIDI input and no practice surface here, so nothing on this page may be read as the real flow
- `MetricsTestPage.tsx` / `.css` — REMOVED. It recomputed six metrics in TypeScript with thresholds hardcoded in the page (`LEGATO_GAP_MS = 30`, attack ≥ 80, chord 30 ms, pedal 200 ms), duplicating the ones inside the RML `.rml` specs. Two copies of the same number diverge as soon as one is edited. Verdicts come from the service via `useVerdict` and are rendered by `ScorePage`; a removed page must not be reintroduced as an in-browser reimplementation.

## Local Contracts

- Route → page mapping is defined in `src/App.tsx`: `/` → `HomePage`, `/upload` → `UploadPage`, `/score` → `ScorePage`, `/zelda` → `ZeldaPage` (lazy, like the other two heavy pages)
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

- `PracticeBar` is one fixed row, 2.4 rem tall, sitting directly above the pill (`bottom: calc(1.5rem + 5rem + 0.6rem)`) and sharing its width and radius. Its whole content: the verdict dot + word, the keyboard toggle (which carries in its tooltip everything the counters used to say — step number, bar, key names, excluded presses, suspended rules), the two hand buttons **L** / **R** and the **D** chip
- Both this row and the pill have a **solid** `--bg-secondary` background and no `backdrop-filter`. They float over the score, and while they were 0.85-alpha glass the notes showed through the buttons and the controls were hard to read; that was an explicit complaint, and an opacity check is part of the browser probe now. Since both bars are the same colour, the border between them is what keeps them two objects — do not raise one bar's alpha and leave the other transparent
- The keyboard hint `PianoKeyboard` is fixed directly above the strip (its own `bottom` adds the strip's height), never inline in the flow: it must not push the score or resize with scroll, and it stays out of the strip's row so the strip stays one line. It is display-only (`pointer-events: none`) — the keyboard that matters is under the student's hands
- The box the strip replaced was `position: sticky; top: 0` over the score, 207 px closed and 471 px open, two columns of keys and verdicts. It hid the first systems — which is where the cursor is — and an explicit request asked for the minimum instead
- It still renders *before* `.score-container` in the DOM. As a trailing element it used to land 2163 px down the document, two and a half screens below the fold
- The waiting and error states reuse the same row (`.practice-bar.practice-notice`, styles here in `ScorePage.css`) so nothing jumps when the plan turns out to be ready or a hand change is being re-planned. During those waits no keyboard is drawn: with no step loaded there is nothing to light up, and an all-dark keyboard would be a picture that lies
- The strip must never grow again: the cursor and the lit keys are the two things looked at together, and the whole exercise is the relation between them. A number was removed from here because it never said *which* key; the drawn keyboard says it without taking a second line
- Keyboard range comes from the plan (`steps.flatMap(pitch + offhand)`), snapped outward to the C's that bracket it, clamped to the 88-key span the RML specs cite (21–108), and centred when the piece is wider than five octaves. A fixed 88-key keyboard is six pixels per key on a laptop and stops being readable

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
- Manual (practice): press "Practice", check the plan loads, then play a step. The drawn keyboard must appear by itself, lit on exactly the keys the step asks for; it must turn green under the fingers before the verdict word arrives (that is the local status, not the service); pressing an extra key must NOT block the exercise; the next step's keys must light up as soon as the step completes; and the title of the keyboard toggle must carry the step number, the bar, the key names and the three suspended rules with their reason
- Manual (hands): press **L**, then **R**, then **L** again. Pressing a letter *picks* that hand; pressing the one already picked goes back to both — two letters lit means "both hands", and there is no third button saying it any more. What must change is what each step asks for, not necessarily how many steps there are — measured on the deployed service with Great Fairy Fountain: right keeps all 128 steps (that hand attacks at every position) but asks one key instead of two and shows the other key as violet context, while left drops to 88. The cursor must land on the notes of the chosen staff, an excluded key must not block and must not be judged, and going back to both must restore the whole exercise. On a file that declares no staves only the surviving letter is drawn, lit and disabled, with the reason in its tooltip
- `node ../alignment/_probe_browser.mjs` — about 45 checks in a real browser (Chromium via CDP): the score renders; the strip appears and **no panel sits above the score**; both bars compute an alpha of 1 (solid); the keyboard shows up without any click, with middle C labelled `C4` and the reference points printed at the C's and F's only; the first step lights exactly the pitches the plan's first step asks for; the strip stays one row under 70 px, above the pill and clear of the first systems, and the keyboard sits above the strip; the suspended rules plus `Step n of N`, the bar and the key names are declared in the toggle's title; the **D** chip changes without costing a request; the pressed keys go green, the next step's keys change, and the OSMD cursor element really moves; **R** asks one key where the full plan asked two and shows the other as context; **L** has fewer steps (the totals come from the `/practice` response, intercepted before the click — the strip no longer prints them), shows the excluded key violet rather than red, declares it in the title without judging it, its step requests carry `"hand":"left"`, and it advances on the asked key; pressing the same letter restores both; an out-of-score press goes **red** and does not advance or move the cursor; the verdict word is `correct` and never `pb-broken`; leaving practice removes strip, cursor and keyboard. It needs the dev server on port 5173 and the service on 8080, and it fakes `navigator.requestMIDIAccess` so no physical keyboard is required

## Child DOX Index

No child documents. All files in this directory are leaf pages.
