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

- **Everything the user can read is English — no exceptions, from 2026-11-04 onwards.** Button labels (`Playback`, `Play along`, `Practice`, `Pause`, `Recording`, `Exit`), tooltips, `aria-label`s, panel copy, the one-word verdict (`correct` / `wrong note` / `chord jitter` / `bad dynamics` / `cannot verify` / `no verdict from the service`), and every string that lands in an error box — including the reasons and 400 messages the service sends back, which the app displays verbatim. The old "labels English, tooltips Italian" preference is **superseded**; do not reintroduce Italian UI text. Code comments, test names and test labels stay Italian, on purpose: keeping the two languages apart makes it obvious which side of the boundary a string is on.
- **No native browser tooltips on anything the musician touches (2026-11-10).** The grey rectangle `title` pops up half a second late, in the wrong font, and the user called it "un rettangolino brutto" — twice, once for the error tooltip on red notes and once for the practice-strip icons (`piano / L / R / D`). Control names live in `aria-label`s (screen readers keep them, the mouse never sees a box); information that used to hide in a `title` must be visible where it is used — drawn keys, colours, the hover card — or it is gone on purpose. Do not "restore the context" with a new tooltip somewhere else.
- **The end of a take is read, not scrolled to (2026-11-10).** No panel under the score: one card centered over the viewport, showing a 0–100 score that counts up from 0 — how badly this performance did against its own notes, decided by `performanceScore` in the pure module, never a threshold invented in the page. Hover on red notes shows a themed card (`ErrorHoverCard`), one minimal line per rule, `you <played> · score <written>` where numbers exist — no wall of words, because the student is there to fix things fast.
- **The end of a take is declared, never estimated (2026-11-10).** The page may only close a take on facts the audio engine itself declares (`songEnded`, the worklet's declared `.loopCount` jump) or on rules with mathematical certainty (the position getter's ceiling; an odometer margin measured in sampling steps). Percentages of the piece were rejected verbatim: "potrebbero comunque capitare dei falsi positivi, preferirei qualcosa di più robusto che è sicuro al 100% che lo spartito è terminato" — the earlier fix closed on a rewind from 85% of the position, and false positives were exactly the complaint. The pure rules live in `src/hooks/scoreMarks.ts`; the wiring contract is in `src/pages/AGENTS.md`.
- **Every written attack ends the take with exactly one color, and the report survives "Close" until the user restarts (2026-11-10).** Two verbatim complaints from a real MIDI test on Warmup C Major: "quando si clicca close si deve poter vedere lo spartito finché non si ricomincia da capo, azione fatta dall'utente" — "Close" hides the centered card ONLY; every painted mark and its hover stay on the score until the user's own next action wipes them (pressing "Play along" IS that restart: `handlePlayAlong` resets verdict+card-flag; entering practice and leaving the page clear through the verdict effect — nothing else may) — and "vorrei che le note premute correttamente fossero colorate di verde, e tutte le altre di rosso: note missate, note fuori tempo, note sbagliate" — green = that attack sounded its right pitch inside tolerance (`correct` from the service), red = everything else (wrong key, `"out of time"`, `"never played"`, or any RML violation there). One attack never carries both: red always wins. Green gets NO hover card — a success has nothing to explain. Stated side effect the user must know: dynamics/pedal/articulation/jitter violations also make a point red, so on a score with loudness markings a note can be "right key, right time" and still wear red; the hover line names that rule. The metric drops honestly now that skipped half-pieces count (the flagged denominator is unchanged).
- **Practice switches outlive the session (2026-11-10).** The hint keyboard's open/closed choice and the L/R switches persist across exiting practice, re-entering, and page reloads (`localStorage`, key `cadenza-practice-controls`). Nothing resets them but the user's own clicks — neither starting nor leaving practice may restore defaults; that was explicitly complained about ("ricompare di nuovo… rendile persistenti").
- When the user confirms a change, commit AND push in the same pass. Nothing they can see on the deployed site changes until the work reaches `main`; stopping at a local commit leaves them looking at the old build.
- A push to `main` now deploys the backend by itself, and that is a **verified** fact, not a config reading: on 2026-11-04 an empty probe commit produced a Render deploy 6 s after the push (`trigger: "new_commit"`, build succeeded in 12 s, live at 35 s). Earlier the same day five pushes had produced **zero** events for seven days. Cause: GitHub moves neither a GitHub App installation nor its webhook when a repository is transferred (this one went `UnlikeKat/Cadenza` → `Jassi1412/Cadenza`), while Render could still *read* the repo all along — which is why `trigger_deploy` kept working and made the silence look like a build problem instead of a lost subscription. The fix was installing/configuring the Render app **on the account that owns the repository now** (`github.com/apps/render/installations/new`, section *Repository access*), not anything in Render's dashboard; writing `repo:` into `../render.yaml` does not help either, since a blueprint only configures resources it creates.
- How to tell which path a deploy took, when reading `list_deploys`/`list_events`: an automatic one has `trigger: "new_commit"` and its events carry `trigger.newCommit` with no user; a manual one (the Render MCP, API or CLI) says `trigger: "api"` and names the user who clicked. If a push leaves `list_events` empty for a couple of minutes, suspect the app installation first and `trigger_deploy` only as the way to ship while that is being repaired.
- The front-end lives on Vercel at **`https://cadenza-unlikekats-projects.vercel.app`** (Vercel account `unlikekat`). Neither the repo nor `vercel.json` records that name — it was recovered on 2026-11-04 by fetching the site and reading its built chunks, which contain our own strings (class names like `practice-bar`, and the practice rule keys; specific words change with every UI pass, so anchor a check on names that outlive one redesign). When verifying a fresh push went live: the page code lives in the lazy route chunk `ScorePage-*.js`, whose name the entry chunk references — grep THERE, not the entry `index-*.js`, whose content-and-hash routinely survives builds that changed every route (learned the hard way on 2026-11-10: four hours spent declaring a healthy deploy "stale" because only the entry file was checked; the platform record and the actual `ScorePage` chunk both said otherwise). It is **current**: Vercel's Git integration survived the repository transfer — Render alone went deaf. Beware the neighbours: `cadenza.vercel.app` (500), `cadenza-app.vercel.app` (a Next.js app) and `cadenza-web.vercel.app` (a CalHacks CRA project using mediapipe) are other people's projects that also answer with the title "Cadenza"; probing them proves nothing about ours
- The Vercel MCP server is registered with its full tool list but connects to a hosted endpoint that answers 401 with `Www-Authenticate: Bearer error="invalid_token" … resource_metadata=https://mcp.vercel.com/.well-known/oauth-protected-resource`: the OAuth consent was never completed, so no tool ever registers and the enable script cannot fix it. Fix = re-authorise from the MCP panel; never paste a token into the repo

## Child DOX Index

- `src/` — Application source root: React entry point (`main.tsx`), top-level router (`App.tsx`), global stylesheets, and three durable subdomains:
  - `src/pages/` — Route-level page components (HomePage, UploadPage, ScorePage, ZeldaPage)
  - `src/components/` — Reusable presentational components (MidiPanel, PlaybackBar, PracticeBar, PianoKeyboard)
  - `src/hooks/` — Domain-logic hooks (useMidi, useVerdict), the pure exercise-rules module (practiceSteps) with its session hook (usePractice), and the pure end-of-take marking module (scoreMarks)

## Service contract

The backend lives in `../alignment/` and `../service/`, not here, but the web app depends on its three endpoints. They are contract, not implementation detail:

- `POST /` — normal mode. `{score, notes, control_changes, tempo_factor}` → the seven RML verdicts for the whole piece, each as `{ok, exit, locations?}`. `locations` is present **iff `exit == 1`** and carries every distinct point that rule caught in the act: `{measure, beat, attack}` — measure and snapped beat from the trace position join.py already writes, and `attack` = the event's `chordId`, the index of that attack in the **full** score, which is the number the OSMD cursor knows how to walk (the same contract as `attack` in a practice step). The page must reach its note by COUNTING to `attack`, never by matching pitches: the drawn score sits an octave-shift below the played trace, and height has never combined across the two sides. Where the rule really is a pair of numbers — the pitch rules and the dynamics rule — each location also carries `{kind: "pitch"|"velocity", played, written}` as plain integers read off the same trace line (`_detail_for` in `server.py`): the hover card needs "you vs score", and the service passes the numbers, never formatted prose. Jitter/pedal/articulation locations carry no pair — there is no pair to show, and an invented one would be the next bug. `batch.pl` prints the violated machine-stop event ids on the rule's line (`<name> 1 <id> <id> …`, capped at 40 per rule); `server.py` maps ids→points by reading, computing nothing, and deduplicating per (measure, beat). A restart-scan only LOCATES: the exit code still comes from the original single full pass, so an id can never invent or erase a violation
  - Two extra keys can appear inside `verdicts` besides the seven RML rules — `"never played"` and `"out of time"` — and they come from **python, not from a monitor** (`coverage()` in `server.py`, request of 2026-11-10). Why they cannot be RML rules: a trace line is born only from a PRESSED key, so an attack nobody pressed has no event id for `batch.pl` to point at; and join's snap quietly re-anchors a 500 ms-late press onto the NEIGHBOUR attack (measured on the real monitor: its `timing.deltaMs` came back ≈ 0 — the lateness vanishes in the snap). Coverage re-anchors by the number actually pressed against each written attack's expected pitches (greedy nearest-first, inside `MATCH_CAP_MS × tempo_factor`) and answers per attack: every expected pitch heard (a matching key), in time or not. A hole = a `"never played"` point — silent where an RML rule already claimed that same attack (its you/score pair has said everything). All pitches there but one drifted past `TIMING_TOL_MS` = an `"out of time"` point carrying `{kind:"timing", played}` — signed ms, positive = late; the page never formats these words, `scoreMarks.markLines` does. Timing is never suppressed even on an already-red point: wrong-key and wrong-time are different truths and the card must say both; the grade still docks the attack ONCE (the dedup key merges it into one column). Both keys appear only when non-empty, obey the locations contract exactly as `exit == 1` does, and exit-2 stays untouched by all of this
  - Alongside `verdicts`, the response carries `"correct": [{measure, beat, attack}, …]` — the written attacks that sounded their right pitch on time: the GREEN material (user request 2026-11-10: "le note premute correttamente fossero colorate di verde, e tutte le altre di rosso: note missate, note fuori tempo, note sbagliate"). It is a coverage fact (python re-anchor), not an RML verdict — it exists even when every monitor died. An attack never carries both colors: the server removes every red (RML ∪ synthetic) from `correct` before answering and `planMarks` re-checks client-side; red always wins, green carries no hover card because a success has nothing to explain. The two thresholds `TIMING_TOL_MS` (200 ms) and `MATCH_CAP_MS` (900 ms × factor) are declared choices — musical comfort, not math — living only in `server.py`; the page and the pure module see numbers, never thresholds
- `POST /practice` — the practice plan: `{score, hand}` → every step with the pitches it asks for, plus `attack` (the index of that attack in the **full** score, which is what the OSMD cursor walks), `offhand` (the pitches of the other staff at the same instant), the active rules, the suspended rules, and `hands` — what this file allows to separate (`{right, left, unknown, split}`)
- `POST /practice/step` — one step: `{score, step, hand, events, control_changes}` → the verdicts of the practice rules for that step, the completeness status (with `other_hand`: presses belonging to the excluded staff, declared and not counted as wrong), and the suspended rules
- `hand` is `null`/`"both"` = the whole piece, `"right"` = upper staff, `"left"` = lower staff. It changes the **exercise**, not the view: a different number of steps, different pitches, a different cursor target. An unrecognised hand is a 400, never a silent fall back to "both"
- The hand split comes from a voice → dominant-`<staff>` map, so cross-staff notes keep the hand that plays them; notes with no recognisable staff stay in the exercise even when one hand is chosen, because dropping them would make a step impossible to complete
- With one hand chosen, the other hand's attacks are **removed from the RML trace and from `chordMates`**, not merely forgiven: `chord-jitter` matches by chord membership, so an attack of the excluded hand at the same instant would mask real jitter. They still reach the UI as `other_hand` — absent is not zero

Measured on the deployed service (2026-11-04, Great Fairy Fountain piano cover), so the numbers are not guesses: `hand: null` → 128 steps, the first asking `[46, 93]`; `hand: "right"` → still **128** steps but asking a single pitch `[93]`, with `offhand: [46]` declared on 88 of them; `hand: "left"` → **88** steps asking `[46]`. `hands` = `{right: 128, left: 88, unknown: 0, split: true}`. The right hand does not shorten this piece — it has an attack at every position of the full score — so a check must assert the **keys asked**, and only the left-hand plan is smaller in step count. When reproducing that call by hand on this machine, build the JSON body with `[IO.File]::ReadAllText` into a plain string: PowerShell 5.1 turns a `Get-Content -Raw` value into `{"score":{"value":…}}`, and the service then answers `400 ValueError: missing MusicXML score` for a payload that looks full. Capture `curl.exe` output with `| Out-String` too — without it PowerShell 5.1 hands back an **array of lines**, so `.Length` counts lines and `.Contains()` compares whole elements, which reports every marker as missing in a bundle that plainly has it

Spec resolution, settled on 2026-11-10 after a whole lost afternoon: `server.py` uses `RML_MONITOR`/`RML_SPECS` when given; otherwise `/opt/rml` + `/opt/specs` IF those exist (stage-1 output of `service/Dockerfile`, so the deploy behaviour stays identical); otherwise the repo's own `RML_DOCS/RML_TESTS/{monitor,metrics}`, which is where a development machine keeps its compiled `.pl`. If none of the three resolves, the server now says so at startup, in English, out loud. Before this, a local restart done with only the documented command answered exit 2 with empty stderr for EVERY rule: the old process had been born in an ancient session that exported `RML_SPECS`/`RML_MONITOR`, and those died with it — while every suite that injects the two variables kept passing. The browser said "cannot verify" everywhere, and the divergence between test and running service stayed invisible for a day.

`exit` in a verdict is three-valued, and the app must not collapse it: `0` conforms, `1` is violated, `2` is **the monitor did not start** (missing `swipl`, a spec that does not compile). Rendering `2` as "violated" tells the student they played badly when the service is broken. The compact verdict line has its own tone for it (`pb-broken`) and ranks it above every playing problem — see `stepProblem` in `src/hooks/practiceSteps.ts`. The same rule governs the end-of-take marks on the score: red is painted only for points of a rule with `exit == 1`, and a monitor that never started appears as its own English line under the score ("not judged, the monitor did not start: …"), never as a red note — see `planMarks` in `src/hooks/scoreMarks.ts`.

Everything the service puts into a field the app prints — the `suspended` reasons, the 400/413 messages, the `error` of a failed request — is **English too**, because those strings arrive verbatim inside the app's own error box and would otherwise break the all-English rule from the one place nobody thinks to grep. The rule lives with the endpoint contract, not with the front-end: `SUSPENDED_RULES` in `../alignment/practice.py` and the `ValueError`s of `../alignment/server.py` are user-facing text.