/**
 * Verifica in un browser VERO la modalita' practice: la striscia dei comandi (il
 * pulsante che apre la tastiera, il verdetto compatto di una parola, i pulsanti L /
 * R e D), la tastiera di richiamo coi tasti del passo accesi, e il cursore di OSMD.
 *
 * Perche' serve, quando i test unitari sono gia' verdi. `test_cursor.py` prova
 * la NOSTRA funzione contro un finto cursore: non puo' accorgersi che OSMD
 * espone `Iterator` o `CurrentVoiceEntries` in un altro modo. Il contenimento
 * `mie ⊆ wanted`, corretto sui dati di `partitura`, dipende da come OSMD
 * raggruppa le note in voci. L'unico posto dove vederlo e' un browser con lo
 * spartito caricato.
 *
 * Della tastiera ce n'e' una sullo schermo (`.piano-kbd`, il richiamo dei tasti) e
 * una che non c'e': la tastiera MIDI vera. Al suo posto si installa un
 * `navigator.requestMIDIAccess` finto che espone una porta e un metodo per "premere"
 * un tasto. Tutto il resto e' il codice di produzione — useMidi, usePractice,
 * ScorePage, OSMD — che non sa di essere osservato.
 *
 * Cosa guarda, e perche' proprio quelle prove: i numeri che la riga mostrava
 * ("1/128", "0/2 tasti") non ci sono piu', quindi l'avanzamento dell'esercizio si
 * prova dai tasti accesi sulla tastiera e dalle richieste che partono, e il numero
 * di passi del brano — 128 pieno, 88 a mano sinistra, misurati in produzione — si
 * legge dalla risposta `/practice`, intercettata PRIMA del clic sul pulsante.
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
  // Il piano di risposta va intercettato PRIMA del clic: e' l'ultima cosa che dice
  // quanti passi ha il brano intero, numero che dalla riga e' stato tolto insieme al
  // contatore dei tasti. Le prove sui filtri per mano si reggono ancora su quello.
  const rispostaPiano = page.waitForResponse(
    (r) => r.url().includes('/practice') && !r.url().includes('/practice/step'),
    { timeout: 120000 });
  await page.click('#bar-step-btn');
  await page.waitForSelector('.practice-bar:not(.practice-notice)', { timeout: 90000 });
  const piano = await (await rispostaPiano).json();
  const totalePieno = (piano.steps ?? []).length;
  console.log(`     piano: ${totalePieno} passi, mani ${JSON.stringify(piano.hands)}`);

  // I tasti del passo si leggono dalla tastiera accesa, non piu' da un numero.
  const attesi = () => page.$$eval('.pk-expected',
    (ks) => ks.map((k) => Number(k.dataset.pitch)).sort((a, b) => a - b));
  const premuti = () => page.$$eval('.pk-down',
    (ks) => ks.map((k) => Number(k.dataset.pitch)).sort((a, b) => a - b));

  check('la tastiera di richiamo appare da sola, senza cliccare niente',
    await page.locator('.piano-kbd').count() === 1);
  check('il riquadro grande non c\'e\' piu\'',
    await page.locator('.practice-panel').count() === 0);
  check('dalla riga sono spariti sia il contatore dei passi sia quello dei tasti',
    await page.locator('.pb-step, .pb-keys, .pb-other').count() === 0);
  const attesi0 = await attesi();
  check('il primo passo chiede i tasti che dice il piano del servizio',
    attesi0.join(',') === ((piano.steps?.[0]?.pitch ?? []).slice().sort((a, b) => a - b).join(',')),
    `tastiera=[${attesi0}] piano=[${(piano.steps?.[0]?.pitch ?? []).join(',')}]`);
  check('e sono due tasti perche\' all\'inizio si studiano tutte e due le mani',
    attesi0.length === 2, JSON.stringify(attesi0));

  // Il do centrale marcato e i punti di riferimento scritti: senza quelli la tastiera
  // e' un disegno astratto, e chi suona deve poter capire DOVE sta il tasto acceso.
  const etichette = await page.$$eval('.pk-label', (es) => es.map((e) => e.textContent));
  check('il do centrale e\' marcato col suo nome', etichette.includes('C4'), etichette.join(' '));
  check('i punti di riferimento sono i do e i fa, non tutte le note', (() => {
    // Almeno tre ottave di appoggi (do+fa per ottava), e nessun nome in mezzo: a
    // scrivere ogni tasto il disegno smette di essere una mappa e diventa un elenco.
    const nomi = etichette.filter((n) => /^[A-F]\d$/.test(n ?? ''));
    return nomi.length >= 6 && !etichette.includes('D4') && !etichette.includes('G4');
  })(), `${etichette.length} etichette: ${etichette.join(' ')}`);

  // Le tre regole che qui non si applicano non stanno piu' in un <details>: stanno
  // nel titolo del pulsante tastiera. Se sparissero del tutto, il silenzio della
  // striscia si leggerebbe "correct", che e' la bugia questo progetto non vuole mai
  // dire — e ora la riga non ha nemmeno una parola, quindi il rischio e' piu' grande.
  const titolo = (await page.getAttribute('#bar-keys-btn', 'title')) ?? '';
  const sospese = ['articulation', 'pedal-toggle', 'syncopated-pedal']
    .filter((n) => titolo.includes(n));
  check('le regole che non si applicano restano dichiarate nel titolo',
    sospese.length === 3, `${sospese.length}/3 — ${titolo.replace(/\s+/g, ' ').slice(0, 80)}`);
  check('il titolo dice anche passo, battuta e tasti, che la riga non mostra piu\'',
    /Step \d+ of \d+/.test(titolo) && /bar \d+/.test(titolo) && /press /.test(titolo),
    titolo.replace(/\s+/g, ' ').slice(0, 90));

  // ── 3. quanto spazio occupa, e dove sta? ─────────────────────────
  console.log('\n3. Quanto spazio occupano striscia e tastiera?');
  const lay = await page.evaluate(() => {
    const striscia = document.querySelector('.practice-bar');
    const pillola = document.querySelector('#playback-bar');
    const kbd = document.querySelector('.piano-kbd');
    const rs = striscia.getBoundingClientRect();
    const rp = pillola.getBoundingClientRect();
    const rk = kbd ? kbd.getBoundingClientRect() : null;
    // L'alpha del fondo: le due barre erano semitrasparenti (0.85 + blur) e i
    // comandi si leggevano a meta'. Il colore calcolato restituisce rgba(...) con
    // l'alpha in quarta posizione: se c'e' 1 la superficie e' chiusa.
    const alpha = (el) => {
      const c = getComputedStyle(el).backgroundColor;
      const m = c.match(/rgba?\(([^)]*)\)/);
      if (!m) return -1;
      const parti = m[1].split(',').map((x) => parseFloat(x.trim()));
      return parti.length >= 4 ? parti[3] : 1;
    };
    return {
      vh: window.innerHeight, vw: window.innerWidth,
      h: Math.round(rs.height), top: Math.round(rs.top), bottom: Math.round(rs.bottom),
      pillTop: Math.round(rp.top),
      kbdH: rk ? Math.round(rk.height) : 0, kbdBottom: rk ? Math.round(rk.bottom) : 0,
      alphaStriscia: alpha(striscia), alphaPillola: alpha(pillola),
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
  check('la tastiera sta sopra la striscia, non sotto e non addosso',
    lay.kbdBottom > 0 && lay.kbdBottom <= lay.top + 2,
    `kbd bottom=${lay.kbdBottom} striscia top=${lay.top}`);
  // La richiesta dell'utente, misurata: il vetro rendeva i pulsanti illeggibili.
  check('il fondo della pillola del trasporto ora e\' solido (alpha 1)',
    lay.alphaPillola === 1, `alpha=${lay.alphaPillola}`);
  check('il fondo della striscia della pratica ora e\' solido (alpha 1)',
    lay.alphaStriscia === 1, `alpha=${lay.alphaStriscia}`);

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
    /Dynamics off/.test(dynDopo) && dynPrima !== dynDopo, dynDopo.slice(0, 70));
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
  for (const p of attesi0) await page.evaluate((n) => window.__press(n), p);
  await page.waitForFunction(() => document.querySelectorAll('.pk-down').length >= 2,
    null, { timeout: 15000 });
  check('i tasti chiesti diventano verdi nell\'istante in cui sono premuti',
    (await premuti()).join(',') === attesi0.join(','),
    `attesi=[${attesi0}] premuti=[${await premuti()}]`);
  // L'avanzamento non si legge piu' da "1/128": lo dicono i tasti accesi del passo
  // successivo, che devono essere diversi da quelli del passo appena finito.
  await page.waitForFunction((prev) => {
    const k = [...document.querySelectorAll('.pk-expected')]
      .map((e) => Number(e.dataset.pitch)).sort((a, b) => a - b).join(',');
    return !!k && k !== prev;
  }, attesi0.join(','), { timeout: 15000 });
  check('il passo e\' avanzato: la tastiera chiede altri tasti',
    (await attesi()).join(',') !== attesi0.join(','),
    `[${attesi0}] -> [${await attesi()}]`);

  const passo1 = await page.evaluate(CURSORE);
  check('l\'elemento cursore di OSMD si e\' SPOSTATO davvero',
    !!passo0 && !!passo1 && passo0.left !== passo1.left,
    `left ${passo0?.left} -> ${passo1?.left}`);

  // ── 7. il verdetto compatto al posto dell'elenco ───────────────
  // Una parola sola al posto di quattro righe. Il viola "cannot verify" e' il
  // monitor che non e' partito: qui non deve comparire, perche' il servizio gira.
  console.log('\n6. Il verdetto del servizio');
  await page.waitForFunction(() => {
    const p = document.querySelector('#practice-problem');
    return p && /correct/.test(p.textContent);
  }, null, { timeout: 45000 });
  const chip = ((await page.textContent('#practice-problem')) ?? '').trim().replace(/\s+/g, ' ');
  const classiChip = (await page.getAttribute('#practice-problem', 'class')) ?? '';
  check('il verdetto arriva e dice "correct"', /correct/.test(chip), chip);
  check('il monitor e\' partito: nessun "cannot verify"',
    !/pb-broken/.test(classiChip), classiChip);

  // ── 8. la mano destra sola ─────────────────────────────────────
  console.log('\n7. Studio la mano destra sola');
  const dx = page.locator('#bar-hand-right');
  const sx = page.locator('#bar-hand-left');
  check('i pulsanti della mano sono due icone e non tre scritte, e il terzo pulsante "Tutte" non c\'e\'',
    await page.locator('#bar-hand-all').count() === 0 && dx.count() === 1 && sx.count() === 1);
  check('sono attivi perche\' questo spartito ha due righi', !(await dx.isDisabled()));
  check('all\'inizio sono tutti e due accesi: si studiano tutte e due le mani',
    ((await dx.getAttribute('class')) ?? '').includes('pb-chip-on')
    && ((await sx.getAttribute('class')) ?? '').includes('pb-chip-on'));
  const pianiPrima = conta('POST /practice ');
  const rispostaDx = page.waitForResponse(
    (r) => r.url().includes('/practice') && !r.url().includes('/practice/step'),
    { timeout: 120000 });
  await dx.click();
  await page.waitForSelector('.practice-bar:not(.practice-notice)', { timeout: 120000 });
  const pianoDx = await (await rispostaDx).json();
  check('cambiare mano chiede un piano nuovo',
    conta('POST /practice ') === pianiPrima + 1,
    `${conta('POST /practice ') - pianiPrima} piani nuovi`);
  // Misurato in produzione sul brano di prova: con la destra il primo passo chiede UN
  // pitch perche' l'altro sta sull'altro rigo. Il NUMERO di passi invece resta quello
  // del brano intero (la destra ha un attacco ovunque), quindi la prova che distingue
  // un esercizio dall'altro sono i tasti chiesti, non quanti passi conta la riga —
  // e la riga non li conta nemmeno piu'.
  const chiestoDx = (pianoDx.steps?.[0]?.pitch ?? []).slice().sort((a, b) => a - b);
  check('il primo passo della destra chiede un solo tasto',
    chiestoDx.length === 1, JSON.stringify(pianoDx.steps?.[0]?.pitch));
  await page.waitForFunction(() => document.querySelectorAll('.pk-expected').length === 1,
    null, { timeout: 20000 });
  const attesiDx = await attesi();
  check('la tastiera accende il solo tasto chiesto dalla destra',
    attesiDx.join(',') === chiestoDx.join(','), `[${attesiDx}] contro [${chiestoDx}]`);
  const esclusoDx = (pianoDx.steps?.[0]?.offhand ?? [])[0];
  check('il tasto dell\'altro rigo resta nel disegno come contesto, non come errore',
    esclusoDx !== undefined
    && await page.locator(`.pk-offhand[data-pitch="${esclusoDx}"]`).count() === 1,
    `escluso=${esclusoDx}`);
  check('il pulsante scelto risulta acceso e l\'altro spento',
    ((await dx.getAttribute('class')) ?? '').includes('pb-chip-on')
    && !((await sx.getAttribute('class')) ?? '').includes('pb-chip-on'));

  // ── 9. mano sinistra: la nota esclusa si dichiara, non si giudica ──
  console.log('\n8. Mano sinistra: la nota dell\'altro rigo');
  const rispostaSx = page.waitForResponse(
    (r) => r.url().includes('/practice') && !r.url().includes('/practice/step'),
    { timeout: 120000 });
  await sx.click();
  await page.waitForSelector('.practice-bar:not(.practice-notice)', { timeout: 120000 });
  const pianoSx = await (await rispostaSx).json();
  const totaleSx = (pianoSx.steps ?? []).length;
  check('con la sinistra l\'esercizio ha meno passi del brano intero',
    totaleSx > 0 && totaleSx < totalePieno, `${totalePieno} -> ${totaleSx}`);
  const chiestoSx = (pianoSx.steps?.[0]?.pitch ?? []).slice().sort((a, b) => a - b);
  const esclusoSx = (pianoSx.steps?.[0]?.offhand ?? []).slice();
  // Si preme SOLO la nota dell'altro rigo. Non deve far avanzare, non deve essere
  // letta come errore, e deve essere dichiarata: e' il caso che il servizio misura
  // in test_practice.py (casi 11-12); qui si guarda che lo racconti la tastiera.
  for (const p of esclusoSx) await page.evaluate((n) => window.__press(n), p);
  await page.waitForTimeout(1500);
  const violaSx = await page.$$eval('.pk-offhand',
    (ks) => ks.map((k) => Number(k.dataset.pitch)));
  check('il tasto ignorato si vede spento-viola sulla tastiera, non rosso',
    violaSx.includes(esclusoSx[0]),
    `esclusi=[${esclusoSx}] rossi=${JSON.stringify(await page.$$eval('.pk-extra', (ks) => ks.map((k) => k.dataset.pitch)))}`);
  const titoloDopoEsclusa = (await page.getAttribute('#bar-keys-btn', 'title')) ?? '';
  check('e la striscia lo dichiara nel titolo, senza contarla come errore',
    /other staff/i.test(titoloDopoEsclusa), titoloDopoEsclusa.replace(/\s+/g, ' ').slice(0, 100));
  const chipSx = ((await page.textContent('#practice-problem')) ?? '').trim();
  check('e non entra nel verdetto: nessun "wrong note"',
    !/wrong note/.test(chipSx), chipSx);
  check('e l\'esercizio non e\' avanzato',
    (await attesi()).join(',') === chiestoSx.join(','),
    `[${await attesi()}] contro [${chiestoSx}]`);

  // Ora la nota del rigo studiato: il passo si completa, e la richiesta di verdetto
  // deve portare la stessa mano su cui il piano e' stato costruito.
  const rispostaPasso = page.waitForResponse(
    (r) => r.url().includes('/practice/step'), { timeout: 25000 });
  for (const p of chiestoSx) await page.evaluate((n) => window.__press(n), p);
  await rispostaPasso;
  check('la richiesta di verdetto dichiara la mano sinistra',
    richieste.some((r) => r.startsWith('POST /practice/step') && r.includes('"hand":"left"')),
    richieste.filter((r) => r.startsWith('POST /practice/step')).slice(-1)[0] ?? 'nessuna');
  await page.waitForFunction((prev) => {
    const k = [...document.querySelectorAll('.pk-expected')]
      .map((e) => Number(e.dataset.pitch)).sort((a, b) => a - b).join(',');
    return !!k && k !== prev;
  }, chiestoSx.join(','), { timeout: 15000 });
  check('la nota del rigo studiato fa avanzare',
    (await attesi()).join(',') !== chiestoSx.join(','), await attesi());

  // ── 10. si torna al brano intero, e una nota sbagliata blocca ───
  console.log('\n9. Di nuovo tutte le mani, e una nota sbagliata blocca');
  const rispostaTutte = page.waitForResponse(
    (r) => r.url().includes('/practice') && !r.url().includes('/practice/step'),
    { timeout: 120000 });
  // Premere il pulsante GIA' scelto è quello che riporta a tutte e due le mani: non
  // esiste piu' un terzo pulsante che lo dica al posto loro.
  await sx.click();
  await page.waitForSelector('.practice-bar:not(.practice-notice)', { timeout: 120000 });
  await rispostaTutte;
  check('il tocco sullo stesso rigo riporta a tutte e due le mani',
    ((await dx.getAttribute('class')) ?? '').includes('pb-chip-on')
    && ((await sx.getAttribute('class')) ?? '').includes('pb-chip-on'));
  await page.waitForFunction(() => document.querySelectorAll('.pk-expected').length === 2,
    null, { timeout: 20000 });
  const attesiTutte = await attesi();
  check('e la tastiera chiede di nuovo tutti e due i tasti',
    attesiTutte.length === 2, JSON.stringify(attesiTutte));

  const cursorePrima = await page.evaluate(CURSORE);
  await page.evaluate(() => window.__press(61));
  await page.waitForTimeout(1500);
  check('il tasto premuto fuori dallo spartito si accende di rosso',
    await page.locator('.pk-extra[data-pitch="61"]').count() === 1);
  check('ma il passo non avanza, e la tastiera chiede ancora gli stessi tasti',
    (await attesi()).join(',') === attesiTutte.join(','), `[${await attesi()}]`);
  const cursoreDopo = await page.evaluate(CURSORE);
  check('e il cursore non si e\' mosso', cursorePrima?.left === cursoreDopo?.left,
    `${cursorePrima?.left} -> ${cursoreDopo?.left}`);

  // ── 11. uscire dalla pratica ──────────────────────────────────
  console.log('\n10. Esco dalla pratica');
  await page.screenshot({ path: path.join(SHOTS, 'practice.png'), fullPage: false });
  await page.click('#bar-step-btn');
  await page.waitForSelector('.practice-bar', { state: 'detached', timeout: 15000 });
  check('la striscia sparisce', await page.locator('.practice-bar').count() === 0);
  check('e sparisce anche la tastiera di richiamo',
    await page.locator('.piano-kbd').count() === 0);
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
