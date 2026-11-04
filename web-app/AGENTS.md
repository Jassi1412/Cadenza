# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Lint Policy

`npx eslint .` must be clean, but three suppressions are deliberate and file-scoped in `eslint.config.js`. Do not delete them; do not widen them:

- `globalIgnores(['dist', 'temp-osmd'])` — `temp-osmd/` is a vendored OpenSheetMusicDisplay build tracked in git, not our code
- `@typescript-eslint/no-explicit-any: off` for `src/pages/ScorePage.tsx` — OSMD and `musicxml-player` ship no usable type definitions
- `react-hooks/globals`, `react-hooks/immutability`, `react-hooks/rules-of-hooks: off` for `src/hooks/useMidi.test.ts` — that file is a hand-rolled hook harness that runs outside a React render tree

One `set-state-in-effect` suppression remains inline, with the reasoning in a comment: `useMidi.ts` (selection must follow the port that actually delivers, and `selectInput` is an explicit user override). It is external-system synchronization, not render-time derivation. The former second one lived in `MetricsTestPage.tsx`, removed with the page.

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md

- Button labels are the English mode names — `Playback`, `Play along`, `Practice` — and so are their state labels `Pause`, `Recording`, `Exit`. Tooltips, panel copy and rule reasons stay Italian: the label is the name, the tooltip is the explanation.
- When the user confirms a change, commit AND push in the same pass. Nothing they can see on the deployed site changes until the work reaches `main`; stopping at a local commit leaves them looking at the old build.
- A push alone does NOT refresh the backend. Render says `autoDeployTrigger: commit` for the service `cadenza` (`srv-db0ha6bncjis739h8at0`, free, frankfurt), but GitHub moved this repository from `UnlikeKat/Cadenza` to `Jassi1412/Cadenza` and the Git integration was never re-authorised: five commits pushed on 2026-11-04 produced **zero** Render events, and the live build was still the one from 2026-10-22. Every deploy in the account has `trigger: "api"` — here deploys are triggered by hand (`trigger_deploy` through the Render MCP, docker build ≈ 70 s). Until that connection is re-authorised in the dashboard, treat a push as half a deploy and ask before triggering one. Writing `repo:` into `../render.yaml` does not fix it: a blueprint only configures resources it creates.
- The Vercel project's URL and name are recorded nowhere in the repo (`vercel.json` carries neither), so the front-end cannot be verified from source alone. Its MCP server is registered with its full tool list but connects to a hosted endpoint that answers 401 with `Www-Authenticate: Bearer error="invalid_token" … resource_metadata=https://mcp.vercel.com/.well-known/oauth-protected-resource`: the OAuth consent was never completed, so no tool ever registers. Fix = re-authorise from the MCP panel; never paste a token into the repo.

## Child DOX Index

- `src/` — Application source root: React entry point (`main.tsx`), top-level router (`App.tsx`), global stylesheets, and three durable subdomains:
  - `src/pages/` — Route-level page components (HomePage, UploadPage, ScorePage)
  - `src/components/` — Reusable presentational components (MidiPanel, PlaybackBar, PracticeBar)
  - `src/hooks/` — Domain-logic hooks (useMidi, useVerdict) and the pure exercise-rules module (practiceSteps) with its session hook (usePractice)

## Service contract

The backend lives in `../alignment/` and `../service/`, not here, but the web app depends on its three endpoints. They are contract, not implementation detail:

- `POST /` — normal mode. `{score, notes, control_changes, tempo_factor}` → the seven RML verdicts for the whole piece
- `POST /practice` — the practice plan: `{score, hand}` → every step with the pitches it asks for, plus `attack` (the index of that attack in the **full** score, which is what the OSMD cursor walks), `offhand` (the pitches of the other staff at the same instant), the active rules, the suspended rules, and `hands` — what this file allows to separate (`{right, left, unknown, split}`)
- `POST /practice/step` — one step: `{score, step, hand, events, control_changes}` → the verdicts of the practice rules for that step, the completeness status (with `other_hand`: presses belonging to the excluded staff, declared and not counted as wrong), and the suspended rules
- `hand` is `null`/`"both"` = the whole piece, `"right"` = upper staff, `"left"` = lower staff. It changes the **exercise**, not the view: a different number of steps, different pitches, a different cursor target. An unrecognised hand is a 400, never a silent fall back to "both"
- The hand split comes from a voice → dominant-`<staff>` map, so cross-staff notes keep the hand that plays them; notes with no recognisable staff stay in the exercise even when one hand is chosen, because dropping them would make a step impossible to complete
- With one hand chosen, the other hand's attacks are **removed from the RML trace and from `chordMates`**, not merely forgiven: `chord-jitter` matches by chord membership, so an attack of the excluded hand at the same instant would mask real jitter. They still reach the UI as `other_hand` — absent is not zero

Measured on the deployed service (2026-11-04, Great Fairy Fountain piano cover), so the numbers are not guesses: `hand: null` → 128 steps, the first asking `[46, 93]`; `hand: "right"` → still **128** steps but asking a single pitch `[93]`, with `offhand: [46]` declared on 88 of them; `hand: "left"` → **88** steps asking `[46]`. `hands` = `{right: 128, left: 88, unknown: 0, split: true}`. The right hand does not shorten this piece — it has an attack at every position of the full score — so a check must assert the **keys asked**, and only the left-hand plan is smaller in step count. When reproducing that call by hand on this machine, build the JSON body with `[IO.File]::ReadAllText` into a plain string: PowerShell 5.1 turns a `Get-Content -Raw` value into `{"score":{"value":…}}`, and the service then answers `400 ValueError: manca lo spartito MusicXML` for a payload that looks full

`exit` in a verdict is three-valued, and the app must not collapse it: `0` conforms, `1` is violated, `2` is **the monitor did not start** (missing `swipl`, a spec that does not compile). Rendering `2` as "violata" tells the student they played badly when the service is broken. The compact verdict line has its own tone for it (`pb-broken`) and ranks it above every playing problem — see `stepProblem` in `src/hooks/practiceSteps.ts`.