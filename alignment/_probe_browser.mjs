/**
 * Verifica in un browser VERO la modalita' practice: la striscia dei comandi (contatore
 * dei passi, contatore dei tasti, verdetto compatto), il filtro per mano, il toggle
 * della dinamica, e il cursore di OSMD.
 *
 * Perche' serve, quando i test unitari sono gia' verdi. `test_cursor.py` prova
 * la NOSTRA funzione contro un finto cursore: non puo' accorgersi che OSMD
 * espone `Iterator` o `CurrentVoiceEntries` in un altro modo. Il contenimento
 * `mie ⊆ wanted`, corretto sui dati di `partitura`, dipende da come OSMD
 * raggruppa le note in voci. L'unico posto dove vederlo e' un browser con lo
 * spartito caricato.
 *
 * La tastiera non c'e': al suo posto si installa un `navigator.requestMIDIAccess`
 * finto che espone una porta MIDI e un metodo per "premere" un tasto. Tutto il
 * resto e' il codice di produzione — useMidi, usePractice, ScorePage, OSMD — che
 * non sa di essere osservato.
 *
 * Uso: node alignment/_probe_browser.mjs
 */
import { chromium } from 'file:///C:/Users/Power/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/Power/Desktop/cadenza';
const SCORE = path.join(ROOT, 'The Legend of Zelda_ Great Fairy Fountain (Piano Cover).musicxml');
const APP = 'http://[::1]:5173';
const SHOTS = path.join(ROOT, 'alignment', 'scratch', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const esiti = [];
function check(nome, ok, dettaglio = '') {
  esiti.push({ nome, ok });
  console.log(`  ${ok ? 'OK     ' : 'FALLITO'}  ${nome}${dettaglio ? '  — ' + dettaglio : ''}`);
}

// Il finto motore MIDI: una porta che consegna davvero messaggi a chiunque
// ascolti `onmidimessage`, come fa Chrome.
const FAKE_MIDI = `
window.__midi = (() => {
  const listeners = [];
  const input = {
    id: 'fake-keyboard', name: 'Probe Keyboard', manufacturer: 'Cadenza',
    type: 'input', state: 'connected', connection: 'open',
    onmidimessage: null, onstatechange: null,
    open: async () => input,
    close: async () => input,
    addEventListener: (_t, f) => listeners.push(f),
    removeEventListener: () => {},
  };
  const access = {
    inputs: new Map([[input.id, input]]),
    outputs: new Map(),
    sysexEnabled: false,
    onstatechange: null,
  };
  navigator.requestMIDIAccess = async () => access;
  // Un tasto premuto: nota + velocity, poi il rilascio. Come una tastiera vera.
  window.__press = (pitch, velocity = 80, holdMs = 120) => {
    const on = new Uint8Array([0x90, pitch, velocity]);
    const off = new Uint8Array([0x80, pitch, 0]);
    const emit = (data) => {
      const e = { data, timeStamp: performance.now(), type: 'midimessage' };
      if (input.onmidimessage) input.onmidimessage(e);
      for (const f of listeners) f(e);
    };
    emit(on);
    setTimeout(() => emit(off), holdMs);
    return pitch;
  };
  return { input };
})();
`;

/**
 * Dove sta il cursore di OSMD.
 *
 * Si leggono `style.left` / `style.top`, NON il rettangolo sullo schermo.
 * `Cursor.update()` (OSMD 1.9.7) scrive la posizione come stile inline
 * (`left: 10*(x-1.5)*zoom`), e quando `FollowCursor` e' attivo chiama anche
 * `scrollIntoView`: il rettangolo cambia perche' la pagina e' scorsa, non
 * perche' il cursore si e' spostato. Misurato col rettangolo, il confronto fra
 * due passi dava "fermo" mentre lo stile era diverso — un falso allarme.
 */
const CURSORE = `(() => {
  const el = document.querySelector('[id^="cursorImg-"]');
  if (!el) return null;
  return {
    vis: el.style.display !== 'none' && getComputedStyle(el).display !== 'none',
    left: el.style.left || '', top: el.style.top || '',
    w: el.style.width || '', h: el.style.height || '',
  };
})()`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(FAKE_MIDI);

const page = await context.newPage();
const log = [];
page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));

const richieste = [];
page.on('request', (r) => {
  const u = r.url();
  if (!u.includes(':8080/')) return;
  // Serve la mano dichiarata nel corpo: il filtro per mano e' un esercizio
  // diverso, e una richiesta che non porta la mano verrebbe giudicata su quello
  // sbagliato, in silenzio.
  const mano = (r.postData() ?? '').match(/"hand":"(right|left|both)"/);
  richieste.push(`${r.method()} ${u.replace('http://127.0.0.1:8080', '')}${mano ? ' ' + mano[0] : ''}`);
});

/** Le richieste di un tipo, per contare quelle nuove fra due momenti. */
const conta = (suffisso) => richieste.filter((r) => r.startsWith(suffisso)).length;

// ── 0. il permesso MIDI che nessuno concede ─────────────────────
//
// E' il caso peggiore della modalita': il browser apre la finestra di conferma
// e nessuno clicca "Consenti". Senza un avviso, il bottone passa a "Exit" e
// non succede NULLA: si crede che il pulsante sia rotto. Qui il permesso non
// viene mai concesso, e la pagina DEVE dire che cosa sta aspettando.
const paginaBloccata = await context.newPage();
await paginaBloccata.addInitScript(`
  navigator.requestMIDIAccess = () => new Promise(() => {});
`);
await paginaBloccata.goto(`${APP}/upload`, { waitUntil: 'domcontentloaded' });
await paginaBloccata.setInputFiles('input[type="file"]', SCORE);
await paginaBloccata.waitForSelector('button:has-text("Open Score")', { timeout: 20000 });
await paginaBloccata.click('button:has-text("Open Score")');
await paginaBloccata.waitForSelector('#playback-bar', { timeout: 60000 });
await paginaBloccata.waitForFunction(() => !!document.querySelector('#sheet-container svg'), null,
  { timeout: 60000 });
await paginaBloccata.click('#bar-step-btn');
try {
  await paginaBloccata.waitForSelector('.practice-notice', { timeout: 15000 });
  const avviso = (await paginaBloccata.textContent('.practice-notice')) ?? '';
  check('senza permesso MIDI l\'avviso dice cosa aspettava',
    /permesso/i.test(avviso), avviso.trim().replace(/\s+/g, ' ').slice(0, 90));
} catch {
  check('senza permesso MIDI l\'avviso dice cosa aspettava', false,
    'nessun avviso dopo 15 s: l\'attesa e\' muta');
}
await paginaBloccata.close();

try {
  // ── 1. caricamento dello spartito ────────────────────────────────
  console.log('\n1. Carico lo spartito');
  await page.goto(`${APP}/upload`, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[type="file"]', SCORE);
  await page.waitForSelector('button:has-text("Open Score")', { timeout: 20000 });
  await page.click('button:has-text("Open Score")');
  await page.waitForSelector('#playback-bar', { timeout: 60000 });
  await page.waitForFunction(() => !!document.querySelector('#sheet-container svg'), null,
    { timeout: 60000 });
  const svg = await page.$$eval('#sheet-container svg', (e) => e.length);
  check('lo spartito si disegna', svg > 0, `${svg} <svg>`);

  // Gli avvisi del font (SMuFL/Leipzig) arrivano dal convertitore Verovio e ci
  // sono GIA' prima della pratica: si annota che sono preesistenti, cosi' non
  // vengono attribuiti a questo lavoro.
  const fontPrima = log.filter((l) => /SMuFL|Leipzig/i.test(l)).length;
  check('gli avvisi di font sono preesistenti (non introdotti dalla pratica)', true,
    `${fontPrima} righe, prima di toccare la pratica`);

  const prima = await page.evaluate(CURSORE);
  check('OSMD ha gia\' disegnato il cursore', prima !== null,
    prima ? `left=${prima.left} top=${prima.top} visibile=${prima.vis}` : 'nessun elemento');

  // ── 2. entrare in pratica ───────────────────────────────────────
  console.log('\n2. Entro nella modalita practice');
  await page.click('#bar-step-btn');
  await page.waitForSelector('.practice-bar:not(.practice-notice)', { timeout: 90000 });

  // Il contatore dei passi e quello dei tasti sono le due righe della striscia:
  // niente nomi di note, niente elenco di verdetti. Se uno dei due manca, la barra
  // non sta dicendo niente di utile.
  const passoTxt = async () => ((await page.textContent('.pb-step')) ?? '')
    .trim().replace(/\s+/g, ' ');
  const tastiTxt = async () => ((await page.textContent('.pb-keys')) ?? '')
    .trim().replace(/\s+/g, ' ');

  const contatore = await passoTxt();
  check('la barra della pratica appare col contatore dei passi',
    /^\d+\/\d+$/.test(contatore), contatore);
  check('il riquadro grande non c\'e\' piu\'',
    await page.locator('.practice-panel').count() === 0);
  const tasti0 = await tastiTxt();
  check('dice quanti tasti mancano, senza nominare le note',
    /^\d+\/\d+ tasti/.test(tasti0), tasti0);

  // Le tre regole che qui non si applicano non stanno piu' in un <details>: stanno
  // nel titolo del contatore. Se sparissero del tutto, il silenzio della striscia si
  // leggerebbe "conforme", che e' la bugia questo progetto non vuole mai dire.
  const titolo = (await page.getAttribute('.pb-step', 'title')) ?? '';
  const sospese = ['articulation', 'pedal-toggle', 'syncopated-pedal']
    .filter((n) => titolo.includes(n));
  check('le regole che non si applicano restano dichiarate nel titolo',
    sospese.length === 3, `${sospese.length}/3 — ${titolo.replace(/\s+/g, ' ').slice(0, 80)}`);

  // ── 3. quanto spazio occupa, e dove sta? ─────────────────────────
  console.log('\n3. Quanto spazio occupa la striscia?');
  const lay = await page.evaluate(() => {
    const striscia = document.querySelector('.practice-bar');
    const pillola = document.querySelector('#playback-bar');
    const rs = striscia.getBoundingClientRect();
    const rp = pillola.getBoundingClientRect();
    return {
      vh: window.innerHeight, vw: window.innerWidth,
      h: Math.round(rs.height), top: Math.round(rs.top), bottom: Math.round(rs.bottom),
      pillTop: Math.round(rp.top),
      scrollY: Math.round(window.scrollY),
      docH: document.documentElement.scrollHeight,
    };
  });
  console.log('     layout: ' + JSON.stringify(lay));
  check('la striscia sta in una riga (meno di 70 px)',
    lay.h > 0 && lay.h < 70, `altezza ${lay.h} px`);
  check('sta sopra la pillola del trasporto, non sopra i comandi',
    lay.bottom <= lay.pillTop + 2, `bottom=${lay.bottom} pillola top=${lay.pillTop}`);
  check('non copre l\'inizio dello spartito: sta nel terzo basso dello schermo',
    lay.top > lay.vh * 0.6, `top=${lay.top} su viewport ${lay.vh}`);

  // ── 4. il cursore, in pratica, dove sta? ────────────────────────
  const passo0 = await page.evaluate(CURSORE);
  check('il cursore e\' visibile sul primo passo', !!passo0 && passo0.vis,
    passo0 ? `left=${passo0.left} top=${passo0.top}` : 'nessun cursore');

  // ── 5. il toggle della dinamica ────────────────────────────────
  console.log('\n4. Il toggle della dinamica');
  const dyn = page.locator('#bar-dyn-btn');
  check('il toggle della dinamica esiste', await dyn.count() === 1);
  check('parte acceso', (await dyn.getAttribute('aria-pressed')) === 'true');
  const dynPrima = (await dyn.getAttribute('title')) ?? '';
  const retiPrima = richieste.length;
  await dyn.click();
  check('cliccandolo si spegne', (await dyn.getAttribute('aria-pressed')) === 'false');
  const dynDopo = (await dyn.getAttribute('title')) ?? '';
  check('spento dice cosa non si guarda piu\'',
    /Spenta/.test(dynDopo) && dynPrima !== dynDopo, dynDopo.slice(0, 70));
  // Il contratto vero, misurato sulle richieste: la dinamica filtra la VISTA, non la
  // richiesta. Un click che costa un giro di rete renderebbe il giudizio del servizio
  // dipendente dall'interfaccia, e sarebbe la prima volta in questo progetto.
  await page.waitForTimeout(900);
  check('spegnere la dinamica non costa nessuna richiesta al servizio',
    richieste.length === retiPrima, `${richieste.length - retiPrima} richieste nuove`);
  await dyn.click();
  check('ricliccandolo si riaccende', (await dyn.getAttribute('aria-pressed')) === 'true');

  // ── 6. suonare il primo passo ──────────────────────────────────
  console.log('\n5. Suono il primo passo');
  const contatorePrima = await passoTxt();
  for (const p of [46, 93]) await page.evaluate((n) => window.__press(n), p);
  await page.waitForFunction(() => {
    const c = document.querySelector('.pb-step');
    return c && !/^1\//.test(c.textContent.trim());
  }, null, { timeout: 15000 });
  const contatoreDopo = await passoTxt();
  check('il cursore avanza al passo 2', contatoreDopo.startsWith('2/'),
    `${contatorePrima} -> ${contatoreDopo}`);

  const passo1 = await page.evaluate(CURSORE);
  check('l\'elemento cursore di OSMD si e\' SPOSTATO davvero',
    !!passo0 && !!passo1 && passo0.left !== passo1.left,
    `left ${passo0?.left} -> ${passo1?.left}`);

  // ── 7. il verdetto compatto al posto dell'elenco ───────────────
  // Una parola sola al posto di quattro righe. Il viola "non verificabile" e' il
  // monitor che non e' partito: qui non deve comparire, perche' il servizio gira.
  console.log('\n6. Il verdetto del servizio');
  await page.waitForFunction(() => {
    const p = document.querySelector('#practice-problem');
    return p && /conforme/.test(p.textContent);
  }, null, { timeout: 45000 });
  const chip = ((await page.textContent('#practice-problem')) ?? '').trim().replace(/\s+/g, ' ');
  const classiChip = (await page.getAttribute('#practice-problem', 'class')) ?? '';
  check('il verdetto arriva e dice "conforme"', /conforme/.test(chip), chip);
  check('il monitor e\' partito: nessun "non verificabile"',
    !/pb-broken/.test(classiChip), classiChip);

  // ── 8. la mano destra sola ─────────────────────────────────────
  console.log('\n7. Studio la mano destra sola');
  const dx = page.locator('#bar-hand-right');
  check('i tre pulsanti della mano ci sono',
    await page.locator('#bar-hand-all').count() === 1
    && dx.count() === 1
    && await page.locator('#bar-hand-left').count() === 1);
  check('sono attivi perche\' questo spartito ha due righi', !(await dx.isDisabled()));
  const pianiPrima = conta('POST /practice ');
  const passiPieno = (await passoTxt()).split('/')[1];
  await dx.click();
  await page.waitForFunction(() => {
    const s = document.querySelector('.pb-step');
    return !!s && !document.querySelector('.practice-notice');
  }, null, { timeout: 120000 });
  check('cambiare mano chiede un piano nuovo',
    conta('POST /practice ') === pianiPrima + 1,
    `${conta('POST /practice ') - pianiPrima} piani nuovi`);
  const chiaviDx = await tastiTxt();
  check('con la destra il primo passo chiede UN tasto, non due',
    /^0\/1 tasti/.test(chiaviDx), `${tasti0} -> ${chiaviDx}`);
  check('il pulsante della destra risulta attivo',
    ((await page.getAttribute('#bar-hand-right', 'class')) ?? '').includes('pb-chip-on'));

  // ── 9. mano sinistra: la nota esclusa si dichiara, non si giudica ──
  console.log('\n8. Mano sinistra: la nota dell\'altro rigo');
  await page.locator('#bar-hand-left').click();
  await page.waitForFunction(() => {
    const s = document.querySelector('.pb-step');
    return !!s && !document.querySelector('.practice-notice');
  }, null, { timeout: 120000 });
  const passiSx = await passoTxt();
  check('con la sinistra i passi sono meno che nel brano intero',
    Number(passiSx.split('/')[1]) < Number(passiPieno), `${passiPieno} -> ${passiSx}`);

  // Si preme SOLO la nota dell'altro rigo. Non deve far avanzare, non deve essere
  // letta come errore, e deve essere dichiarata: e' il caso che il servizio misura
  // in test_practice.py (casi 11-12); qui si guarda che lo spartito lo racconti.
  await page.evaluate(() => window.__press(93));
  await page.waitForFunction(() => !!document.querySelector('.pb-other'), null,
    { timeout: 8000 });
  const altraMano = ((await page.textContent('.pb-other')) ?? '').trim().replace(/\s+/g, ' ');
  check('la nota dell\'altro rigo si dichiara e non viene contata come errore',
    /ignorata/.test(altraMano), altraMano);
  const fermoSx = await passoTxt();
  const chipSx = ((await page.textContent('#practice-problem')) ?? '').trim();
  check('e non fa avanzare il passo', /^1\//.test(fermoSx), fermoSx);
  check('e non entra nel verdetto: nessun "nota sbagliata"',
    !/nota sbagliata/.test(chipSx), chipSx);

  // Ora la nota del rigo studiato: il passo si completa, e la richiesta di verdetto
  // deve portare la stessa mano su cui il piano e' stato costruito.
  const rispostaPasso = page.waitForResponse(
    (r) => r.url().includes('/practice/step'), { timeout: 25000 });
  await page.evaluate(() => window.__press(46));
  await rispostaPasso;
  check('la richiesta di verdetto dichiara la mano sinistra',
    richieste.some((r) => r.startsWith('POST /practice/step') && r.includes('"hand":"left"')),
    richieste.filter((r) => r.startsWith('POST /practice/step')).slice(-1)[0] ?? 'nessuna');
  await page.waitForFunction(() => {
    const c = document.querySelector('.pb-step');
    return c && !/^1\//.test(c.textContent.trim());
  }, null, { timeout: 15000 });
  check('la nota del rigo studiato fa avanzare',
    !(await passoTxt()).startsWith('1/'), await passoTxt());

  // ── 10. si torna al brano intero, e una nota sbagliata blocca ───
  console.log('\n9. Di nuovo tutte le mani, e una nota sbagliata blocca');
  await page.locator('#bar-hand-all').click();
  await page.waitForFunction(() => {
    const s = document.querySelector('.pb-step');
    return !!s && !document.querySelector('.practice-notice')
      && /^1\//.test(s.textContent.trim());
  }, null, { timeout: 120000 });
  const fermoPrima = await passoTxt();
  const chiaviFermo = await tastiTxt();
  await page.evaluate(() => window.__press(61));
  await page.waitForTimeout(1500);
  check('il passo non avanza su una nota fuori dallo spartito',
    (await passoTxt()) === fermoPrima, `${fermoPrima} -> ${await passoTxt()}`);
  check('e il contatore dei tasti resta spento, perche' + '\'' + ' il passo non e\' completo',
    !((await page.getAttribute('.pb-keys', 'class')) ?? '').includes('pb-keys-ok'), chiaviFermo);

  // ── 11. uscire dalla pratica ──────────────────────────────────
  console.log('\n10. Esco dalla pratica');
  await page.screenshot({ path: path.join(SHOTS, 'practice.png'), fullPage: false });
  await page.click('#bar-step-btn');
  await page.waitForSelector('.practice-bar', { state: 'detached', timeout: 15000 });
  check('la striscia sparisce', await page.locator('.practice-bar').count() === 0);
  check('la barra torna in modalita normale',
    (await page.textContent('#bar-step-btn')).includes('Practice'));
  check('il cursore si nasconde',
    await page.evaluate(CURSORE).then((c) => !c || !c.vis));

  console.log('\nrichieste al servizio: ' + richieste.join(' '));
  const eccezioni = log.filter((l) => l.startsWith('[pageerror]'));
  check('nessuna eccezione non gestita in pagina', eccezioni.length === 0,
    eccezioni.slice(0, 2).join(' | ') || 'nessuna');
  const nuovi = log.filter((l) => /SMuFL|Leipzig/i.test(l)).length - fontPrima;
  check('la pratica non aggiunge avvisi di font', nuovi === 0, `${nuovi} righe in piu'`);
  console.log('screenshot: ' + path.join(SHOTS, 'practice.png'));
} catch (err) {
  console.log('\nECCEZIONE: ' + err.message);
  await page.screenshot({ path: path.join(SHOTS, 'errore.png') }).catch(() => {});
  esiti.push({ nome: 'esecuzione completa', ok: false });
  console.log(log.slice(-12).join('\n'));
} finally {
  await browser.close();
}

const falliti = esiti.filter((e) => !e.ok);
console.log('\n' + '='.repeat(60));
console.log(`${esiti.length - falliti.length}/${esiti.length} controlli superati`);
console.log('='.repeat(60));
process.exit(falliti.length ? 1 : 0);
