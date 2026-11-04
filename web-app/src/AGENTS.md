# src — Application Source Root

## Purpose

Root of the Cadenza web application source tree. Hosts the React entry point, the top-level router, the global stylesheet, and three durable subdomains: `pages`, `components`, and `hooks`.

## Ownership

- Entry point: `main.tsx` mounts `<App />` into `#root` under `React.StrictMode`
- `App.tsx` defines the `BrowserRouter` and the four routes (`/`, `/upload`, `/score`, `/zelda`) plus the global nav header
- `App.tsx` loads `UploadPage`, `ScorePage` and `ZeldaPage` through `React.lazy` inside a single `<Suspense fallback={<div className="route-loading" />}>`; only `HomePage` is a static import. This is what keeps the 11 MB `@music-i18n/musicxml-player` chunk out of the landing-page load
- The `/metrics-test` route and `MetricsTestPage` were removed: it recomputed six metrics in TypeScript with thresholds hardcoded in the page, duplicating the ones inside the RML `.rml` specs. Verdicts now come from the service through `useVerdict` and are rendered by `ScorePage`. Do not reintroduce in-browser thresholds
- `App.css` holds app-shell layout (header, nav, wrapper) and the `.route-loading` Suspense fallback
- `index.css` is the global stylesheet imported once at boot

## Local Contracts

- Every route component lives under `pages/`; every reusable presentational component under `components/`; every domain-logic hook under `hooks/`
- New routes must be registered in `App.tsx` and have a corresponding page component in `pages/`. Register them with `React.lazy` unless the page is on the landing path
- Do not statically import a page that transitively pulls a heavy vendor chunk: `ScorePage` imports the MusicXML/OSMD stylesheet and already `await import('@music-i18n/musicxml-player')` at runtime
- The nav header in `App.tsx` is the single source of truth for top-level navigation links
- Routing state passed between pages uses `react-router-dom` `location.state` (see `UploadPage` → `ScorePage` handoff)
- The two ways of judging a performance (the end-of-piece verdict and the step-by-step practice) are both surfaces of `ScorePage`, not separate routes: they share the rendered score, the player instance, and the MIDI hook, and a second route would fetch the 11 MB player chunk twice
- A module that must be runnable on its own (compiled and executed by a script, outside a component tree) does not belong in a `.tsx` file and must not import `useVerdict`, which pulls `import.meta.env`. See `hooks/practiceSteps.ts`

## Work Guidance

- Stack: React 19, TypeScript (strict, `noUnusedLocals`/`noUnusedParameters` on), Vite 8, `react-router-dom` 7
- Follow the existing function-component pattern (`React.FC`) and named exports
- Keep `main.tsx` minimal — only boot logic

## Verification

- `npm run lint` (ESLint flat config, `eslint.config.js`)
- `npm run build` (`tsc -b && vite build`) — type-check + production build
- `npm run dev` — Vite dev server
- `node ../alignment/run_practice_tests.mjs` — runs the pure exercise rules on node. Useful when `vite build`/`vitest` cannot start (both call `execFile`, denied in a sandboxed environment)

## Child DOX Index

- `pages/` — Route-level page components (Home, Upload, Score, Zelda) and their co-located CSS
- `components/` — Reusable presentational components (MidiPanel, PlaybackBar, PracticeBar, PianoKeyboard)
- `hooks/` — Domain-logic hooks (useMidi, useVerdict) and the step-by-step practice module (practiceSteps, usePractice)
