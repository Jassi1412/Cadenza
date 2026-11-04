/* Esegue davvero le regole dell'esercizio a passi, senza vitest.
 *
 * Perche' esiste: `vitest` e `vite build` non partono in questo ambiente perche'
 * Vite chiama execFile("net use") e il sandbox nega lo spawn. Ma le regole di
 * practiceSteps.ts sono PURE — niente React, niente rete, niente import.meta.env
 * — quindi si compilano con tsc e si eseguono con node. Questa e' una verifica
 * vera, non una sua imitazione: e' lo stesso codice che finisce nel bundle.
 *
 * Uso:  node alignment/run-practice-tests.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web-app');
const OUT = path.join(HERE, '_probe_traces', 'steps');
const require = createRequire(import.meta.url);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// commonjs: node lo carica senza altre cerimonie.
// --ignoreConfig e' necessario: nella cartella c'e' un tsconfig.json, e tsc si
// rifiuta di compilare un file passato a mano mentre quello esiste.
// moduleResolution bundler e' quello che usa il progetto; node10 e' deprecato e
// tsc esce in errore prima ancora di compilare.
execFileSync('npx', ['tsc',
  'src/hooks/practiceSteps.ts',
  '--outDir', OUT,
  '--module', 'commonjs',
  '--target', 'es2020',
  '--moduleResolution', 'bundler',
  '--ignoreConfig',
  '--skipLibCheck',
], { cwd: WEB, stdio: 'inherit', shell: true });

const emitted = path.join(OUT, 'practiceSteps.js');
if (!existsSync(emitted)) throw new Error('tsc non ha prodotto practiceSteps.js');
renameSync(emitted, path.join(OUT, 'practiceSteps.cjs'));

const { noteName, pressedPitches, stepStatus, stepProblem } = require(path.join(OUT, 'practiceSteps.cjs'));

const on = (timestamp, note, rawAttack = 90) => ({ type: 'noteon', note, rawAttack, timestamp });
const off = (timestamp, note) => ({ type: 'noteoff', note, timestamp });
// `attack` e l'indice dell'attacco nello spartito completo: con una mano sola non
// coincide piu' con `index`, e il cursore di OSMD deve seguire quello.
const passo = (pitch, offhand = [], attack = 0) => ({
  index: 0, total: 10, attack, measure: 1, pitch, offhand, articulation: null,
});

const esiti = [];
function check(label, cond) {
  esiti.push([label, !!cond]);
  if (!cond) console.log('  FALLITO  ' + label);
}

// ---------------------------------------------------------------- pressedPitches
check('un pitch premuto due volte conta una volta',
  JSON.stringify(pressedPitches([on(0, 60), off(10, 60), on(20, 60)])) === '[60]');
check('un note-on a velocity 0 non e\' una pressione',
  pressedPitches([on(0, 60, 0)]).length === 0);
check('i control change e i rilievi si ignorano',
  pressedPitches([{ type: 'controlchange', controller: 64, value: 127, timestamp: 0 },
    off(10, 60)]).length === 0);
check('i pitch escono ordinati',
  JSON.stringify(pressedPitches([on(0, 67), on(10, 60), on(20, 64)])) === '[60,64,67]');
check('un accordo suonato con calma resta completo',
  JSON.stringify(pressedPitches([on(0, 46), on(500, 93)])) === '[46,93]');

// ---------------------------------------------------------------- stepStatus
check('avanza quando tutte le note del passo ci sono',
  stepStatus(passo([46, 93]), [on(0, 46), on(15, 93)]).advance === true);
check('non avanza se ne manca una, e dice quale',
  JSON.stringify(stepStatus(passo([46, 93]), [on(0, 46)]).missing) === '[93]');
check('non avanza con la nota sbagliata',
  stepStatus(passo([91]), [on(0, 92)]).advance === false);
check('AVANZA anche con una nota in piu\' (il caso decisivo)',
  stepStatus(passo([46, 93]), [on(0, 46), on(15, 93), on(30, 47)]).advance === true);
check('la nota in piu\' viene comunque segnalata',
  JSON.stringify(stepStatus(passo([46, 93]),
    [on(0, 46), on(15, 93), on(30, 47)]).extra) === '[47]');
check('senza nessuna nota non avanza',
  stepStatus(passo([46, 93]), []).advance === false);
check('un tasto tenuto da prima non fa avanzare',
  stepStatus(passo([46, 86]), [on(0, 53)]).advance === false);

// ------------------------------------------------- la mano esclusa (other_hand)
check('con la mano studiata, il tasto dell\'altra mano non e\' una nota estranea', (() => {
  const s = stepStatus(passo([93], [46]), [on(0, 93), on(12, 46)]);
  return s.advance === true && s.extra.length === 0
    && JSON.stringify(s.other_hand) === '[46]';
})());
check('solo la nota dell\'altra mano: non avanza, ma non ha sbagliato niente', (() => {
  const s = stepStatus(passo([93], [46]), [on(0, 46)]);
  return s.advance === false && JSON.stringify(s.missing) === '[93]'
    && s.extra.length === 0 && JSON.stringify(s.other_hand) === '[46]';
})());
check('un tasto che non c\'entra con nessuna delle due mani resta estraneo',
  JSON.stringify(stepStatus(passo([93], [46]), [on(0, 93), on(12, 47)]).extra) === '[47]');
check('senza filtro mano la lista dell\'altra mano e\' vuota',
  JSON.stringify(stepStatus(passo([46, 93]),
    [on(0, 46), on(15, 93), on(30, 47)]).other_hand) === '[]');

// -------------------------------------------------- la riga compatta (stepProblem)
const okR = { ok: true, exit: 0 };
const male = { ok: false, exit: 1 };
const rottaR = { ok: false, exit: 2 };
const verdetto = (step, spec) => ({ step, verdicts: spec });

check('tutto conforme: la riga dice conforme',
  stepProblem({
    last: verdetto(3, { 'pitch-agreement': okR, 'chord-jitter': okR, 'dynamics-adherence': okR }),
    stepIndex: 3, judging: false, error: null, dynamicsOn: true,
  }).text === 'conforme');
check('la nota sbagliata passa prima di chord jitter e dinamica', (() => {
  const p = stepProblem({
    last: verdetto(3, { 'pitch-agreement': male, 'chord-jitter': male, 'dynamics-adherence': male }),
    stepIndex: 3, judging: false, error: null, dynamicsOn: true,
  });
  return p.text === 'nota sbagliata' && p.tone === 'warn';
})());
check('chord jitter da solo si vede', (() => {
  const p = stepProblem({
    last: verdetto(3, { 'pitch-agreement': okR, 'chord-jitter': male, 'dynamics-adherence': okR }),
    stepIndex: 3, judging: false, error: null, dynamicsOn: true,
  });
  return p.text === 'chord jitter';
})());
check('dinamica errata si vede solo con l\'interruttore acceso', (() => {
  const last = verdetto(3, { 'pitch-agreement': okR, 'chord-jitter': okR, 'dynamics-adherence': male });
  return stepProblem({ last, stepIndex: 3, judging: false, error: null, dynamicsOn: true }).text === 'dinamica errata'
    && stepProblem({ last, stepIndex: 3, judging: false, error: null, dynamicsOn: false }).text === 'conforme';
})());
check('exit 2 non diventa mai "nota sbagliata": e\' il servizio, non l\'allievo', (() => {
  const p = stepProblem({
    last: verdetto(3, { 'pitch-agreement': rottaR, 'chord-jitter': okR, 'dynamics-adherence': okR }),
    stepIndex: 3, judging: false, error: null, dynamicsOn: true,
  });
  return p.text === 'non verificabile' && p.tone === 'broken';
})());
check('pitch-range violato conta come nota sbagliata',
  stepProblem({
    last: verdetto(3, { 'pitch-range': male, 'chord-jitter': okR }),
    stepIndex: 3, judging: false, error: null, dynamicsOn: true,
  }).text === 'nota sbagliata');
check('il verdetto di un passo gia\' lasciato e\' dichiarato vecchio',
  stepProblem({
    last: verdetto(11, { 'pitch-agreement': okR }), stepIndex: 12,
    judging: false, error: null, dynamicsOn: true,
  }).stale === true);
check('nessun verdetto ancora: nessun "conforme" inventato', (() => {
  const p = stepProblem({ last: null, stepIndex: 0, judging: false, error: null, dynamicsOn: true });
  return p.tone === 'waiting' && p.text === 'suona i tasti del passo';
})());
check('verdetto vuoto perche\' non era premuto niente: non e\' "conforme"',
  stepProblem({
    last: verdetto(3, {}), stepIndex: 3, judging: false, error: null, dynamicsOn: true,
  }).tone === 'waiting');
check('una richiesta in volo si dichiara come verifica in corso',
  stepProblem({ last: null, stepIndex: 0, judging: true, error: null, dynamicsOn: true }).tone === 'checking');
check('un errore di rete non e\' un giudizio su come hai suonato', (() => {
  const p = stepProblem({
    last: null, stepIndex: 0, judging: false, error: 'il servizio ha risposto 502', dynamicsOn: true,
  });
  return p.tone === 'warn' && p.text === 'il verdetto non e\' arrivato';
})());

// ---------------------------------------------------------------- noteName
check('60 e\' C4', noteName(60) === 'C4');
check('69 e\' A4', noteName(69) === 'A4');
check('21 e\' A0 (estremo della tastiera)', noteName(21) === 'A0');
check('108 e\' C8 (estremo della tastiera)', noteName(108) === 'C8');
check('61 e\' C#4', noteName(61) === 'C#4');
check('l\'ottava cambia a ogni do: 59 e\' B3, 60 e\' C4',
  noteName(59) === 'B3' && noteName(60) === 'C4');

const falliti = esiti.filter(([, ok]) => !ok);
console.log('\n' + '='.repeat(58));
console.log('practiceSteps: %d/%d controlli passati', esiti.length - falliti.length, esiti.length);
console.log('='.repeat(58));
process.exit(falliti.length ? 1 : 0);
