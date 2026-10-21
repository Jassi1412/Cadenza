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

const { noteName, pressedPitches, stepStatus } = require(path.join(OUT, 'practiceSteps.cjs'));

const on = (timestamp, note, rawAttack = 90) => ({ type: 'noteon', note, rawAttack, timestamp });
const off = (timestamp, note) => ({ type: 'noteoff', note, timestamp });
const passo = (pitch) => ({ index: 0, total: 10, measure: 1, pitch, articulation: null });

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
