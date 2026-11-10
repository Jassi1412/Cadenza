/* Esegue davvero il piano di marcature sulle note dello spartito, senza vitest.
 *
 * Perche' esiste: come per run_practice_tests.mjs, scoreMarks.ts e' un modulo
 * PURE (niente React, niente rete, niente import.meta.env), e la decisione che
 * prende — quali punti colorare, cosa dire alle righe della card d'hover, come
 * calcolare il voto 0-100, quando NON colorare niente — deve essere verificabile
 * senza browser. Questa e' la stessa funzione compilata da tsc e finita nel
 * bundle, non una sua descrizione.
 *
 * Dal 2026-11-10 scoreMarks importa `noteName` da practiceSteps (stesso nome del
 * tasto della tastiera disegnata e della card), quindi i DUE file vengono
 * compilati insieme: `require('./practiceSteps')` nell'emesso deve trovare il
 * fratello, non una copia descritta a mano. Un package.json commonjs dichiarato
 * qui dentro toglie ogni ambiguita' sul formato, qualunque sia il type dei
 * package.json piu' in alto.
 *
 * Uso:  node alignment/run_scoremarks_tests.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web-app');
const OUT = path.join(HERE, '_probe_traces', 'marks');
const require = createRequire(import.meta.url);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'package.json'), '{"type":"commonjs"}\n');

execFileSync('npx', ['tsc',
  'src/hooks/scoreMarks.ts',
  'src/hooks/practiceSteps.ts',
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

const { planMarks, markLines, markTipFor, performanceScore, summaryLines, endSignal, consumedFullTrack } = require(path.join(OUT, 'scoreMarks.cjs'));

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
  markLines(v1.columns[0]).map((l) => l.rule).join(', ') === 'pitch-agreement, dynamics-adherence');
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
check('exit 2 non colora niente', !v2.columns.some((c) => c.rules.some((r) => r.name === 'pedal-toggle')));
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
  dup.columns.length === 2 && markLines(dup.columns[0]).map((l) => l.rule).join(', ') === 'pitch-agreement, chord-jitter');

// --------------------------------------- le righe della card d'hover coi numeri nudi
// Il servizio allega `kind`/`played`/`written` dove i numeri esistono davvero.
// La card vuole una riga per regola con la coppia "you · score": sono due numeri
// veri, non una frase; e la formattazione vive QUI, provata, non nel JSX.
const LV = (measure, beat, attack, kind, played, written) =>
  ({ measure, beat, attack, kind, played, written });
const sporchi = planMarks({
  'pitch-agreement': V(1, [LV(5, 1, 7, 'pitch', 62, 64)]),          // D4 suonato, E4 scritto
  'dynamics-adherence': V(1, [LV(5, 1, 7, 'velocity', 101, 84)]),
  'chord-jitter': V(1, [{ measure: 5, beat: 1, attack: 7 }]),       // nessuna coppia di numeri
});
const righe = markLines(sporchi.columns[0]);
check('tutte e tre le regole su UN punto = tre righe, una per regola',
  righe.length === 3 && righe.map((l) => l.rule).join(' ') === 'pitch-agreement dynamics-adherence chord-jitter');
check('la riga del pitch dice tasto premuto e tasto scritto, col nome giusto',
  righe[0].detail === 'you D4 · score E4');
check('la riga della dinamica dice le due velocità, senza allunghi',
  righe[1].detail === 'you 101 · score 84');
check('jitter senza numeri: la riga c\'è, il dettaglio no — niente inventato',
  righe[2].detail === undefined);
const tip5 = markTipFor(sporchi.columns[0]);
check('la card sa anche dove sei: misura e battitura in testa',
  tip5.measure === 5 && tip5.beat === 1 && tip5.lines.length === 3);
// un solo numero c\'è, l\'altro no: la coppia è monca e la riga resta pulita
const monco = planMarks({ 'pitch-agreement': V(1, [{ measure: 2, beat: 0, attack: 3, kind: 'pitch', played: 60, written: null }]) });
check('coppia di numeri mezza assente = nessuna riga con buchi',
  markLines(monco.columns[0])[0].detail === undefined);

// ------------------------------------------------- il voto 0-100 della carta centrata
const OK7 = Object.fromEntries(['pitch-agreement', 'chord-jitter', 'dynamics-adherence',
  'pedal-toggle', 'syncopated-pedal', 'articulation', 'pitch-range'].map((k) => [k, V(0)]));
const pulito = performanceScore(OK7, 216);
check('esecuzione senza macchie: 100', pulito.score === 100 && pulito.flagged === 0);
// stesso attacco colto da due regole = UN errore, non due: la pagella perdonerebbe
// il doppio di quanto fa male davvero, e i rossi sulla partitura già contano uno
const dueRegoleStessoPunto = performanceScore({
  ...OK7, // prima la base pulita: poi le regole sporche la vincevano lo spread, non il caso
  'pitch-agreement': V(1, [L(5, 1, 7), L(6, 0, 12)]),
  'dynamics-adherence': V(1, [L(5, 1, 7)]),
}, 20);
check('due regole sullo stesso attacco scalano UNA volta sola: 2 errori su 20 = 90',
  dueRegoleStessoPunto.flagged === 2 && dueRegoleStessoPunto.score === 90);
const conUnpinned = performanceScore({
  ...OK7,
  'syncopated-pedal': V(1), // violated senza locations
}, 10);
check('violazione senza punto in fallo: conta un errore, non zero',
  conUnpinned.flagged === 1 && conUnpinned.score === 90);
const conRotta = performanceScore({ ...OK7, 'pitch-agreement': { ok: false, exit: 2 } }, 50);
check('un monitor che non è partito NON toglie punti', conRotta.score === 100);
const tutteRotte = performanceScore(Object.fromEntries(
  Object.keys(OK7).map((k) => [k, { ok: false, exit: 2 }])), 50);
check('se nessun monitor è partito il voto NON si dà: niente "100" bugiardo',
  tutteRotte.score === null);
const tuttoFallo = performanceScore({
  'pitch-agreement': V(1, Array.from({ length: 30 }, (_, i) => L(i + 1, 0, i))),
  ...Object.fromEntries(Object.keys(OK7).filter((k) => k !== 'pitch-agreement').map((k) => [k, V(0)])),
}, 30);
check('tutte le note segnate in fallo = 0, e non un numero sotto zero',
  tuttoFallo.flagged === 30 && tuttoFallo.score === 0);
const notaZero = performanceScore({ 'pitch-agreement': V(1, [L(1, 0, 0)]), ...Object.fromEntries(Object.keys(OK7).filter((k) => k !== 'pitch-agreement').map((k) => [k, V(0)])) }, 0);
check('zero note contate ma un errore in mano: il voto tocca fondo senza divisioni bugiarde',
  notaZero.score === 0 && notaZero.flagged === 1);

// ─────────── la fine del brano: endSignal e consumedFullTrack (fatti, non soglie)
// L'utente ha respinto la stima all'85% ("falsi positivi... preferirei
// qualcosa di più robusto che è sicuro al 100%"). dur=60000 ms, passo tipico
// 16 ms: il margine del riavvolgimento vale due passi misurati, non percentuali.
check('cima raggiunta: è fine, anche se l\'ultimo prelievo veniva di lontano',
  endSignal(60000, 59998, 40000, 40000, 16) === 'top');
check('un millimetro sotto la cima non è ancora fine (lo slack è di 2 ms, non un\'approssimazione larga)',
  endSignal(60000, 59997, 59981, 59981, 16) === null);
check('caduta a metà brano: il falso positivo temuto dall\'utente NON diventa fine',
  endSignal(60000, 1200, 30000, 30000, 16) === null);
check('riavvolgimento dopo la traccia consumata per intero: è la fine travestita da ripartenza',
  endSignal(60000, 8, 59970, 59970, 16) === 'rewind');
check('caduta con la traccia NON ancora consumata (margine di due passi): si suona ancora',
  endSignal(60000, 8, 59950, 59950, 16) === null);
check('il primo prelievo della presa non ha un "prima": nessuna caduta da leggere',
  endSignal(60000, 59990, -1, 59990, 16) === null);
check('consumedFullTrack risponde da sola alla domanda del loop dichiarato dal worklet',
  consumedFullTrack(60000, 59970, 16) === true &&
  consumedFullTrack(60000, 30000, 16) === false &&
  consumedFullTrack(60000, 0, 0) === false);
// Il caso segnalato dall'utente, ricostruito fotogramma per fotogramma: salita
// regolare, UN salto a metà (la cima dei 2 ms non viene mai campita perché il
// passo la scavalca), poi il riavvolgimento del player. La fine dev'essere
// colta QUELLA volta lì, non al giro dopo.
const dente = [];
for (let s = 0; s <= 59984; s += 16) dente.push(s === 2048 ? 2018 : s);
dente.push(8, 24, 40);
let pPrima = -1;
let salita = 0;
let passoCorsa = 0;
let vistaTop = false;
let esitoFine = null;
let doveFine = -1;
dente.forEach((s, i) => {
  const d = s - pPrima;
  if (d > 0) { salita += d; if (d > passoCorsa) passoCorsa = d; }
  const e = endSignal(60000, s, pPrima, salita, passoCorsa);
  if (e === 'top') vistaTop = true;
  else if (e === 'rewind' && esitoFine === null) { esitoFine = e; doveFine = i; }
  pPrima = s;
});
check('il caso dell\'utente, fotogramma per fotogramma: il salto a metà viene ignorato, la fine è colta al primo riavvolgimento',
  !vistaTop && esitoFine === 'rewind' && doveFine === dente.length - 3);

console.log('\n' + '='.repeat(58));
const falliti = esiti.filter(([, ok]) => !ok);
console.log(esiti.length - falliti.length + '/' + esiti.length + ' controlli passati');
process.exit(falliti.length ? 1 : 0);
