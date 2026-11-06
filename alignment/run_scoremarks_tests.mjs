/* Esegue davvero il piano di marcature sulle note dello spartito, senza vitest.
 *
 * Perche' esiste: come per run_practice_tests.mjs, scoreMarks.ts e' un modulo
 * PURE (niente React, niente rete, niente import.meta.env), e la decisione che
 * prende — quali punti colorare, quali nomi finire in un tooltip, quando NON
 * colorare niente — deve essere verificabile senza browser. Questa e' la stessa
 * funzione compilata da tsc e finita nel bundle, non una sua descrizione.
 *
 * Uso:  node alignment/run_scoremarks_tests.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web-app');
const OUT = path.join(HERE, '_probe_traces', 'marks');
const require = createRequire(import.meta.url);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

execFileSync('npx', ['tsc',
  'src/hooks/scoreMarks.ts',
  '--outDir', OUT,
  '--module', 'commonjs',
  '--target', 'es2020',
  '--moduleResolution', 'bundler',
  '--ignoreConfig',
  '--skipLibCheck',
], { cwd: WEB, stdio: 'inherit', shell: true });

const emitted = path.join(OUT, 'scoreMarks.js');
if (!existsSync(emitted)) throw new Error('tsc non ha prodotto scoreMarks.js');
renameSync(emitted, path.join(OUT, 'scoreMarks.cjs'));

const { planMarks, hoverLabel, summaryLines } = require(path.join(OUT, 'scoreMarks.cjs'));

const esiti = [];
function check(label, cond) {
  esiti.push([label, !!cond]);
  if (!cond) console.log('  FALLITO  ' + label);
}

const V = (exit, locations) => ({ ok: exit === 0, exit, ...(locations ? { locations } : {}) });
const L = (measure, beat, attack = null) => ({ measure, beat, attack });

// ------------------------------------------------------------------ la forma
// Il payload del servizio assomiglia a questo: pitch-agreement punta due punti,
// dynamics-adherence ne punta uno che coincide con la prima nota stonata.
// L'attack e' l'indice assoluto dell'attacco, quello che il cursore sa contare:
// senza di lui la pagina non avrebbe modo di arrivare alla nota giusta.
const v1 = planMarks({
  'pitch-agreement': V(1, [L(5, 3.25, 7), L(9, 0, 20)]),
  'dynamics-adherence': V(1, [L(5, 3.25, 7), L(12, 1, 33)]),
  'chord-jitter': V(0),
});
check('due regole sullo stesso punto diventano UN solo rosso',
  v1.columns.length === 3);
check('il punto in comune porta entrambe le regole, in ordine di arrivo',
  hoverLabel(v1.columns[0]) === 'pitch-agreement, dynamics-adherence');
check('il punto in comune conserva l\'indice dell\'attacco',
  v1.columns[0].attack === 7);
check('i punti sono ordinati per battuta e battitura',
  v1.columns.map((c) => `${c.measure}:${c.beat}`).join(' ') === '5:3.25 9:0 12:1');

// La deduplica buona usa l\'INDICE: due rappresentazioni arrotondate della stessa
// battuta, con lo stesso attack, devono restare un punto solo. Se il servizio un
// giorno cambiera' la precisione del beat, il rosso non si duplichera'.
const same = planMarks({
  'pitch-agreement': V(1, [L(5, 3.25001, 7)]),
  'dynamics-adherence': V(1, [L(5, 3.24999, 7)]),
});
check('stesso attack = stesso punto anche se il beat differisce di un\'inezia',
  same.columns.length === 1);

// Senza indice il punto esiste comunque (viene dalla misura letta lo stesso), ma
// chi colora dovra' dichiararlo raggiunto male: l\'attacco nullo passa al walker.
const orbo = planMarks({ 'pitch-agreement': V(1, [L(2, 1)]) });
check('senza attack il punto resta nel piano, marcato come non raggiungibile',
  orbo.columns.length === 1 && orbo.columns[0].attack === null);

// ------------------------------------------------- exit 2: mai una nota rossa
const v2 = planMarks({
  'pedal-toggle': { ok: false, exit: 2, locations: [L(1, 0)] }, // anche se il
  'pitch-agreement': V(1, [L(2, 1)]),                           // servizio la
  'articulation': V(0), 'chord-jitter': V(0),                   // mandasse sporca
  'dynamics-adherence': V(0), 'pitch-range': V(0), 'syncopated-pedal': V(0),
});
check('exit 2 non colora niente', !v2.columns.some((c) => c.rules.includes('pedal-toggle')));
check('exit 2 finisce nella riga "not judged"', v2.broken.join(',') === 'pedal-toggle');
check('exit 2 non finisce fra le violate senza punto', !v2.unpinned.includes('pedal-toggle'));

// ----------------------------------------------- violate senza un punto (o sporche)
const v3 = planMarks({
  'syncopated-pedal': V(1),                        // nessuna locations: e' il caso
  'pitch-agreement': V(1, [L(1, Number.NaN)]),     // della violazione che non sa
  'pedal-toggle': V(1, [{ measure: 'x', beat: 2 }]), // dove puntare il dito
});
check('violazione senza locations: nessuno rosso, nome nella riga',
  v3.columns.length === 0
  && v3.unpinned.join(',') === 'pedal-toggle,pitch-agreement,syncopated-pedal');

// ------------------------------------------------------------ le parole della riga
const sole = planMarks({ 'pitch-agreement': V(0), 'chord-jitter': V(0) });
const r1 = summaryLines(sole, 0, [], 216);
check('esecuzione pulita: la riga dice che niente e\' marcato',
  r1.length === 1 && r1[0].includes('every rule the service judged was respected'));
const sporco = planMarks({
  'pitch-agreement': V(1, [L(5, 1), L(6, 0)]),
  'dynamics-adherence': V(1, [L(5, 1)]),
});
const r2 = summaryLines(sporco, 2, [], 216);
check('punti marcati: un punto al singolare / due al plurale',
  r2[0].includes('2 spots') && summaryLines(sporco, 1, [], 216)[0].includes('1 spot'));
const conMancante = summaryLines(sporco, 1, ['5:3'], 216);
check('un punto non raggiunto dal cursore non sparisce nel nulla',
  conMancante.join('\n').includes('violated without a point in the score'));
const rotto = planMarks({ 'pitch-agreement': { ok: false, exit: 2 }, 'chord-jitter': V(1, [L(3, 0)]) });
const r4 = summaryLines(rotto, 1, [], 100);
check('monitor rotto dichiarato senza colpevolizzare l\'allievo',
  r4.some((l) => l.startsWith('not judged') && l.includes('pitch-agreement')));

// ---------------------------------------------------- stabilita' della chiave
const dup = planMarks({
  'pitch-agreement': V(1, [L(2, 0), L(2, 0.5)]),
  'chord-jitter': V(1, [L(2, 0), L(2, 0.5)]),
});
check('lo stesso punto ripetuto dalla stessa regola non raddoppia i nomi',
  dup.columns.length === 2 && hoverLabel(dup.columns[0]) === 'pitch-agreement, chord-jitter');

console.log('\n' + '='.repeat(58));
const falliti = esiti.filter(([, ok]) => !ok);
console.log(esiti.length - falliti.length + '/' + esiti.length + ' controlli passati');
process.exit(falliti.length ? 1 : 0);
