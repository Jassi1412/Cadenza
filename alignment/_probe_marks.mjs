/**
 * LA SONDA DEI ROSSI: verifica in un browser vero (Chromium via CDP) che la
 * coloratura dei punti sbagliati trovi DAVVERO le note giuste, che il mouse su
 * una testa rossa tiri fuori la card con i nomi e le coppie premuto/scritto, e
 * che si possa spegnere tutto senza lasciare segni.
 *
 * Perche' una sonda e non un test unitario: `paintScoreMarks` sceglie le teste
 * di nota con la GEOMETRIA (la perpendicolare della riga del cursore), e la
 * geometria esiste solo dove c'e' un font musicale caricato e un rigo disegnato.
 * Su node non c'e' nulla da misurare. Qui ogni numero che decide ("l'unica testa
 * a 40px dalla riga", "la card dice due regole") lo legge il DOM vero, e il mouse
 * VERO (page.mouse.move) prova l'ascoltatore sulla finestra + la WeakMap: un jsdom
 * con i dispatch sintetici non dimostra che il puntatore reale trova la testa.
 *
 * Dal 2026-11-10 la pretesa sui tooltip e' ROVESCIATA: prima si assertiva CHE
 * il `<title>` ci fosse, ora si asserisce che NON c'e' piu' su nessuna testa
 * (richiesta esplicita: i rettolini nativi sono banditi), e la sostituzione -
 * ErrorHoverCard - viene provata muovendo il mouse sul DOM dipinto.
 *
 * La sonda NON passa dal servizio: costruisce iniettando le colonne come le
 * produrrebbe `planMarks` (attacco + MarkRule con i numeri, dove ci sono) e
 * chiama la funzione di pittura direttamente, perche' cio' che va misurato e'
 * il ponte attacco→nota e il mouse→card, non la rete. L'iniezione sostituisce
 * il sorgente servito da vite con un accessorio `window.__marks` in piu',
 * niente altro (stesso trucco di _probe_osmd.mjs).
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
 * Undici punti sparsi per il primo giro del brano. Gli attacchi sono gli INDICI
 * ASSOLUTI dello spartito completo (128 nel primo giro), come li manda il
 * servizio tramite `chordId`; le regole sono MarkRule come le produce planMarks,
 * con la coppia di numeri dove il servizio la porta (attacco 0: pitch 62 su
 * scritto 64; attacco 3: velocity 101 su scritto 84). Quei due attacchi sono
 * anche i due che la sezione hover va a pescare, da soli.
 */
const COLS = [
  { measure: 1, beat: 0, attack: 0, rules: [{ name: 'pitch-agreement', kind: 'pitch', played: 62, written: 64 }] },
  { measure: 2, beat: 1, attack: 3, rules: [
    { name: 'dynamics-adherence', kind: 'velocity', played: 101, written: 84 },
    { name: 'chord-jitter' },
  ] },
  { measure: 3, beat: 0, attack: 8, rules: [{ name: 'articulation' }] },
  { measure: 5, beat: 1, attack: 17, rules: [{ name: 'pitch-range' }] },
  { measure: 10, beat: 0, attack: 36, rules: [{ name: 'syncopated-pedal' }, { name: 'pedal-toggle' }] },
  { measure: 12, beat: 1, attack: 45, rules: [{ name: 'dynamics-adherence' }] },
  { measure: 15, beat: 0, attack: 60, rules: [{ name: 'pitch-agreement' }] },
  { measure: 19, beat: 0, attack: 72, rules: [{ name: 'chord-jitter' }] },
  { measure: 23, beat: 2, attack: 90, rules: [{ name: 'articulation' }, { name: 'pitch-range' }] },
  { measure: 28, beat: 2, attack: 110, rules: [{ name: 'syncopated-pedal' }] },
  { measure: 32, beat: 3, attack: 127, rules: [{ name: 'pitch-agreement' }, { name: 'dynamics-adherence' }] },
];

const esito = await page.evaluate(async ([cols, red, verde]) => {
  const out = {};
  const osmd = window.__osmd;

  const statiPittura = [];
  const primaTeste = document.querySelectorAll('#sheet-container g.vf-notehead').length;

  const pittura = window.__marks.paint(osmd, cols);
  statiPittura.push(pittura.state);
  out.painted = pittura.painted;
  out.missed = pittura.missed;

  // quante teste sono diventate rosse — e soprattutto: NESSUNA deve avere il
  // `<title>`, il rettangolo nativo che l'utente ha bandito nel 2026-11-10
  let rosse = 0;
  for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
    let rossa = false;
    for (const p of h.querySelectorAll('path')) {
      if ((p.getAttribute('fill') || '').toLowerCase() === red) { rossa = true; break; }
    }
    if (rossa) rosse++;
  }
  out.testeTotalePrima = primaTeste;
  out.testeRosse = rosse;
  out.rosseMenoDelleTotali = primaTeste > rosse && rosse >= cols.length;
  out.titoliNativi = document.querySelectorAll('#sheet-container g.vf-notehead title').length;

  // il cursore deve essere tornato nascosto: fuori dalla pratica e dal playback
  // non deve indicare niente
  const imgVisibile = [...document.querySelectorAll('[id^="cursorImg-"]')]
    .some((el) => el.style.display !== 'none');
  out.cursoreNascostoDopo = !imgVisibile;

  // spegnere tutto: nessun rosso, e il nero di prima e' tornato
  for (const s of statiPittura) window.__marks.clear(s);
  let restanoRosse = 0;
  for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
    for (const p of h.querySelectorAll('path')) {
      if ((p.getAttribute('fill') || '').toLowerCase() === red) { restanoRosse++; break; }
    }
  }
  out.restanoRosseDopoClear = restanoRosse;
  const unaTesta = document.querySelector('#sheet-container g.vf-notehead path');
  out.neroTornato = !!unaTesta && (unaTesta.getAttribute('fill') || '').toLowerCase() !== red;

  // l'attacco che non esiste non deve accusare la nota piu' vicina che capita:
  // chi non arriva alla fermata dichiara il punto "non raggiunto", non colora
  const out2 = window.__marks.paint(osmd, [
    { measure: 99, beat: 0, attack: 999, rules: [{ name: 'pitch-agreement' }] },
  ]);
  out.fuoriAttaccoPainted = out2.painted;
  out.fuoriAttaccoMissed = out2.missed;
  window.__marks.clear(out2.state);

  // il VERDE chiesto il 2026-11-10 ("le note premute correttamente fossero
  // colorate di verde"): un attacco pulito dichiarato dal servizio si tinge
  // del verde del tema e la mappa delle punte hover non lo vede mai — qui il
  // numero e il restore, la prova col mouse vero arriva piu' avanti.
  const out3 = window.__marks.paint(osmd, [], [
    { measure: 12, beat: 0, attack: 40 },
    { measure: 20, beat: 1, attack: 75 },
  ]);
  out.verdiPainted = out3.painted;
  out.verdiMissed = out3.missed.length;
  // la stessa pennellata puo' vedere rosso e verde sullo stesso attacco, e
  // li' il rosso vince: con queste COLS pero' i due verdi restano entrambi,
  // e questo e' il numero vero della passata.
  let testeVerdi = 0;
  for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
    for (const p of h.querySelectorAll('path')) {
      if ((p.getAttribute('fill') || '').toLowerCase() === verde) { testeVerdi++; break; }
    }
  }
  out.testeVerdi = testeVerdi;
  window.__marks.clear(out3.state);
  let restanoVerdi = 0;
  for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
    for (const p of h.querySelectorAll('path')) {
      if ((p.getAttribute('fill') || '').toLowerCase() === verde) { restanoVerdi++; break; }
    }
  }
  out.restanoVerdiDopoClear = restanoVerdi;

  return out;
}, [COLS, RED, '#2e7d32']);

// ------------------------------------------------------------------ verdetti
check('tutti gli 11 punti trovano una testa di nota (nessuno "non raggiunto")',
  esito.painted === COLS.length && esito.missed.length === 0);
check('i rossi sono molti meno delle teste disegnate (non ho colorato tutto)',
  esito.rosseMenoDelleTotali);
check('nessuna testa dipinta si porta dietro il <title> nativo',
  esito.titoliNativi === 0);
check('dopo clear non resta nessuna testa rossa', esito.restanoRosseDopoClear === 0);
check('il nero originale delle teste e\' tornato al suo posto', esito.neroTornato);
check('l\'attacco fuori dal brano non colora niente e si dichiara mancato',
  esito.fuoriAttaccoPainted === 0 && esito.fuoriAttaccoMissed.includes('pitch-agreement'));
check('la pennellata non lascia il cursore visibile', esito.cursoreNascostoDopo);
check('i due attacchi puliti trovano la loro testa, nessuno si dichiara mancato',
  esito.verdiPainted === 2 && esito.verdiMissed === 0);
check('le teste verdi sono almeno due, del verde del tema — ogni fermata pulita tinge tutto l\'accordo',
  esito.testeVerdi >= 2);
check('dopo clear non resta nessuna testa verde, il restore vale anche per il verde',
  esito.restanoVerdiDopoClear === 0);

// --------------------------------------------------------------------- l'hover
// La card la si prova col mouse VERO, perche' e' li' che il ponte window-listener
// → WeakMap → ErrorHoverCard si rompe se qualcosa non torna. Un punto alla volta,
// cosi' si sa cosa deve dire la card: le due regole dell'attacco 3 con la coppia
// delle velocita', poi la coppia del pitch all'attacco 0.

async function centroPrimaTestaRossa() {
  return page.evaluate(() => {
    for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
      for (const p of h.querySelectorAll('path')) {
        if ((p.getAttribute('fill') || '').toLowerCase() === '#a0442c') {
          const r = h.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    return null;
  });
}

// Lo stato di pennellata VIENE APPOGGIATO in pagina: MarkState contiene elementi
// SVG veri, e gli argomenti di page.evaluate vengono serializzati — passare uno
// stato da fuori avrebbe consegnato al clear involucri vuoti. Pila in pagina,
// l'ultima pennellata si spegne per prima: unico ordine che non lascia rossi orfani.
async function dipingiUnPunto(col) {
  await page.evaluate((c) => {
    const res = window.__marks.paint(window.__osmd, [c]);
    // in pila lo STATO di pennellata, non l'involucro {state,painted,missed}:
    // clearScoreMarks vuole le path salvate, e clear(involucro) sarebbe muto
    (window.__sonda = window.__sonda || []).push(res.state);
  }, col);
}
async function spegniUltimo() {
  await page.evaluate(() => {
    const st = window.__sonda.pop();
    if (st) window.__marks.clear(st);
  });
}

// stato A: due regole sullo stesso punto, una con la coppia velocity
await dipingiUnPunto(COLS[1]);
const centroA = await centroPrimaTestaRossa();
check('il punto con due regole trova comunque UNA sola testa su cui mostrare la card',
  centroA !== null);
await page.mouse.move(5, 5);
await page.mouse.move(centroA.x, centroA.y);
const cardA = await page.waitForSelector('.ehc-card', { timeout: 3000 }).catch(() => null);
check('il mouse sopra una nota rossa fa comparire la card al volo, senza rettangoli nativi',
  cardA !== null);
const testoA = cardA ? await cardA.textContent() : '';
check('la card dice ENTRAMBE le regole di quel punto in due righe separate',
  testoA.includes('dynamics-adherence') && testoA.includes('chord-jitter'));
check('la riga della dinamica porta la coppia premuto/scritto, formattata una sola volta',
  testoA.includes('you 101 · score 84'));
check('la card sa dove sei: misura e battitura in testa',
  testoA.includes('measure 2'));

// stato B: la coppia del pitch, col nome del tasto — formattata da noteName, non
// dalle due estremita' che inventano ciascuna il proprio
await spegniUltimo();
await page.mouse.move(5, 5);
await page.waitForTimeout(250);
await dipingiUnPunto(COLS[0]);
const centroB = await centroPrimaTestaRossa();
await page.mouse.move(centroB.x, centroB.y);
const cardB = await page.waitForSelector('.ehc-card', { timeout: 3000 }).catch(() => null);
const testoB = cardB ? await cardB.textContent() : '';
check('il pitch premuto e scritto escono coi NOMI dei tasti, non coi numeri nudi',
  testoB.includes('you D4 · score E4') && !testoB.includes('you 62'));
// la testa cancellata deve SMENTIRE l'hover: clear toglie la testa dalla mappa,
// e un puntatore che torna non deve piu' vedere nulla (WeakMap + delete esplicito)
await spegniUltimo();
await page.mouse.move(5, 5);
await page.waitForTimeout(200);
await page.mouse.move(centroB.x, centroB.y);
await page.waitForTimeout(400);
check('una testa cancellata smette di rispondere all\'hover: la mappa si pulisce col rosso',
  await page.locator('.ehc-card').count() === 0);
// stato V: il VERDE non apre nessun libro. Il verde dice "hai fatto la cosa
// giusta" e una card che spiega un successo sarebbe un insegnante che ripete
// "bravo bravo" a ogni tasto premuto (richiesta 2026-11-10, forma negativa: la
// card sta sugli errori). Il mouse vero qui conferma che la mappa markTips non
// ha mai visto quella testa: nessun listener da spegnere, semplicemente non c'e'.
await page.evaluate((g) => {
  const res = window.__marks.paint(window.__osmd, [], [g]);
  (window.__sonda = window.__sonda || []).push(res.state);
}, { measure: 12, beat: 0, attack: 40 });
const centroVerde = await page.evaluate(() => {
  for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
    for (const p of h.querySelectorAll('path')) {
      if ((p.getAttribute('fill') || '').toLowerCase() === '#2e7d32') {
        const r = h.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
  }
  return null;
});
check('la nota verde si trova sullo schermo dove la pittura dice di averla messa',
  centroVerde !== null);
if (centroVerde) {
  await page.mouse.move(centroVerde.x, centroVerde.y);
  await page.waitForTimeout(450);
}
check('sopra una nota verde non si apre nessuna card: il verde non spiega niente',
  centroVerde !== null && (await page.locator('.ehc-card').count()) === 0);
await spegniUltimo();
// come tra ogni stato di pennellata di questa sonda: il mouse va portato via
// prima di dipingere il giro dopo, perche' un puntatore gia' sopra una testa
// non innesca nessun pointerover quando quella testa cambia colore.
await page.mouse.move(5, 5);
await page.waitForTimeout(250);
// e allontanando il mouse da una card aperta, la card deve andarsene subito
await dipingiUnPunto(COLS[1]);
const centroC = await centroPrimaTestaRossa();
await page.mouse.move(centroC.x, centroC.y);
check('anche sul secondo punto la card si apre',
  (await page.waitForSelector('.ehc-card', { timeout: 3000 }).catch(() => null)) !== null);
await page.mouse.move(600, 8);
await page.waitForTimeout(300);
check('il mouse che se ne va chiude la card: nessuna coda di rettangoli immaginari',
  await page.locator('.ehc-card').count() === 0);
await spegniUltimo();

// una foto della coloratura, per guardarla con gli occhi oltre che coi numeri.
// Il verde sta nella foto insieme ai rossi: la richiesta del 2026-11-10 vuole
// entrambi i colori sulla stessa partitura, e l'occhio vuole vedere la prova.
await page.evaluate(({ cols, verdi }) => {
  window.__ultimoStato = window.__marks.paint(window.__osmd, cols, verdi);
}, { cols: COLS, verdi: [{ measure: 12, beat: 0, attack: 40 }] });
// la foto deve mostrare quello che pretende: la finestra viene portata sulla
// testa VERDE (attacco 40), dove i rossi vicini del piano — attacchi 36 e 45
// dello stesso COLS — fanno da cornice. Uno screenshot senza il colore che
// documenta non è la prova di niente: l'occhio vuole vedere verde E rosso
// nella stessa image, fianco a fianco, come li vedrà l'allievo alla fine di
// una presa sporca ma non totale.
await page.waitForTimeout(400);
await page.evaluate(() => {
  for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
    let verde = false;
    for (const p of h.querySelectorAll('path')) {
      if ((p.getAttribute('fill') || '').toLowerCase() === '#2e7d32') { verde = true; break; }
    }
    if (verde) {
      h.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true;
    }
  }
  return false;
});
await page.waitForTimeout(500);
await page.screenshot({ path: SHOT, fullPage: false });
console.log('  foto: ' + SHOT);

console.log('\n' + '='.repeat(58));
const falliti = esiti.filter(([, ok]) => !ok);
console.log(esiti.length - falliti.length + '/' + esiti.length + ' controlli passati');
await browser.close();
process.exit(falliti.length ? 1 : 0);
