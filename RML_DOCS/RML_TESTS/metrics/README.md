# Metriche RML — Indice (Fase 1)

Specifiche RML (Runtime Verification) delle 6 metriche di esecuzione pianistica del progetto **Cadenza** (tirocinio Runtime Verification). Ogni file `.rml` è autonomo, è stato compilato con il compilatore RML reale (ANTLR + Kotlin, con vincoli CLP(Q/R) in output Prolog) e verifica la semantica dei requisiti FR-001..FR-006 di `.swarm/spec.md`.

Le metriche operano sul modello di eventi Web MIDI (webmidi v3): oggetti JSON `noteon`, `noteoff`, `controlchange`, uno per riga (JSONL), con `timestamp` in ms.

## Indice delle metriche

| File | FR | Metrica | Costrutti RML usati | Categoria |
|------|----|---------|---------------------|-----------|
| `pitch-range.rml` | FR-001 | Pitch Range Check — ogni `noteon` nel range 88 tasti A0(21)–C8(108) | `matches` su oggetto JSON, `with` (range `num >= 21 && num <= 108`), alias arity-0, `*` | Easy |
| `dynamics-adherence.rml` | FR-002 | Dynamics Adherence — ogni `noteon` della traccia ha `rawAttack >= 80` | derived da evento base, alias arity-0, `*` postfissa | Easy |
| `pedal-toggle.rml` | FR-003 | Pedal Toggle Detection — CC64: pressione `value==127`, rilascio `value==0` | `matches` su `controlchange`, `with` (uguaglianze), unione `|`, alias arity-0, `*` | Easy |
| `chord-jitter.rml` | FR-004 | Chord Jitter — accordo C4(60)+E4(64) premuto entro 50ms in entrambi gli ordini | `let`, `\/` (shuffle), derived parametrico `near(n,t1)` con `abs(t2-t1)<50` (check_der), `>>`, `*` | Medium |
| `syncopated-pedal.rml` | FR-005 | Syncopated Pedal — pedale premuto (CC64 `value:127`) entro 200ms dall'attacco della nota | `let`, derived parametrico `pedalSoon(t1)` con `t2 > t1 && t2 - t1 < 200` (check_der), `not matches` + `other*` (tolleranza eventi intermedi), `*` | Medium |
| `articulation.rml` | FR-006 | Articulation (Legato/Staccato) — delta `t2-t1` tra `noteoff(N)` e `noteon(N+1)`; `<=30ms` = legato, `>30ms` = staccato (violazione) | `let`, derived parametrico `legatoNext(t1)` con `t2-t1<=30` (check_der), `*` | Medium |

## Come compilare ed eseguire

Tutto è automatizzato in due script, da eseguire dalla root del repo.

### 1. Compilazione (RML → Prolog)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File RML_DOCS\RML_TESTS\metrics\build-pl.ps1
```

Genera il `.pl` di ogni `.rml`. Il compilatore RML (ANTLR + Kotlin) sta in `RML_DOCS/RML_TESTS/compiler/`, che è gitignored: su clone pulito va re-clonato.

Il compilatore produce il modulo Prolog con i predicati `match/2` e `trace_expression/2`; i vincoli `with` diventano vincoli CLP(Q/R) (es. `{Num >= 21, Num =< 108}`), come nell'output compilato del PoC `midi-probe/piano-test.pl`.

### 2. Verdetto (monitor RML)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File RML_DOCS\RML_TESTS\metrics\run-verdicts.ps1
```

Esegue ogni metrica contro due tracce in `traces/` e confronta l'esito con quello atteso. Exit 0 = tutti i verdetti come atteso.

Il monitor RML ha **due soli esiti**, non quattro:

| exit | output |
|------|--------|
| 0 | `Execution terminated correctly` |
| 1 | `Trace did not match specification` |

Il verdetto a 4 valori (True / Maybe True / Maybe False / False) descritto in `RUNTIME_VERIFICATION_ANALYSIS.md` è il modello teorico della Runtime Verification, **non** l'output di questo tool.

### 3. Le tracce di test

`traces/<metrica>.ok.jsonl` e `traces/<metrica>.fail.jsonl`, entrambe in JSONL (un evento per riga, formato webmidi v3). Ogni coppia è scelta per far discriminare la metrica: senza il caso `fail` una specifica che accetta tutto passerebbe lo stesso.

Il verdetto atteso è implicito dal nome del file.

### 4. Cattura di una traccia reale

Il PoC in `RML_DOCS/RML_TESTS/midi-probe/` mostra il flusso completo: `node probe.js` registra gli eventi MIDI del pianoforte in `events.json`. La traccia così ottenuta **non** è direttamente utilizzabile con le 6 metriche: contiene `noteon` e `noteoff` alternati, mentre ogni `Main` accetta solo il proprio tipo di evento e rifiuta tutto il resto. Per es. `pitch-range` ha `Main = noteOn*` e muore sul primo `noteoff`. Servono tracce filtrate per metrica.

## Stato verificato

Tutte e sei le metriche compilano e discriminano. `run-verdicts.ps1` esce 0 con 12/12 verdetti attesi (6 `ok` → exit 0, 6 `fail` → exit 1).

Una specifica è coperta solo se respinge almeno una traccia: `dynamics-adherence` in origine passava entrambe le tracce disponibili ed è stata riscritta.

### Correzioni applicate il 2026-09-26

**`dynamics-adherence.rml`** — `Main` era `(noteOn >> forteNote)*`, errato per due ragioni:

1. `>>` in RML è un **filtro** (`ET>>T = T/\ET* | notET*`), non una sequenza: consuma l'evento ma non pretende che un secondo evento lo soddisfaci (`trace_expressions_semantics.pl:78`).
2. Concatenando `noteOn` a `forteNote`, entrambi matchano lo **stesso** evento `noteon`, quindi la coppia pretende due note forti consecutive — non "una nota poi una forte".

La forma corretta è `Main = forteNote*`: stella **postfissa** sul tipo evento, come in `piano-test.rml`. `star(forteNote)` non compila — genera `star_et(var(forteNote))`, un tipo inesistente.

Nota sul significato: FR-002 è una soglia auto-contenuta, non un confronto con lo spartito. Il verdetto True significa "tutte le note della traccia sono forti", non "l'esecuzione aderisce alla dinamica notata". Il confronto con lo spartito richiede il score follower, che esiste già in `web-app/src/hooks/usePracticeMode.ts` (`GNotesUnderCursor`).

### Correzione applicata il 2026-09-28

**`articulation.rml` (FR-006)** — la soglia era `t2-t1 <= 0`, con l'intento di misurare la sovrapposizione. Il predicato non è soddisfacibile su un flusso MIDI reale: il verdetto viene valutato sul `noteon` successivo, e a quel momento il `noteoff` precedente è **già avvenuto**, quindi `t2 - t1` è necessariamente positivo. Inoltre l'ordine degli eventi è inverso rispetto alla sovrapposizione vera (che è `noteon` **prima** del `noteoff`), quindi quella non veniva neppure esaminata.

Il test esistente non lo evidenziava perché costruiva array sintetici con timestamp fuori ordine (`noteOff(1000)` seguito da `noteOn(970)`), cosa impossibile dallo streaming reale.

Decisione (2026-09-28): legato = la nota successiva suona **mentre la precedente è ancora premuta** (sovrapposizione) **oppure** entro 30ms dal suo rilascio. La soglia 30ms resta quella di legato; dall'11-11-2026 `chord-jitter` usa 50ms, perché 30ms è al limite dello scarto umano fra le note di un accordo.

Copertura dei due livelli:

- **RML** esprime solo il criterio di gap (`t2-t1 <= 30`). La sovrapposizione richiede di sapere quale nota è ancora premuta, uno stato che un derivato parametrico su coppia di eventi non può rappresentare.
- **TypeScript** (`web-app/src/pages/MetricsTestPage.tsx`) implementa entrambi: tiene un `Set<number>` delle note ancora premute e controlla la sovrapposizione **prima** del confronto temporale.

Le due tracce di test esistenti restano valide senza modifiche (`delta` 0 → ok, `delta` 100 → fail).

## Convenzioni grammaticali rispettate

Tutte e sei le specifiche seguono le stesse convenzioni della grammatica RML (`RML.g4`):

- **Dichiarazioni prima delle equazioni**: tutti i tipi evento (`matches` / `not matches`) e i tipi derived sono dichiarati all'inizio del file; le equazioni seguono.
- **`with` solo nelle dichiarazioni derived** (`derivedEvtypeDecl`): la clausola `with` esprime vincoli booleani sui campi dell'evento corrente — incluso il confronto con parametri legati da eventi precedenti — e non è ammessa dentro le equazioni.
- **Identificatori di equazione UPPERCASE**: `Main`, `Chord`, `Pedal`, `Articulation` rispettano la regola `expId` della grammatica (identificatore maiuscolo).
- **Alias arity-0**: quando un tipo evento con parametri serve in un contesto senza argomenti, si dichiara un alias con wildcard, uno per parametro — es. `noteOn matches noteOn(_);`.
- **Vincoli cross-event (pattern `check_der`)**: i vincoli temporali tra eventi diversi passano per un derived parametrico — es. `near(n, t1) matches noteOnT(n, t2) with abs(t2 - t1) < 50;` — dove `t1` è legato al timestamp di un evento precedente tramite `{let t1; ...}` nell'equazione.

## Riferimenti

- `.swarm/spec.md` — requisiti FR-001..FR-006 e modello eventi Web MIDI.
- `RUNTIME_VERIFICATION_ANALYSIS.md` — analisi Runtime Verification del progetto.
- `RML_GUIDA_COMPLETA.md` — guida completa al linguaggio RML (versione divisa in file tematici in `RML_DOCS/00_README.md`).
- `RML_DOCS/RML_TESTS/midi-probe/` — PoC end-to-end: `piano-test.rml` (spec), `piano-test.pl` (output compilato), `probe.js` (cattura MIDI), `events.json` (traccia JSONL), `verdict.txt` (esito del monitor).
