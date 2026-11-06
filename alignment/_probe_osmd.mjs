/**
 * Prova la NUOVA implementazione del cursore contro il cursore VERO di OSMD.
 *
 * Il confronto per pitch e' morto, e questa sonda e' la ragione per cui lo e':
 * OSMD riporta le note 36 semitoni sotto il piano, uniformi su tutto il brano
 * (`<octave-shift type="down" size="8">` sul rigo di violino). Un "-36" scritto
 * nel codice sarebbe un bug travestito da costante e cambierebbe col prossimo
 * spartito.
 *
 * Quello che invece torna, misurato sulla sequenza completa, e':
 *
 *   la fermata k dell'iteratore e' il passo k del piano — 128 su 128 —
 *   e la battuta coincide — 128 su 128.
 *
 * Quindi il cursore si guida CONTANDO. Il pitch non si legge piu', e non c'e'
 * nessuna ottava da indovinare.
 *
 * Questa sonda esegue la funzione candidata esattamente come la chiamera'
 * ScorePage: prima il passo 0, poi 1, 2, ... fino a 127, senza mai resettare
 * (la pratica va solo avanti). Misura le tre cose che possono andare storte:
 * il cursore che sparisce, la battuta sbagliata, e il cursore che non si muove.
 *
 * Uso: node alignment/_probe_osmd.mjs
 */
import { chromium } from 'file:///C:/Users/Power/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs';
import path from 'node:path';

const ROOT = 'C:/Users/Power/Desktop/cadenza';
const SCORE = path.join(ROOT, 'The Legend of Zelda_ Great Fairy Fountain (Piano Cover).musicxml');
const APP = 'http://[::1]:5173';

const FAKE_MIDI = `
const input = {
  id: 'fake-keyboard', name: 'Probe Keyboard', manufacturer: 'Cadenza',
  type: 'input', state: 'connected', connection: 'open',
  onmidimessage: null, onstatechange: null,
  open: async () => input, close: async () => input,
  addEventListener: () => {}, removeEventListener: () => {},
};
navigator.requestMIDIAccess = async () => ({
  inputs: new Map([[input.id, input]]), outputs: new Map(),
  sysexEnabled: false, onstatechange: null,
});
`;

// La funzione candidata: una copia VERBATIM di quella che andra' in ScorePage.
// Il test deve misurare il codice che spedisce, non una sua descrizione.
const CANDIDATA = `
function moveCursorToStep(osmd, stepIndex, fromStep) {
  const cursor = osmd && osmd.cursors && osmd.cursors[0];
  if (!cursor) return -1;
  let pos = fromStep;
  try {
    if (pos < 0 || pos > stepIndex) {
      cursor.reset();
      pos = 0;
    }
    cursor.show();
    for (let guard = 0; pos < stepIndex && guard < 6000; guard++) {
      if (cursor.Iterator && cursor.Iterator.EndReached) break;
      cursor.next();
      pos++;
    }
    cursor.show();
    return pos;
  } catch (err) {
    try { cursor.hide(); } catch (e) { /* niente */ }
    return -1;
  }
}
`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(FAKE_MIDI);
const page = await context.newPage();

await page.route('**/src/pages/ScorePage.tsx*', async (route) => {
  const res = await route.fetch();
  let body = await res.text();
  if (!body.includes('window.__osmd = osmd')) {
    body = body.replace('osmdRef.current = osmd;', 'osmdRef.current = osmd; window.__osmd = osmd;');
  }
  await route.fulfill({ response: res, body });
});

await page.goto(`${APP}/upload`, { waitUntil: 'domcontentloaded' });
await page.setInputFiles('input[type="file"]', SCORE);
await page.waitForSelector('button:has-text("Open Score")', { timeout: 20000 });
await page.click('button:has-text("Open Score")');
await page.waitForSelector('#playback-bar', { timeout: 60000 });
await page.waitForFunction(() => !!(window).__osmd, null, { timeout: 60000 });
await page.waitForTimeout(1000);

const esito = await page.evaluate(async (sorgente) => {
  // `new Function(body)` costruisce la funzione dal testo: la dichiarazione va
  // eseguita e poi restituita, non preceduta da `return`.
  const moveCursorToStep = new Function(`${sorgente}; return moveCursorToStep;`)();

  const xml = await (await fetch('/scores/zelda-fairy-fountain.musicxml')).text();
  const piano = await (await fetch('http://127.0.0.1:8080/practice', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ score: xml }),
  })).json();

  const osmd = window.__osmd;
  const cursore = osmd.cursors[0];
  const img = document.querySelector('[id^="cursorImg-"]');

  // Si parte da fermo, come quando si entra in pratica.
  cursore.hide();

  let posizione = -1;
  const esiti = [];
  for (let k = 0; k < piano.steps.length; k++) {
    posizione = moveCursorToStep(osmd, k, posizione);
    const it = cursore.Iterator;
    esiti.push({
      k,
      posizione,
      attesa: piano.steps[k].measure,
      battuta: it?.CurrentMeasure?.MeasureNumber ?? null,
      visibile: img.style.display !== 'none',
      left: img.style.left,
      ricominciato: posizione === 0 && k > 0,
    });
  }

  // Un errore di battuta non e' per forza un errore di posizione: si guarda
  // anche quante volte il cursore e' rimasto immobile fra un passo e l'altro.
  let fermi = 0;
  for (let i = 1; i < esiti.length; i++) {
    if (esiti[i].left === esiti[i - 1].left) fermi++;
  }

  return {
    passi: piano.steps.length,
    visibili: esiti.filter((e) => e.visibile).length,
    battutagiusta: esiti.filter((e) => e.battuta === e.attesa).length,
    sbagliate: esiti.filter((e) => e.battuta !== e.attesa).slice(0, 5),
    ricominciati: esiti.filter((e) => e.ricominciato).length,
    fermi,
    primi: esiti.slice(0, 10).map((e) => `${e.k}:pos${e.posizione}/m${e.battuta}(att ${e.attesa}) ${e.left}`),
  };
}, CANDIDATA);

console.log('\npassi suonati: ' + esito.passi);
console.log('cursore visibile dopo OGNI passo: ' + esito.visibili + '/' + esito.passi);
console.log('battuta giusta:                   ' + esito.battutagiusta + '/' + esito.passi);
console.log('posizione tornata a 0 a meta?:    ' + esito.ricominciati);
console.log('passi col cursore immobile:       ' + esito.fermi);

if (esito.sbagliate.length) {
  console.log('\nbattute sbagliate:');
  for (const s of esito.sbagliate) {
    console.log(`   passo ${s.k}: fermo su battuta ${s.battuta}, attesa ${s.attesa}, pos=${s.posizione}`);
  }
}

console.log('\nprimi dieci passi:');
for (const p of esito.primi) console.log('   ' + p);

const ok = esito.visibili === esito.passi
  && esito.battutagiusta === esito.passi
  && esito.ricominciati === 0
  && esito.fermi <= 2;
console.log('\n' + '='.repeat(60));
console.log(ok ? 'NUOVA IMPLEMENTAZIONE VALIDA' : 'PROBLEMA');
console.log('='.repeat(60));

await browser.close();
process.exit(ok ? 0 : 1);
