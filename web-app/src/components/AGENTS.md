# components — Reusable Presentational Components

## Purpose

Stateless and lightly-stateful UI components reused across pages. Each component is paired with a co-located `.css` file and is consumed by one or more page components.

## Ownership

- `MidiPanel.tsx` / `.css` — Collapsible MIDI connection panel. Renders device selector, live note display, mini keyboard visualization (C3–B4). Consumes `UseMidiReturn` from `useMidi`. Returns `null` on unsupported browsers.
- `PlaybackBar.tsx` / `.css` — Floating bottom control bar. Exposes **Playback**/Pause (listen only), Stop, **Play along** (starts a recorded take), and **Practice** (step-by-step). The labels are the English mode names; the tooltips stay Italian, because a tooltip is the explanation and not the name. Also owns the tempo slider. Renders a thin progress line (0–100%), hidden during a take and during practice. Uses Material Symbols icons + a custom stopwatch SVG for the play-along button.
- `PracticeBar.tsx` / `.css` — The one-row practice command strip, fixed above `PlaybackBar`: step counter, key counter (`x/y tasti`), one compact verdict word, the hand selector (**Tutte / Dx / Sx**) and the **Dinamica** chip. Presentational — it decides nothing and never calls the service: the verdict text arrives already chosen by `stepProblem`, and the completeness by `stepStatus`. It replaced `PracticePanel.tsx` / `.css` (the box that covered half the score) — do not reintroduce that box.
- `StaffToggle.tsx` / `.css` — REMOVED with the old note-by-note practice engine. It existed only to pick which staff that engine waited on, and the play-along mode records the whole keyboard, so there was nothing left to toggle.

## Local Contracts

- Components receive all data and callbacks via props — no direct hook usage inside presentational components except local UI state (e.g. `MidiPanel` expand/collapse)
- Each component imports its own `.css` file; styles are scoped by component-specific class names
- `MidiPanel` depends on the `UseMidiReturn` interface exported from `hooks/useMidi`
- `PlaybackBar` is controlled — `ScorePage` owns playback state and passes `isTakeActive`, which disables Playback/Pause during a take and relabels **Play along** to "Recording" (the presses are captured from the countdown on, so the label states what is actually happening)
- `PlaybackBar` is controlled in practice too: `isPractice` hides the progress line and the tempo slider, disables Playback and Play along, and makes **Practice** read "Exit". The tempo slider disappears rather than being disabled, because in the step mode no duration matters and a slider that looks adjustable while meaning nothing is worse than no slider
- The key counter in `PracticeBar` follows the LOCAL step status, not the server verdict. The verdict costs ~2 s deployed; if it waited, the finger would be on a different key before the screen caught up
- The verdict line has THREE tones, not two: `.pb-ok` (conforme), `.pb-warn` (what the student played: nota sbagliata / chord jitter / dinamica errata) and `.pb-broken` (service `exit 2`, the monitor did not start). Collapsing broken into warn reports a broken service as bad playing. `.pb-waiting` is the fourth honest state: no verdict yet, or nothing pressed — never a silent "conforme"
- The ranking lives in `stepProblem` (`hooks/practiceSteps.ts`), not here: nota sbagliata before chord jitter before dinamica, and `exit 2` above all of them. The component renders the word it is given; that is what makes the ranking testable
- No note names on screen: the OSMD cursor plus `x/y tasti` say where and how many. The names are in the tooltip of the counter. This was an explicit request, and the counter is what a hand-filtered exercise can still state truthfully when only one staff is being judged
- The suspended rules are still declared, in the `title` of `.pb-step`, with their reason. Silence about a rule reads as "conforme", which is the one lie this project refuses
- `PracticeBar` is ONE row, 2.4 rem tall (≈38 px), `position: fixed` at `bottom: calc(1.5rem + 5rem + 0.6rem)` so it sits directly above the pill, sharing its width (`max-width: 34rem`), radius and glass. It must not grow into a panel: the box it replaced measured 207 px closed and 471 px open, and it covered half of the score — while the thing to look at, the cursor, is on the score
- The hand selector is three mutually exclusive chips (**Tutte / Dx / Sx**) driven by `hands.split` from the service. When the file declares no staves they are disabled *and* carry the reason in their tooltip: a control that cannot do anything, without saying why, reads as a broken button
- Choosing a hand does not hide any staff. Both staves stay visible: the filter changes what is judged and what advances the cursor, and the excluded staff is still the ground the cursor walks on. Re-planning is `usePractice.setHand`, never this component
- Presses belonging to the excluded staff are declared as `.pb-other` ("N note dell'altro rigo ignorata") and never counted as extra or wrong: they were asked for, just not by this hand
- The **Dinamica** chip filters the DISPLAY only (`aria-pressed`; its tooltip states what is no longer being watched). It must never cost a round trip — the service always runs all four practice rules — and `_probe_browser.mjs` asserts that by counting requests
- Chip labels are not mode names: `Tutte / Dx / Sx / Dinamica` stay Italian, like tooltips and panel copy. Only the three mode buttons and their state labels are English (see `User Preferences` in `../../AGENTS.md`)
- `PracticeBar` must not export helper functions: `react-refresh/only-export-components` rejects it. `noteName` and `stepProblem` therefore live in `hooks/practiceSteps.ts`, where they are also testable

## Work Guidance

- Use `lucide-react` for standard icons; use inline SVG only when no suitable lucide icon exists (see the `PlaybackBar` stopwatch). The step button uses Material Symbols (`piano` / `close`) to match the icons beside it
- Material Symbols icons are loaded via class `material-symbols-outlined` with `fontVariationSettings` for weight/fill control
- New components must follow the same pattern: `React.FC<Props>`, named export, co-located CSS, component-scoped class names

## Verification

- `npm run lint` — ESLint with React Hooks + React Refresh plugins
- `npm run build` — TypeScript type-check + Vite build

## Child DOX Index

No child documents. All files in this directory are leaf components.
