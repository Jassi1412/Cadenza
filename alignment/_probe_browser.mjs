/**
 * Verifica in un browser VERO la modalita' practice: pannello, toggle della
 * dinamica, e cursore di OSMD.
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
  if (u.includes(':8080/')) richieste.push(u.replace('http://127.0.0.1:8080', ''));
});

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
  await page.waitForSelector('.practice-panel', { timeout: 90000 });
  const totale = await page.textContent('.practice-counter');
  check('il pannello della pratica appare', !!totale, (totale ?? '').trim().replace(/\s+/g, ' '));

  const chiavi = await page.$$eval('.practice-key', (els) =>
    els.map((e) => ({ testo: e.textContent.trim(), todo: e.classList.contains('practice-key-todo') })));
  check('le chiavi del primo passo sono elencate', chiavi.length > 0,
    chiavi.map((c) => `${c.testo}${c.todo ? '(da premere)' : ''}`).join(' '));

  const sospese = await page.$$eval('.practice-suspended li', (els) =>
    els.map((e) => e.querySelector('.practice-name')?.textContent?.trim()));
  check('le tre regole sospese sono dichiarate', sospese.length === 3, sospese.join(', '));

  // ── 3. si vede, il pannello, o sta sotto la piega? ─────────────
  console.log('\n3. Il pannello e\' visibile senza scorrere?');
  const lay = await page.evaluate(() => {
    const p = document.querySelector('.practice-panel');
    const sc = document.querySelector('.score-container');
    const bar = document.querySelector('#playback-bar');
    const rp = p.getBoundingClientRect();
    const rs = sc.getBoundingClientRect();
    const rb = bar.getBoundingClientRect();
    return {
      viewport: window.innerHeight,
      panelTop: Math.round(rp.top), panelBottom: Math.round(rp.bottom),
      panelH: Math.round(rp.height),
      sheetTop: Math.round(rs.top), sheetBottom: Math.round(rs.bottom),
      sheetH: Math.round(rs.height), sheetScrollTop: sc.scrollTop,
      sheetScrollH: sc.scrollHeight,
      barTop: Math.round(rb.top),
      scrollY: Math.round(window.scrollY),
      docH: document.documentElement.scrollHeight,
    };
  });
  console.log('     layout: ' + JSON.stringify(lay));
  const visibile = lay.panelTop < lay.viewport && lay.panelTop >= 0;
  check('il pannello coi tasti da premere e\' DENTRO lo schermo', visibile,
    visibile ? `top=${lay.panelTop}` : `top=${lay.panelTop} su viewport ${lay.viewport}`);
  const chiaviVisibili = await page.evaluate(() => {
    const k = document.querySelector('.practice-key');
    if (!k) return false;
    const r = k.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0;
  });
  check('la prima chiave del passo si vede senza scorrere', chiaviVisibili);

  // ── 4. il cursore, in pratica, dove sta? ────────────────────────
  const passo0 = await page.evaluate(CURSORE);
  check('il cursore e\' visibile sul primo passo', !!passo0 && passo0.vis,
    passo0 ? `left=${passo0.left} top=${passo0.top}` : 'nessun cursore');

  // ── 5. il toggle della dinamica ────────────────────────────────
  console.log('\n4. Il toggle della dinamica');
  const t = page.locator('#practice-dynamics-toggle');
  check('il toggle esiste', await t.count() === 1);
  check('parte acceso', await t.isChecked());
  const primaScritta = (await page.textContent('.practice-toggle-why')).trim();
  await t.click();
  const dopoScritta = (await page.textContent('.practice-toggle-why')).trim();
  check('cliccandolo si spegne', !(await t.isChecked()));
  check('la scritta sotto cambia', primaScritta !== dopoScritta, `"${dopoScritta.slice(0, 60)}…"`);
  await t.click();
  check('ricliccandolo si riaccende', await t.isChecked());

  // ── 6. suonare il primo passo ──────────────────────────────────
  console.log('\n5. Suono il primo passo');
  for (const p of [46, 93]) await page.evaluate((n) => window.__press(n), p);
  await page.waitForFunction(() => {
    const c = document.querySelector('.practice-counter');
    return c && /Passo 2/.test(c.textContent);
  }, null, { timeout: 15000 });
  const dopoPasso = (await page.textContent('.practice-counter')).trim().replace(/\s+/g, ' ');
  check('il cursore avanza al passo 2', /Passo 2/.test(dopoPasso), dopoPasso);

  const passo1 = await page.evaluate(CURSORE);
  check('l\'elemento cursore di OSMD si e\' SPOSTATO davvero',
    !!passo0 && !!passo1 && passo0.left !== passo1.left,
    `left ${passo0?.left} -> ${passo1?.left}`);

  // ── 7. i verdetti arrivano, e arrivano distinti ────────────────
  //
  // Il selettore esclude `.practice-suspended`: le regole sospese usano lo
  // stesso componente di lista, e includerle farebbe leggere "non si applica"
  // dove si sta cercando un verdetto. E' l'errore che ha reso rosso il primo
  // giro di questa sonda.
  const VERDETTI = '.practice-verdicts ul.practice-list:not(.practice-suspended) li';
  console.log('\n6. I verdetti del servizio');
  await page.waitForSelector(VERDETTI, { timeout: 30000 });
  const verdetti = await page.$$eval(VERDETTI, (els) =>
    els.map((e) => ({
      nome: e.querySelector('.practice-name')?.textContent?.trim(),
      esito: e.querySelector('.practice-detail')?.textContent?.trim(),
      cls: e.className,
    })));
  check('i verdetti delle quattro regole attive sono mostrati', verdetti.length === 4,
    verdetti.map((v) => `${v.nome}=${v.esito}`).join(', '));
  const sbagliati = verdetti.filter((v) => /practice-rule-error/.test(v.cls));
  check('nessuna regola e\' "non verificabile" (il monitor e\' partito)',
    sbagliati.length === 0, sbagliati.map((v) => v.nome).join(', ') || 'tutte giudicate');
  const conformi = verdetti.filter((v) => /practice-rule-ok/.test(v.cls));
  check('le regole dicono "conforme" (ho premuto le note giuste)',
    conformi.length === verdetti.length,
    verdetti.map((v) => v.esito).join(', '));

  // ── 8. il toggle nasconde la RIGA della dinamica, non il resto ─
  console.log('\n7. Il toggle spegne solo la riga della dinamica');
  await page.locator('#practice-dynamics-toggle').click();
  const dopoOff = await page.$$eval('.practice-verdicts ul.practice-list:not(.practice-suspended) li .practice-name',
    (els) => els.map((e) => e.textContent.trim()));
  check('con il toggle spento la riga dynamics-adherence sparisce',
    !dopoOff.includes('dynamics-adherence'), dopoOff.join(', '));
  check('le altre regole restano', dopoOff.length === 3, dopoOff.join(', '));
  await page.locator('#practice-dynamics-toggle').click();

  // ── 9. una nota sbagliata NON fa avanzare ─────────────────────
  console.log('\n8. Una nota sbagliata blocca il cursore');
  const fermoPrima = (await page.textContent('.practice-counter')).trim();
  await page.evaluate(() => window.__press(61));
  await page.waitForTimeout(1500);
  const fermoDopo = (await page.textContent('.practice-counter')).trim();
  check('il passo non avanza su una nota fuori dallo spartito', fermoPrima === fermoDopo,
    `${fermoPrima.replace(/\s+/g, ' ')} -> ${fermoDopo.replace(/\s+/g, ' ')}`);
  const mancanti = await page.$('.practice-hint');
  check('il pannello dice cosa manca', !!mancanti,
    mancanti ? (await mancanti.textContent()).trim().slice(0, 70) : '');

  // ── 10. uscire dalla pratica ──────────────────────────────────
  console.log('\n9. Esco dalla pratica');
  await page.screenshot({ path: path.join(SHOTS, 'practice.png'), fullPage: false });
  await page.click('#bar-step-btn');
  await page.waitForSelector('.practice-panel', { state: 'detached', timeout: 15000 });
  check('il pannello sparisce', await page.locator('.practice-panel').count() === 0);
  check('la barra torna in modalita normale',
    (await page.textContent('#bar-step-btn')).includes('Un passo'));
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
