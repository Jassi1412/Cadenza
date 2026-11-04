# hooks — Domain-Logic Hooks

## Purpose

Stateful React hooks that encapsulate cross-cutting domain logic — MIDI device management, verdict transport, and the step-by-step practice session. Each hook owns a complex concern that would otherwise bloat page components.

## Ownership

- `useMidi.ts` — Web MIDI API integration via the `webmidi` package. Manages device enumeration, enable/disable lifecycle, input selection, live note-on/note-off tracking, two event streams, and hot-plug (connect/disconnect) events. Returns `UseMidiReturn` (the interface consumed by `MidiPanel` and `ScorePage`).
- `useVerdict.ts` — Carries a finished performance to the Cadenza service and holds the seven RML verdicts. `toPerformance(events)` is a pure function, exported for testing, converting the MIDI stream into the payload the service validates. It contains no threshold and no verdict: the verdict is computed in Prolog. `API_URL` defaults to the deployed service `https://cadenza-etji.onrender.com`; `VITE_CADENZA_API` overrides it for local development.
- The deployed URL is the default on purpose. It is a public address, not a secret, so hiding it behind an env var only created a way to forget it — and a forgotten env var points the app at the author's own machine, where the verdict panel silently fails. Change the URL in source when the service moves, and redeploy.
- `practiceSteps.ts` — The pure rules of the step-by-step exercise: `pressedPitches`, `stepStatus`, `noteName`, and the `PracticeStep`/`StepStatus` types. No React, no network, no `import.meta.env`, so it can be compiled and executed on its own. This is deliberate: it is the only place in the practice feature that decides anything, and it must stay testable without mounting a component or faking a service.
- `usePractice.ts` — Transport and session state for the step-by-step mode. Calls `POST /practice` once (the plan) and `POST /practice/step` per step (the verdicts), and holds the cursor index, the last verdict, and the local step status. Re-exports the `practiceSteps` types; it deliberately does NOT re-export the functions, so a test of the rules does not drag in React and the network.

## Local Contracts

- `useMidi` exports the `MidiNote`, `MidiEvent`, and `UseMidiReturn` interfaces; `useVerdict` imports `MidiEvent` from `useMidi` — the only cross-hook dependency left
- `useMidi.clearRecording()` empties `recording`, `events`, and `activeNotes`; `ScorePage` calls it when a take starts, so two consecutive takes do not concatenate into one payload
- `UseMidiReturn` carries TWO event streams, and they are not interchangeable: `events: MidiEvent[]` is a bounded live stream for the UI (cap 500, oldest dropped first), while `recording: MidiEvent[]` is the performance that gets analysed (cap 20000). A 216-note piece produces 434 events, so `events` alone silently loses the beginning of the performance
- `recording` must be read at analysis time, never subscribed to; `useVerdict` takes it as a plain argument and only reads it inside `analyse()`
- `useMidi` uses ref-tracked listener references so multiple instances don't clobber each other's global WebMidi listeners; never call bare `WebMidi.removeListener()` without a reference
- `useMidi` attaches the selected input's listeners and the ref-scoped global `connected`/`disconnected` handlers in an effect SETUP keyed on `isEnabled`, `selectedInput?.id`, and `attachListeners`, so delivery and hot-plug registration are re-established on every effect remount (Vite Fast Refresh / StrictMode) instead of being silently detached while the UI still shows the device as connected
- `useMidi.selectInput()` resolves the id before detaching: an empty or unresolvable id is a complete no-op — the live input keeps its listeners and the current selection is unchanged
- `useMidi.isSupported` is a lazy `useState` initializer (`!!navigator.requestMIDIAccess`), never a `setState` in an effect — do not reintroduce a support-check effect
- `useMidi`'s enable/disable global `connected`/`disconnected` handlers are typed `PortEvent` (the base `webmidi` event), not `MessageEvent`; `MessageEvent extends PortEvent`, so a handler typed `MessageEvent` is not assignable to the port-listener slot
- `enable()` surfaces `err instanceof Error ? err.message : ''` and then falls back to the default guidance string — an empty message must still produce the guidance, not `""` (pinned by `useMidi.test.ts`)
- `stepStatus` decides `advance` on set membership, never on time and never on a threshold: the expected pitches come from the service's plan, so this file invents no number
- `advance` ignores EXTRA pitches on purpose. A wrong note and an added note are the same verdict for `pitch-agreement` (one `noteon` with `pitchDist != 0`), but they must behave oppositely: the first blocks the cursor, the second must not. Measured against the real monitor in `alignment/test_practice.py`, case 6
- `usePractice.submit` advances the cursor immediately and asks the service for the verdict afterwards, in parallel. The verdict costs ~170 ms locally but ~2 s deployed (Render Free, 0.1 CPU), so a cursor that waited for it would freeze after every note
- `usePractice` one-shot-guards the verdict requests: an in-flight request absorbs later presses and the most recent state is judged, because out-of-order answers would show the verdict of a step the student already left
- A failed verdict request NEVER stops the exercise: it is surfaced in the panel and the session continues. Interrupting someone who is playing for a network problem is the worst thing this feature could do
- `exit 2` from the service means the monitor did not start (missing `swipl`, a spec that does not compile), NOT a violation. `PracticePanel` renders it as a distinct third state; showing it as "violata" would tell the student they played badly when the service is broken
- `usePractice.dynamicsOn` filters the DISPLAY, not the request: the four practice rules always run, and the flag only decides which row `PracticePanel` shows. Filtering server-side would cost a round trip to switch a rule back on and would put a presentation choice into the judgement
- `noteName` uses the scientific convention: MIDI 60 = C4, 21 = A0, 108 = C8 (the 88-key range the RML specs cite). Accidentals are always sharps, because MIDI numbers do not distinguish them

## Work Guidance

- `useMidi.test.ts` runs on **bun**, not vitest (`bun test src/hooks/useMidi.test.ts`), because it drives `mock.module` for the module registry. `web-app/eslint.config.js` disables `react-hooks/globals`, `react-hooks/immutability` and `react-hooks/rules-of-hooks` for that file only: the harness runs the hook outside a React render tree, so those rules report its module-level state as violations. Its harness functions are named with a `use` prefix (`useRenderHook`, `useCreateHookWithInputs`) for that reason
- Keep new exercise rules in `practiceSteps.ts`, not in `usePractice.ts`: a pure module can be run by `alignment/run_practice_tests.mjs`, which does not depend on vitest starting

## Verification

- `npm run lint` — ESLint (note: `ScorePage` disables `react-hooks/exhaustive-deps` on specific effects)
- `npm run build` — TypeScript type-check
- `npm test` — vitest; **does not cover `useMidi.test.ts`** (excluded in `vite.config.ts`). Run `bun test src/hooks/useMidi.test.ts` (21 tests) as the gate for this directory
- `node alignment/run_practice_tests.mjs` — compiles `practiceSteps.ts` with tsc and executes it on node, 18 checks. The fallback that works when vitest cannot start (Vite calls `execFile`, which a sandboxed environment denies), and it runs the same emitted module the bundle uses
- `python alignment/test_cursor.py` — 21 checks on the cursor-walk logic, with an OSMD stand-in (`Iterator.EndReached`, `Iterator.CurrentMeasure.MeasureNumber`, `next`, `reset`, `show`, `hide`). It tests OUR function, not OSMD: it cannot catch an OSMD API change, which is what the browser check is for
- `python alignment/test_cursor_sequence.py` — the real 128-step sequence against a cursor built from the real score. It asserts 128/128 steps positioned, 128/128 on the right measure, 128/128 cursor movements, zero backward walks. The voices are deliberately shifted by 36 semitones, like OSMD does: if the function depended on pitch, this test would fail
- Manual: connect a MIDI keyboard, press "Play along", play the whole score, and check that the verdict arrives by itself. Then press "Practice" and check that the cursor advances only when every note of the step has been pressed, that the OSMD cursor moves to the note of the current step, and that the dynamics toggle changes the sentence under it

## Child DOX Index

No child documents. All files in this directory are leaf hooks.
