/**
 * LA SONDA DEI ROSSI: verifica in un browser vero (Chromium via CDP) che la
 * coloratura dei punti sbagliati trovi DAVVERO le note giuste, che il tooltip
 * porti i nomi delle regole e che si possa spegnere tutto senza lasciare segni.
 *
 * Perche' una sonda e non un test unitario: `paintScoreMarks` sceglie le teste
 * di nota con la GEOMETRIA (la perpendicolare della riga del cursore), e la
 * geometria esiste solo dove c'e' un font musicale caricato e un rigo disegnato.
 * Su node non c'e' nulla da misurare. Qui invece ogni numero che decide ("l'unica
 * testa a 40px dalla riga", "il tooltip dice due regole") lo legge il DOM vero.
 *
 * La sonda NON passa dal servizio: costruisce iniettando le colonne come le
 * produrrebbe `planMarks` (attacco + nomi) e chiama la funzione di pittura
 * direttamente, perche' cio' che va misurato e' il ponte attacco→nota, non la
 * rete. L'iniezione sostituisce il sorgente servito da vite con un accessorio
 * `window.__marks` in piu', niente altro (stesso trucco di _probe_osmd.mjs).
 *
 * Uso:  node alignment/_probe_marks.mjs      (vite dev su 5173)
 */
import { chromium } from 'file:///C:/Users/Power/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = 'http://localhost:5173';
const SCORE = path.join(HERE, '..', 'The Legend of Zelda_ Great Fairy Fountain (Piano Cover).musicxml');
const SHOT = path.join(HERE, '_probe_traces', 'marks-last.png');
const RED = '#a0442c';

const esiti = [];
function check(label, cond) {
  esiti.push([label, !!cond]);
  console.log((cond ? '  OK      ' : '  FALLITO ') + label);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// Espone OSMD e le due funzioni di pittura/cancellatura, sole cose che la sonda
// puo' chiamare senza far finta di essere l'effetto di React.
await page.route('**/src/pages/ScorePage.tsx*', async (route) => {
  const res = await route.fetch();
  let body = await res.text();
  if (!body.includes('window.__marks')) {
    body = body.replace(
      'osmdRef.current = osmd;',
      'osmdRef.current = osmd; window.__osmd = osmd;' +
      ' window.__marks = { paint: paintScoreMarks, clear: clearScoreMarks };',
    );
  }
  await route.fulfill({ response: res, body });
});

await page.goto(APP + '/upload', { waitUntil: 'domcontentloaded' });
await page.setInputFiles('input[type="file"]', SCORE);
await page.waitForSelector('button:has-text("Open Score")', { timeout: 20000 });
await page.click('button:has-text("Open Score")');
await page.waitForSelector('#sheet-container svg', { timeout: 90000 });
await page.waitForFunction(() => !!(window).__osmd && !!(window).__marks, null, { timeout: 90000 });
await page.waitForTimeout(1200);

/**
 * Undici punti sparsi per il primo giro del brano, piu' i nomi da dichiarare.
 * Gli attacchi sono gli INDICI ASSOLUTI dello spartito completo (128 nel primo
 * giro), come li manda il servizio tramite `chordId`.
 */
const COLS = [
  { measure: 1, beat: 0, attack: 0, rules: ['pitch-agreement'] },
  { measure: 2, beat: 1, attack: 3, rules: ['dynamics-adherence', 'chord-jitter'] },
  { measure: 3, beat: 0, attack: 8, rules: ['articulation'] },
  { measure: 5, beat: 1, attack: 17, rules: ['pitch-range'] },
  { measure: 10, beat: 0, attack: 36, rules: ['syncopated-pedal', 'pedal-toggle'] },
  { measure: 12, beat: 1, attack: 45, rules: ['dynamics-adherence'] },
  { measure: 15, beat: 0, attack: 60, rules: ['pitch-agreement'] },
  { measure: 19, beat: 0, attack: 72, rules: ['chord-jitter'] },
  { measure: 23, beat: 2, attack: 90, rules: ['articulation', 'pitch-range'] },
  { measure: 28, beat: 2, attack: 110, rules: ['syncopated-pedal'] },
  { measure: 32, beat: 3, attack: 127, rules: ['pitch-agreement', 'dynamics-adherence'] },
];

const esito = await page.evaluate(async ([cols, red]) => {
  const out = {};
  const osmd = window.__osmd;

  const statiPittura = [];
  const primaTeste = document.querySelectorAll('#sheet-container g.vf-notehead').length;

  const pittura = window.__marks.paint(osmd, cols);
  statiPittura.push(pittura.state);
  out.painted = pittura.painted;
  out.missed = pittura.missed;

  // quante teste sono diventate rosse, e con quali nomi sopra
  const rosse = [];
  const titoli = [];
  for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
    let rossa = false;
    for (const p of h.querySelectorAll('path')) {
      if ((p.getAttribute('fill') || '').toLowerCase() === red) { rossa = true; break; }
    }
    if (!rossa) continue;
    rosse.push(h);
    const t = h.querySelector('title');
    titoli.push(t ? t.textContent : null);
  }
  out.testeTotalePrima = primaTeste;
  out.testeRosse = rosse.length;
  out.rosseMenoDelleTotali = primaTeste > rosse.length && rosse.length >= cols.length;
  out.titoli = [...new Set(titoli.filter(Boolean))].sort();

  // il cursore deve essere tornato nascosto: fuori dalla pratica e dal playback
  // non deve indicare niente
  const imgVisibile = [...document.querySelectorAll('[id^="cursorImg-"]')]
    .some((el) => el.style.display !== 'none');
  out.cursoreNascostoDopo = !imgVisibile;

  // spegnere tutto: nessun rosso, nessun title, e il nero di prima e' tornato
  for (const s of statiPittura) window.__marks.clear(s);
  let restanoRosse = 0;
  for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
    for (const p of h.querySelectorAll('path')) {
      if ((p.getAttribute('fill') || '').toLowerCase() === red) { restanoRosse++; break; }
    }
  }
  out.restanoRosseDopoClear = restanoRosse;
  out.restanoTitoliDopoClear = document.querySelectorAll('#sheet-container g.vf-notehead title').length;
  const unaTesta = document.querySelector('#sheet-container g.vf-notehead path');
  out.neroTornato = !!unaTesta && (unaTesta.getAttribute('fill') || '').toLowerCase() !== red;

  // l'attacco che non esiste non deve accusare la nota piu' vicina che capita:
  // chi non arriva alla fermata dichiara il punto "non raggiunto", non colora
  const out2 = window.__marks.paint(osmd, [
    { measure: 99, beat: 0, attack: 999, rules: ['pitch-agreement'] },
  ]);
  out.fuoriAttaccoPainted = out2.painted;
  out.fuoriAttaccoMissed = out2.missed;
  window.__marks.clear(out2.state);

  return out;
}, [COLS, RED]);

// ------------------------------------------------------------------ verdetti
check('tutti gli 11 punti trovano una testa di nota (nessuno "non raggiunto")',
  esito.painted === COLS.length && esito.missed.length === 0);
check('i rossi sono molti meno delle teste disegnate (non ho colorato tutto)',
  esito.rosseMenoDelleTotali);
check('i punti con due regole portano UN tooltip con entrambi i nomi',
  esito.titoli.includes('dynamics-adherence, chord-jitter')
  && esito.titoli.includes('syncopated-pedal, pedal-toggle')
  && esito.titoli.includes('pitch-agreement, dynamics-adherence')
  && esito.titoli.includes('articulation, pitch-range'));
check('i tooltip non dicono n\'altro che i nomi delle regole',
  esito.titoli.length > 0 && esito.titoli.every((t) => /^[a-z-]+(, [a-z-]+)*$/.test(t)));
check('dopo clear non resta nessuna testa rossa', esito.restanoRosseDopoClear === 0);
check('dopo clear non resta nessun tooltip', esito.restanoTitoliDopoClear === 0);
check('il nero originale delle teste e\' tornato al suo posto', esito.neroTornato);
check('l\'attacco fuori dal brano non colora niente e si dichiara mancato',
  esito.fuoriAttaccoPainted === 0 && esito.fuoriAttaccoMissed.includes('pitch-agreement'));
check('la pennellata non lascia il cursore visibile', esito.cursoreNascostoDopo);

// una foto della coloratura, per guardarla con gli occhi oltre che coi numeri
await page.evaluate((cols) => {
  window.__ultimoStato = window.__marks.paint(window.__osmd, cols);
}, COLS);
await page.waitForTimeout(400);
await page.screenshot({ path: SHOT, fullPage: false });
console.log('  foto: ' + SHOT);

console.log('\n' + '='.repeat(58));
const falliti = esiti.filter(([, ok]) => !ok);
console.log(esiti.length - falliti.length + '/' + esiti.length + ' controlli passati');
await browser.close();
process.exit(falliti.length ? 1 : 0);
