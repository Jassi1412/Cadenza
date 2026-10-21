# components — Reusable Presentational Components

## Purpose

Stateless and lightly-stateful UI components reused across pages. Each component is paired with a co-located `.css` file and is consumed by one or more page components.

## Ownership

- `MidiPanel.tsx` / `.css` — Collapsible MIDI connection panel. Renders device selector, live note display, mini keyboard visualization (C3–B4). Consumes `UseMidiReturn` from `useMidi`. Returns `null` on unsupported browsers.
- `PlaybackBar.tsx` / `.css` — Floating bottom control bar. Exposes Play/Pause (listen only), Stop, the play-along button that starts a recorded take, and the step-by-step button. Also owns the tempo slider. Renders a thin progress line (0–100%), hidden during a take and during practice. Uses Material Symbols icons + a custom stopwatch SVG for the play-along button.
- `PracticePanel.tsx` / `.css` — The step-by-step panel, in two columns: the keys of the current step (pressed / still missing / extra) and the step number on the left, the verdicts of the practice rules and the suspended rules with their reason on the right. Presentational — it decides nothing and never calls the service.
- `StaffToggle.tsx` / `.css` — REMOVED with the old note-by-note practice engine. It existed only to pick which staff that engine waited on, and the play-along mode records the whole keyboard, so there was nothing left to toggle.

## Local Contracts

- Components receive all data and callbacks via props — no direct hook usage inside presentational components except local UI state (e.g. `MidiPanel` expand/collapse)
- Each component imports its own `.css` file; styles are scoped by component-specific class names
- `MidiPanel` depends on the `UseMidiReturn` interface exported from `hooks/useMidi`
- `PlaybackBar` is controlled — `ScorePage` owns playback state and passes `isTakeActive`, which disables Play/Pause during a take and relabels the play-along button
- `PlaybackBar` is controlled in practice too: `isPractice` hides the progress line and the tempo slider, disables Play and the play-along button, and makes the step button read "Esci". The tempo slider disappears rather than being disabled, because in the step mode no duration matters and a slider that looks adjustable while meaning nothing is worse than no slider
- The key colours in `PracticePanel` follow the LOCAL step status, not the server verdict. The verdict costs ~2 s deployed; if the highlighting waited for it, the finger would be on a different key before the screen caught up
- `PracticePanel` renders THREE verdict states, not two: `ok`, `violata`, and `non verificabile` (service `exit 2`, the monitor did not start). Collapsing the third into "violata" reports a broken service as bad playing
- `PracticePanel` renders the SUSPENDED rules with their reason instead of hiding them. Silence reads as "conforme", which would be the worst possible lie in a project whose subject is the verdict itself
- `PracticePanel` is TWO columns: `.practice-left` holds the keys and the step number (what you need to play right now), `.practice-right` holds the verdicts and the suspended rules (what you read afterwards). One column made the panel 553 px tall and it covered half the score while the keys column stayed empty for two thirds of its height
- The suspended rules are in a closed `<details className="practice-suspended-box">`. Their text explains WHY they do not apply, and that is read once, not at every step. Closed, the panel is 207 px tall. The summary still states that the three rules do not apply, so the declaration survives the collapse
- `PracticePanel` carries the `dynamics-adherence` toggle ("Controlla anche la dinamica"), on by default. Turning it off filters the ROW, never the request: the service always runs all four practice rules, so the toggle cannot cost a second round trip, and the judgement stays RML's while what to look at stays the student's. The row does not disappear silently — the toggle's own caption states what is no longer being checked, and the same "absent is not zero" rule applies
- `PracticePanel` must not export helper functions: `react-refresh/only-export-components` rejects it. `noteName` therefore lives in `hooks/practiceSteps.ts`, where it is also testable

## Work Guidance

- Use `lucide-react` for standard icons; use inline SVG only when no suitable lucide icon exists (see the `PlaybackBar` stopwatch). The step button uses Material Symbols (`piano` / `close`) to match the icons beside it
- Material Symbols icons are loaded via class `material-symbols-outlined` with `fontVariationSettings` for weight/fill control
- New components must follow the same pattern: `React.FC<Props>`, named export, co-located CSS, component-scoped class names

## Verification

- `npm run lint` — ESLint with React Hooks + React Refresh plugins
- `npm run build` — TypeScript type-check + Vite build

## Child DOX Index

No child documents. All files in this directory are leaf components.
