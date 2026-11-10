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
 * Dal 2026-11-10 il probe chiude anche una presa Play along VERA (sezione 1b),
 * che prima non aveva mai toccato: note finte dalla porta finta, e misura dal
 * vivo il TEMPO fra la prima volta che la barra di avanzamento tocca la cima e
 * la richiesta al monitor — la garanzia che l'utente ha chiesto ("una volta
 * concluso lo spartito... mandare subito l'esecuzione al monitor", niente
 * secondo giro). Testimone nudo: il Resource Timing della POST, cronometrato
 * nella stessa timeline dei campioni.
 *
 * Dottrina operativa pagata in falsi allarmi (2026-11-10): MENTRE questo probe
 * gira, NON si tocca nessun file sotto web-app/ — nemmeno un .md: Vite trata i
 * file fuori dal grafo come Reload della pagina, e un reload di mezzo brucia lo
 * stato di React e fa cadere le sezioni successive con attese che scadono. Le
 * modifiche ai sorgenti si fanno PRIMA di lanciarlo (Vite ha già ricompilato)
 * o DOPO che ha scritto il suo JSON.
 *
 * Uso: node alignment/_probe_browser.mjs
 *      PROBE_API=http://127.0.0.1:8139 → dove origliare le richieste (deve
 *      essere la STESSA origine a cui parla la pagina, vedi pages/AGENTS.md).
 *      SKIP_TAKE=1 → salta l'intera sezione 1b della presa. È lo strumento
 *      della bisettrice usata il 2026-11-10 (fallivano le sezioni dopo la
 *      presa: colpa del take o del codice?), non una modalità normale: di
 *      default la presa si fa, è l'unica prova del "chiude al primo giro".
 */
import { chromium } from 'file:///C:/Users/Power/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/Power/Desktop/cadenza';
const SCORE = path.join(ROOT, 'The Legend of Zelda_ Great Fairy Fountain (Piano Cover).musicxml');
const APP = 'http://[::1]:5173';
// La pagina chiama il servizio all'indirizzo che trova in VITE_CADENZA_API (default
// la porta 8080 di .env.local), e il filtro che conta le richieste deve guardare la
// STESSA origine: su questa macchina la 8080 può essere occupata da un'altra app,
// quindi l'origine si prende dall'ambiente PROBE_API, con lo stesso default di prima.
const API = process.env.PROBE_API || 'http://127.0.0.1:8080';
const API_PORT = new URL(API).port;
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
  if (!u.includes(':' + API_PORT + '/')) return;
  // Serve la mano dichiarata nel corpo: il filtro per mano e' un esercizio
  // diverso, e una richiesta che non porta la mano verrebbe giudicata su quello
  // sbagliato, in silenzio.
  const mano = (r.postData() ?? '').match(/"hand":"(right|left|both)"/);
  richieste.push(`${r.method()} ${u.replace(API, '')}${mano ? ' ' + mano[0] : ''}`);
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
    // L'avviso ora è in inglese (passata "tutto in inglese", 2026-11-04): si ancora
    // alla promessa stabile — la pagina deve dire CHE COSA sta aspettando.
    /allow the midi|prompt may already/i.test(avviso), avviso.trim().replace(/\s+/g, ' ').slice(0, 90));
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

  // ── 1b. il Play along: la fine deve essere LA prima volta ──────────
  // Strumento diagnostico temporaneo (2026-11-10): con SKIP_TAKE=1 l'intera
  // sezione viene saltata, per rispondere alla bisettrice — se le sezioni dopo
  // falliscono anche senza la presa, il difetto e' nel codice spedito; se
  // passono tutte, disturba la sezione stessa. NON e' dottrina: di default la
  // presa si fa, perche' e' l'unica prova che il take chiude al primo giro.
  if (!process.env.SKIP_TAKE) {
  // Lagnanza dell'utente (2026-11-10, verbatim): "una volta concluso lo
  // spartito riparte da capo invece di mandare subito l'esecuzione al
  // monitor... l'ho testato con spartiti che non hanno un loop". La presa
  // non era MAI stata provata dal probe — le sezioni successive stanno tutte
  // dentro la pratica. Qui si chiude quel buco: si avvia un Play along vero,
  // con note finte che arrivano dalla porta MIDI finta (l'app non sa di essere
  // osservata: useMidi registra e useVerdict parte da solo), e si misura il
  // TEMPO fra la prima volta che la barra di avanzamento tocca la cima e la
  // richiesta al monitor. La barra è il testimone giusto: `setProgress((pos/
  // dur)*100)` scrive lo stesso numero che endSignal legge, un fotogramma
  // prima della regola, senza toccare niente dentro React. E se il brano
  // ripartiva davvero (il bug), fra cima e richiesta ci starebbe un secondo
  // giro intero del brano, non tre secondi.
  const presaPrima = richieste.filter((r) => r === 'POST /').length;
  await page.evaluate(`(() => {
    window.__ttrace = { campioni: [], richiesta: null };
    const cerca = () => performance.getEntriesByType('resource').find((e) =>
      e.initiatorType === 'fetch' && e.name.includes(':${API_PORT}') && !e.name.includes('/practice'));
    const traccia = () => {
      const fill = document.querySelector('.bar-progress-fill');
      window.__ttrace.campioni.push([performance.now(), fill ? parseFloat(fill.style.width) || 0 : 0]);
      const r = cerca();
      if (r) { window.__ttrace.richiesta = r.startTime; return; }
      requestAnimationFrame(traccia);
    };
    requestAnimationFrame(traccia);
  })()`);
  await page.click('#bar-practice-btn');
  // Note finte a palate durante la presa: non serve che siano la melodia,
  // serve che il recording non sia vuoto e che il verdetto arrivi giudicato.
  const piovasco = await page.evaluate(() => {
    window.__piovasco = setInterval(() => {
      const p = 40 + Math.floor(Math.random() * 48);
      window.__press(p, 70 + Math.floor(Math.random() * 40), 200);
    }, 1500);
    return true;
  });
  let presaChiusa = false;
  const orologioPresa = Date.now();
  while (Date.now() - orologioPresa < 130000) {
    await page.waitForTimeout(1000);
    if (richieste.filter((r) => r === 'POST /').length > presaPrima) { presaChiusa = true; break; }
  }
  check('il Play along chiede il verdetto quando lo spartito finisce', presaChiusa,
    presaChiusa ? '' : `${Math.round((Date.now() - orologioPresa) / 1000)} s in attesa, nessuna POST /`);
  await page.evaluate(() => clearInterval(window.__piovasco));
  // La POST vive già nel registro richieste del browser, ma la voce di
  // Resource Timing compare solo quando la risposta arriva (~170 ms locali).
  // Analizzare prima di quel momento legge "ricerca non registrata" ed è la
  // race che ha fatto fallire questi due controlli il 2026-11-10 alla loro
  // primissima esecuzione, pur con la presa chiusa correttamente.
  await page.waitForFunction(() => window.__ttrace && window.__ttrace.richiesta != null,
    null, { timeout: 20000 }).catch(() => {});
  const analisiPresa = await page.evaluate(() => {
    const tr = window.__ttrace;
    if (!tr || tr.richiesta == null) return null;
    const c = tr.campioni;
    let iTop = -1;
    for (let i = 0; i < c.length; i++) { if (c[i][1] >= 97) { iTop = i; break; } }
    if (iTop < 0) return { campioni: c.length, cima: null };
    let minimo = 100;
    for (let i = iTop; i < c.length && c[i][0] <= tr.richiesta; i++) {
      if (c[i][1] < minimo) minimo = c[i][1];
    }
    return { campioni: c.length, cima: c[iTop][0], ritardo: tr.richiesta - c[iTop][0], minimoDaCima: minimo };
  });
  check('la fine è colta al primo arrivo: il monitor viene chiamato entro 3 s dalla cima',
    analisiPresa != null && analisiPresa.cima != null &&
    analisiPresa.ritardo <= 3000 && analisiPresa.ritardo > -2000,
    analisiPresa == null ? 'traccia mancante o richiesta non registrata'
      : analisiPresa.cima == null ? 'nessun campione ≥ 97% prima della richiesta'
      : `ritardo ${Math.round(analisiPresa.ritardo)} ms su ${analisiPresa.campioni} campioni`);
  check('dopo la cima non c’è nessun secondo giro: la barra non ridiscende',
    analisiPresa != null && analisiPresa.cima != null && analisiPresa.minimoDaCima >= 85,
    analisiPresa == null ? '' : `minimo dopo la cima: ${Math.round(analisiPresa.minimoDaCima)}%`);
  await page.waitForSelector('.pc-card', { timeout: 15000 }).catch(() => {});
  const cartaBox = await page.locator('.pc-card').first().boundingBox().catch(() => null);
  check('la carta del voto sta al centro della finestra, non la si deve cercare',
    cartaBox != null &&
    Math.abs(cartaBox.x + cartaBox.width / 2 - 720) <= 108 &&
    Math.abs(cartaBox.y + cartaBox.height / 2 - 450) <= 135,
    cartaBox ? `box ${Math.round(cartaBox.x)},${Math.round(cartaBox.y)} ${Math.round(cartaBox.width)}x${Math.round(cartaBox.height)}` : 'nessuna .pc-card');
  await page.screenshot({ path: path.join(SHOTS, 'presa-voto.png'), fullPage: false });
  await page.click('.pc-card button:has-text("Close")');
  await page.waitForSelector('.pc-card', { state: 'detached', timeout: 8000 }).catch(() => {});
  check('il "Close" toglie la carta centrata dal mezzo dello schermo',
    await page.locator('.pc-card').count() === 0);
  // L'altra metà della richiesta del 2026-11-10, parola per parola: "quando si
  // clicca close si deve poter vedere lo spartito finché non si ricomincia da
  // capo, azione fatta dall'utente". Close NON è un ripulisci-tutto: i colori
  // restano dove sono, e il mouse deve ancora poterli interrogare. La presa
  // tempesta della sonda lascia sempre rossi (le note mai premute sono decine),
  // quindi qui il conteggio sotto zero sarebbe un guaio vero, non un caso limite.
  const rossiDopoClose = await page.evaluate(() => {
    let n = 0;
    for (const h of document.querySelectorAll('#sheet-container g.vf-notehead')) {
      for (const p of h.querySelectorAll('path')) {
        if ((p.getAttribute('fill') || '').toLowerCase() === '#a0442c') { n++; break; }
      }
    }
    return n;
  });
  check('dopo Close i rossi restano sulla partitura, pronti da hoverare',
    rossiDopoClose > 0, `${rossiDopoClose} teste ancora rosse dopo la chiusura`);
  } // ── fine sezione 1b (saltabile con SKIP_TAKE=1) ────────────────────

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

  // LA TASTIERA MOSTRA TUTTI E 88 I TASTI (richiesta esplicita dell'utente). Questa
  // prova esiste perche' la prima versione disegnava una finestra calcolata sui passi
  // e aveva i nomi delle variabili scambiati: l'altezza della finestra veniva chiusa
  // sul pitch piu' BASSO del brano, quindi sul brano di prova compariva un'ottava sola
  // e il secondo tasto del passo -- l'A5 -- non era nemmeno disegnato. tsc non lo
  // diceva (i conti erano legibili); lo dice solo un conteggio dei tasti.
  const bianchi = await page.$$eval('.pk-white', (ks) => ks.length);
  const neri = await page.$$eval('.pk-black', (ks) => ks.length);
  check('la tastiera e\' quella intera: 52 bianchi + 36 neri = 88 tasti',
    bianchi === 52 && neri === 36, `bianchi=${bianchi} neri=${neri}`);
  // Gli estremi si misurano su TUTTI i tasti disegnati, non su un finto
  // ":first-child/:last-child" dei bianchi: i neri vengono renderizzati dopo, quindi
  // l'ultimo figlio della riga e' nero e quel selettore non avrebbe preso nulla.
  const tastierini = await page.$$eval('.pk-key',
    (ks) => ks.map((k) => Number(k.dataset.pitch)));
  check('e va da A0 a C8, gli stessi due estremi citati dalle specifiche RML',
    Math.min(...tastierini) === 21 && Math.max(...tastierini) === 108,
    `min=${Math.min(...tastierini)} max=${Math.max(...tastierini)} tasti=${tastierini.length}`);
  // Nessun pitch chiesto o dichiarato fuori dal disegno: e' la regressione esatta del
  // bug della finestra, e va misurata sui dati del piano, non su numeri inventati.
  const daDisegnare = [...new Set([
    ...(piano.steps?.[0]?.pitch ?? []), ...(piano.steps?.[0]?.offhand ?? [])])];
  const mancanti = daDisegnare.filter((p) => !tastierini.includes(p));
  check('ogni tasto che il primo passo chiede o dichiara e\' realmente disegnato',
    mancanti.length === 0, `mancano [${mancanti}] su [${daDisegnare}]`);
  // Un diesis acceso senza nome e' una figurina scura, e per saperlo bisognerebbe
  // contare i semitoni dal do vicino: il nome va scritto sul tasto nero quando quel
  // tasto e' in gioco. Sul brano di prova il passo chiede 46, che e' un nero, quindi
  // la prova ha un caso vero su cui girare e non e' scritta a vuoto.
  const NOMI_NERI = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const nomeNota = (p) => NOMI_NERI[p % 12] + (Math.floor(p / 12) - 1);
  const tagNeri = await page.$$eval('.pk-black.pk-expected .pk-tag',
    (ts) => ts.map((t) => t.textContent));
  const neriChiesti = (piano.steps?.[0]?.pitch ?? []).filter((p) => [1, 3, 6, 8, 10].includes(p % 12));
  check('il tasto nero chiesto porta scritto il suo nome, col nome giusto',
    neriChiesti.every((p) => tagNeri.includes(nomeNota(p))),
    `neri chiesti=[${neriChiesti.map(nomeNota)}] tag=[${tagNeri}]`);

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

   // Niente più rettangolini nativi su nessuno dei quattro comandi: richiesta
  // esplicita del 2026-11-10 ("compaiono di nuovo i rettangolini css sull'hover
  // che descrivono cosa sono, non li voglio, eliminali"). Le informazioni che
  // stavano lì ora vivono SOLO dove si guardano: i tasti d'oro sulla tastiera
  // disegnata dicono cosa premere, il viola dell'altro rigo dice cosa è escluso.
  // Quel che resta da garantire è l'accessibilità senza rettangolo: il nome del
  // pulsante deve stare nell'aria-label, che lo screen reader lo legge e il
  // mouse no. Se un title ricomparisse, la verifica urla.
  const titoliComandi = await page.evaluate(() =>
    ['#bar-keys-btn', '#bar-hand-left', '#bar-hand-right', '#bar-dyn-btn']
      .map((s) => document.querySelector(s)?.hasAttribute('title') ?? null));
  check('nessun comando della striscia porta il tooltip nativo',
    titoliComandi.every((t) => t === false), JSON.stringify(titoliComandi));
  const nomiAccessibili = await page.evaluate(() =>
    ['#bar-keys-btn', '#bar-hand-left', '#bar-hand-right', '#bar-dyn-btn']
      .map((s) => (document.querySelector(s)?.getAttribute('aria-label') ?? '').trim()));
  check('i comandi restano pronunciabili per lo screen reader: etichetta su tutti',
    nomiAccessibili.every((n) => n.length > 0), JSON.stringify(nomiAccessibili));

  // ── 3. quanto spazio occupa, e dove sta? ─────────────────────────
  console.log('\n3. Quanto spazio occupano striscia e tastiera?');
  const lay = await page.evaluate(async () => {
    // Misurare solo quando le due superfici fisse hanno SMESSO di muoversi:
    // striscia e tastiera entrano con un'animazione CSS, e leggere un fotogramma
    // in movimento produce sovrapposizioni false — la misura bottom=812 del run
    // 2026-11-10 era una striscia in discesa, da ferma e' ~786 su pillola 796.
    await new Promise((resolve) => {
      let firmaPrecedente = '', fotogrammiUguali = 0;
      const t0 = performance.now();
      const conta = () => {
        if (!document.querySelector('.practice-bar') || performance.now() - t0 > 8000) { resolve(); return; }
        const s = document.querySelector('.practice-bar').getBoundingClientRect().bottom;
        const k = document.querySelector('.piano-kbd');
        const firma = Math.round(s) + '|' + (k ? Math.round(k.getBoundingClientRect().bottom) : 'x');
        if (firma === firmaPrecedente) { if (++fotogrammiUguali >= 6) { resolve(); return; } }
        else { fotogrammiUguali = 0; firmaPrecedente = firma; }
        requestAnimationFrame(conta);
      };
      requestAnimationFrame(conta);
    });
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
  const retiPrima = richieste.length;
  await dyn.click();
  check('cliccandolo si spegne', (await dyn.getAttribute('aria-pressed')) === 'false');
  // Il title non deve tornare a riempirsi di frasi a ogni stato: i rettolini
  // nativi sono eliminati per richiesta (2026-11-10), anche sul chip D.
  check('spento non si riporta dietro il rettangolo nativo',
    (await dyn.getAttribute('title')) === null);
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
  // Pressione SIMULTANEA in un solo evaluate: due `page.evaluate` separati
  // superano i 120 ms di rilascio su una macchina carica, il primo tasto si
  // spegne prima che arrivi il secondo (misurato il 2026-11-06 con RAM libera
  // a 0,2 GB). Ma IL MOMENTO DEL VERDE puo' comunque non esistere come render:
  // se pressione e avanzamento finiscono nello stesso commit, dall'esterno la
  // classe `.pk-down` non si vede MAI, anche se tutto ha funzionato (misurato
  // il 2026-11-07: moriva qui il waitForFunction da 15 s). L'osservatore sta
  // DENTRO la pagina, dove il mutamento accade, e registra il vertice; se il
  // momento viene compresso in un solo render, la prova che la pressione e'
  // registrata diventa l'avanzamento del passo, che e' la stessa causa.
  const momentoPressione = await page.evaluate(async (ps) => {
    const prima = [...document.querySelectorAll('.pk-expected')]
      .map((e) => e.dataset.pitch).sort((a, b) => a - b).join(',');
    let vertice = 0, verdiDiVertice = [];
    const kbd = document.querySelector('.piano-kbd');
    const obs = new MutationObserver(() => {
      const giu = document.querySelectorAll('.pk-down');
      if (giu.length > vertice) {
        vertice = giu.length;
        verdiDiVertice = [...giu].map((k) => Number(k.dataset.pitch)).sort((a, b) => a - b);
      }
    });
    if (kbd) obs.observe(kbd, { subtree: true, attributes: true, childList: true });
    for (const n of ps) window.__press(n, 80, 600);
    const fine = Date.now() + 4000;
    let cambiato = false;
    while (Date.now() < fine && !(cambiato =
      [...document.querySelectorAll('.pk-expected')]
        .map((e) => e.dataset.pitch).sort((a, b) => a - b).join(',') !== prima)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    obs.disconnect();
    return { vertice, verdiDiVertice: verdiDiVertice.join(','), cambiato };
  }, attesi0);
  check('la pressione dei tasti chiesti viene registrata: verdi accesi insieme o passo gia\' avanzato',
    momentoPressione.vertice >= 2 || momentoPressione.cambiato,
    JSON.stringify(momentoPressione));
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
  // Il timeout qui NON deve più uccidere la corsa: nel 2026-11-10 lo stesso
  // schianto silenzioso ha bruciato tre run prima di far vedere una sola prova.
  // Se la parola non arriva, si fotografa la scena (com'è fatto #practice-problem,
  // cosa dice la riga, gli errori della pagina) e si prosegue con la check marcata
  // fallita: le sezioni dopo valgono comunque, e il JSON degli esiti le racconterà.
  const parolaPronta = await page.waitForFunction(() => {
    const p = document.querySelector('#practice-problem');
    return p && /correct/.test(p.textContent);
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  if (!parolaPronta) {
    const scena = await page.evaluate(() => ({
      span: document.querySelector('#practice-problem')?.outerHTML.slice(0, 260) ?? null,
      riga: document.querySelector('.practice-bar')?.innerText.replace(/\s+/g, ' ') ?? null,
      striscia: !!document.querySelector('.practice-bar'),
    })).catch((e) => ({ evaluateFallito: String(e).slice(0, 120) }));
    console.log('     scena verdetto: ' + JSON.stringify(scena));
    const erroriVividi = log.filter((l) => l.startsWith('[pageerror]') || l.includes('[Error]')).slice(-4);
    if (erroriVividi.length) console.log('     errori pagina: ' + erroriVividi.join(' ||| '));
  }
  const chip = ((await page.textContent('#practice-problem')) ?? '').trim().replace(/\s+/g, ' ');
  const classiChip = (await page.getAttribute('#practice-problem', 'class')) ?? '';
  check('il verdetto arriva e dice "correct"', /correct/.test(chip), chip);
  check('il monitor e\' partito: nessun "cannot verify"',
    !/pb-broken/.test(classiChip), classiChip);

  // ── 8. spegnere la sinistra lascia la destra sola ──────────────
  console.log('\n7. Studio la mano destra sola');
  const dx = page.locator('#bar-hand-right');
  const sx = page.locator('#bar-hand-left');
  // Tre confronti veri, tutti attesi: `locator.count()` senza await restituiva un
  // PROMESSA, e una promessa è sempre truthy — `Promise === 1` era falso ma la
  // `&&` finiva sull'oggetto e il check passava comunque, vuoto. (scoperto il
  // 2026-11-07: i due conteggi non hanno mai davvero verificato nulla.)
  const nTutte = await page.locator('#bar-hand-all').count();
  const nDx = await dx.count();
  const nSx = await sx.count();
  check('i pulsanti della mano sono due icone e non tre scritte, e il terzo pulsante "Tutte" non c\'e\'',
    nTutte === 0 && nDx === 1 && nSx === 1, `tutte=${nTutte} dx=${nDx} sx=${nSx}`);
  check('gli interruttori non sono mai disabilitati: si toccano sempre',
    !(await dx.isDisabled()) && !(await sx.isDisabled()));
  check('all\'inizio sono tutti e due accesi: si studiano tutte e due le mani',
    ((await dx.getAttribute('class')) ?? '').includes('pb-chip-on')
    && ((await sx.getAttribute('class')) ?? '').includes('pb-chip-on'));

  // Anche il RIGO sullo spartito segue gli interruttori (richiesta del giorno,
  // letta fino in fondo: "quando L o R sono spenti il pentagramma rispettivo
  // diventi grigio come il tasto"). OSMD racchiude le misure di ogni rigo in
  // `g.staffline` con id che finisce -1 (sopra, destra) o -2 (sotto, sinistra).
  // Si legge il filtro CALCOLATO, non la classe: una classe presente ma senza
  // effetto visivo sarebbe un rigo "spento" che alla prova non regge lo sguardo.
  // E si legge DOPO aver lasciato finire i 250 ms di dissolvenza che il CSS mette
  // fra acceso e spento (transizione su `filter`): a metà transizione il valore
  // calcolato è un intermedio, non "nessuno", e una lettura fatta subito dopo il
  // clic raccontava "ancora grigio" mentre il rigo stava TORNANDO a colore — tre
  // falsi allarmi sulla stessa riga di codice (misurato il 2026-11-07: 75/78).
  const statoRighi = async () => {
    await page.waitForTimeout(400);   // la dissolvenza dev'essere finita, si legge lo stato stabile
    return page.evaluate(() => {
      const lato = (suffisso) => {
        const gs = [...document.querySelectorAll(`#sheet-container g.staffline[id$="${suffisso}"]`)];
        return { n: gs.length, grigi: gs.filter((g) => getComputedStyle(g).filter !== 'none').length };
      };
      return { sopra: lato('-1'), sotto: lato('-2') };
    });
  };
  const viviPrima = await statoRighi();
  check('a mani tutte e due accese i righi sono tutti a colore, e ce ne sono due',
    viviPrima.sopra.n > 0 && viviPrima.sopra.grigi === 0
    && viviPrima.sotto.n > 0 && viviPrima.sotto.grigi === 0,
    JSON.stringify(viviPrima));

  const pianiPrima = conta('POST /practice ');
  const rispostaDx = page.waitForResponse(
    (r) => r.url().includes('/practice') && !r.url().includes('/practice/step'),
    { timeout: 120000 });
  // Dal 2026-11-07 le lettere sono DUE INTERRUTTORI: qui si SPEGNE la sinistra,
  // e l'effetto cercato e' l'esercizio a mano destra. Non esiste piu' il tocco
  // che "sceglie una mano": ogni lettera accende o spegne solo la propria.
  await sx.click();
  await page.waitForSelector('.practice-bar:not(.practice-notice)', { timeout: 120000 });
  const pianoDx = await (await rispostaDx).json();
  check('spegnere una mano chiede un piano nuovo',
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
  check('spegnere una lettera cambia SOLO quella: la destra resta accesa',
    ((await dx.getAttribute('class')) ?? '').includes('pb-chip-on')
    && ((await sx.getAttribute('class')) ?? '').includes('pb-chip-off'));
  // Lo "spento" deve vedersi, non leggersi: la lettera grigia e' un colore
  // diverso da quella accesa, e questa e' l'unica prova che l'utente guarda la
  // striscia a colpo d'occhio mentre suona.
  const coloriMani = await page.evaluate(() => {
    const colore = (id) => getComputedStyle(document.getElementById(id)).color;
    return { spenta: colore('bar-hand-left'), accesa: colore('bar-hand-right') };
  });
  check('la lettera spenta e\' disegnata grigia, diversa da quella accesa',
    coloriMani.spenta !== coloriMani.accesa, JSON.stringify(coloriMani));

  // E insieme alla lettera si spegne il suo rigo: L era la sinistra, quindi
  // grigia il sotto — tutto, chiavi comprese, perche' OSMD racchiude l'intero
  // rigo in UN gruppo e la pagina lo spegne intero. Il sopra resta vivo: li'
  // c'e' l'esercizio che si sta suonando.
  const righiConLa = await statoRighi();
  check('con L spenta anche il suo rigo (sotto) e\' grigio, il sopra no',
    righiConLa.sopra.grigi === 0 && righiConLa.sotto.n > 0
    && righiConLa.sotto.grigi === righiConLa.sotto.n,
    JSON.stringify(righiConLa));

  // ── 9. mano sinistra: la nota esclusa si dichiara, non si giudica ──
  console.log('\n8. Mano sinistra: la nota dell\'altro rigo');
  // Riaccendere la lettera spenta deve ridare il brano intero: le due lettere
  // accese SONO "tutte e due le mani", nessun terzo pulsante lo dice piu'.
  const rispostaRiavvio = page.waitForResponse(
    (r) => r.url().includes('/practice') && !r.url().includes('/practice/step'),
    { timeout: 120000 });
  await sx.click();
  await page.waitForSelector('.practice-bar:not(.practice-notice)', { timeout: 120000 });
  await rispostaRiavvio;
  check('riaccendere la lettera spenta riporta al brano intero, chiedendo un piano nuovo',
    conta('POST /practice ') === pianiPrima + 2
    && ((await dx.getAttribute('class')) ?? '').includes('pb-chip-on')
    && ((await sx.getAttribute('class')) ?? '').includes('pb-chip-on'),
    `${conta('POST /practice ') - pianiPrima} piani da inizio sezione`);
  const righiRiaccesi = await statoRighi();
  check('e riaccendendo la lettera anche il rigo grigio torna a colore',
    righiRiaccesi.sopra.grigi === 0 && righiRiaccesi.sotto.grigi === 0,
    JSON.stringify(righiRiaccesi));
  // E ora si spegne la DESTRA per studiare la sola sinistra: l'interruttore
  // indipendente fa l'esatto contrario del vecchio tocco "scegli mano".
  const rispostaSx = page.waitForResponse(
    (r) => r.url().includes('/practice') && !r.url().includes('/practice/step'),
    { timeout: 120000 });
  await dx.click();
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
  await page.evaluate((ps) => { for (const n of ps) window.__press(n, 80, 600); }, esclusoSx);
  await page.waitForTimeout(1500);
  const violaSx = await page.$$eval('.pk-offhand',
    (ks) => ks.map((k) => Number(k.dataset.pitch)));
  check('il tasto ignorato si vede spento-viola sulla tastiera, non rosso',
    violaSx.includes(esclusoSx[0]),
    `esclusi=[${esclusoSx}] rossi=${JSON.stringify(await page.$$eval('.pk-extra', (ks) => ks.map((k) => k.dataset.pitch)))}`);
  const probTitolo = await page.evaluate(() =>
    document.querySelector('#practice-problem')?.hasAttribute('title') ?? false);
  check('e la striscia non lo ri-spiega col rettangolo nativo: viola basta, e non è un errore',
    probTitolo === false);
  // La parolina del verdetto NON c'è quando non c'è niente da dire (pressione
  // dell'escluso: nessun tasto studiato premuto, il servizio risponde `verdicts: {}`
  // e la riga resta senza parole). L'elemento quindi puo' non esserci DEL TUTTO:
  // questa lettura ne tollera l'assenza, perche' "nessuna parola" e' esattamente
  // il verdetto onesto che questo progetto pretende sul silenzio.
  const chipSx = await page.locator('#practice-problem')
    .textContent({ timeout: 5000 }).catch(() => '');
  check('e non entra nel verdetto: nessun "wrong note"',
    !/wrong note/.test(chipSx), chipSx);
  check('e l\'esercizio non e\' avanzato',
    (await attesi()).join(',') === chiestoSx.join(','),
    `[${await attesi()}] contro [${chiestoSx}]`);

  // Simmetrico: adesso tocca alla lettera DESTRA essere spenta, e il grigio
  // deve essere passato al rigo di sopra lasciando in colore quello che si suona.
  const righiSenzaLa = await statoRighi();
  check('con R spenta anche il suo rigo (sopra) e\' grigio, il sotto no',
    righiSenzaLa.sotto.grigi === 0 && righiSenzaLa.sopra.n > 0
    && righiSenzaLa.sopra.grigi === righiSenzaLa.sopra.n,
    JSON.stringify(righiSenzaLa));

  // Ora la nota del rigo studiato: il passo si completa. Su questa macchina la
  // pressione puo' essere INGOBBATA intera (note-on e note-off processati nello
  // stesso batch: lo stesso starved documented elsewhere per .pk-down), e cosa
  // fa uno studente vero? la ripreme. Anche la sonda la ripreme, con una tenuta
  // piu' lunga, prima di dichiarare il fallimento.
  const attesiCambia = (prev) => page.waitForFunction((p) => {
    const k = [...document.querySelectorAll('.pk-expected')]
      .map((e) => Number(e.dataset.pitch)).sort((a, b) => a - b).join(',');
    return !!k && k !== p;
  }, prev, { timeout: 12000 }).then(() => true).catch(() => false);
  await page.evaluate((ps) => { for (const n of ps) window.__press(n, 80, 600); }, chiestoSx);
  let avanzo = await attesiCambia(chiestoSx.join(','));
  if (!avanzo) {
    console.log('     (prima pressione inghiottita dalla macchina: riprovo come farebbe uno studente)');
    await page.evaluate((ps) => { for (const n of ps) window.__press(n, 80, 1600); }, chiestoSx);
    avanzo = await attesiCambia(chiestoSx.join(','));
  }
  check('la richiesta di verdetto dichiara la mano sinistra',
    richieste.some((r) => r.startsWith('POST /practice/step') && r.includes('"hand":"left"')),
    richieste.filter((r) => r.startsWith('POST /practice/step')).slice(-1)[0] ?? 'nessuna');
  check('la nota del rigo studiato fa avanzare', avanzo, await attesi());

  // ── 10. si torna al brano intero, e una nota sbagliata blocca ───
  console.log('\n9. Di nuovo tutte le mani, e una nota sbagliata blocca');
  const rispostaTutte = page.waitForResponse(
    (r) => r.url().includes('/practice') && !r.url().includes('/practice/step'),
    { timeout: 120000 });
  // Riaccendere la destra spenta: con tutte e due le lettere accese l'esercizio
  // e' di nuovo il brano intero. E' un click sull'interruttore giusto, non un
  // "torna indietro" — l'altra lettera non era rimasta premuta per caso.
  await dx.click();
  await page.waitForSelector('.practice-bar:not(.practice-notice)', { timeout: 120000 });
  await rispostaTutte;
  check('riaccendere anche l\'ultima lettera spenta riporta a tutte e due le mani',
    ((await dx.getAttribute('class')) ?? '').includes('pb-chip-on')
    && ((await sx.getAttribute('class')) ?? '').includes('pb-chip-on'));
  await page.waitForFunction(() => document.querySelectorAll('.pk-expected').length === 2,
    null, { timeout: 20000 });
  const attesiTutte = await attesi();
  check('e la tastiera chiede di nuovo tutti e due i tasti',
    attesiTutte.length === 2, JSON.stringify(attesiTutte));

  const cursorePrima = await page.evaluate(CURSORE);
  await page.evaluate(() => window.__press(61, 80, 900));
  await page.waitForTimeout(1500);
  check('il tasto premuto fuori dallo spartito si accende di rosso',
    await page.locator('.pk-extra[data-pitch="61"]').count() === 1);
  check('ma il passo non avanza, e la tastiera chiede ancora gli stessi tasti',
    (await attesi()).join(',') === attesiTutte.join(','), `[${await attesi()}]`);
  const cursoreDopo = await page.evaluate(CURSORE);
  check('e il cursore non si e\' mosso', cursorePrima?.left === cursoreDopo?.left,
    `${cursorePrima?.left} -> ${cursoreDopo?.left}`);

  // ── 10b. spente tutte e due le mani l'esercizio si ferma ────────
  // Con tutti e due gli interruttori a zero non deve partire NESSUNA richiesta:
  // il piano buono c'e' gia', buttarlo e ricaricarlo sarebbe un esercizio che
  // riparte da capo mentre nessuno ha chiesto niente. E niente avanzamenti: le
  // note suonate in pausa restano lì, giudicate solo dopo.
  console.log('\n9b. Spengo tutte e due le mani: la pausa voluta');
  const rispostaSpegniL = page.waitForResponse(
    (r) => r.url().includes('/practice') && !r.url().includes('/practice/step'),
    { timeout: 120000 });
  await sx.click();                                   // si spegne la sinistra
  await page.waitForSelector('.practice-bar:not(.practice-notice)', { timeout: 120000 });
  await rispostaSpegniL;                              // ora partecipa solo la destra
  const pianiPrimaPausa = conta('POST /practice ');
  const passiPrimaPausa = conta('POST /practice/step');
  const cursorePrimaPausa = await page.evaluate(CURSORE);
  await dx.click();                                   // si spegne anche l'ultima
  await page.waitForTimeout(700);
  const rigaPausa = ((await page.textContent('#practice-problem')) ?? '').trim();
  check('la pausa e\' DETTA, non lasciata al buio: la riga spiega perche\' non succede niente',
    /Both hands are switched off/i.test(rigaPausa), rigaPausa);
  check('e nella riga non c\'e\' nessun punto che pulsa: nessuna richiesta sta volando',
    await page.locator('#practice-problem .pb-dot').count() === 0);
  check('la tastiera sparisce con le mani: niente tasti accesi a chiedere qualcosa',
    await page.locator('.piano-kbd').count() === 0);
  // Con tutte e due le mani spente tutto lo spartito si spegne insieme ai suoi
  // interruttori: due righi grigi e la riga che dice perche' non succede niente.
  const righiPausa = await statoRighi();
  check('in pausa entrambi i righi sono grigi',
    righiPausa.sopra.n > 0 && righiPausa.sopra.grigi === righiPausa.sopra.n
    && righiPausa.sotto.n > 0 && righiPausa.sotto.grigi === righiPausa.sotto.n,
    JSON.stringify(righiPausa));
  check('spegnere l\'ultima mano non chiede nessun piano nuovo',
    conta('POST /practice ') === pianiPrimaPausa,
    `${conta('POST /practice ') - pianiPrimaPausa} piani nuovi`);
  await page.evaluate((ps) => { for (const n of ps) window.__press(n, 80, 600); }, chiestoDx);
  await page.waitForTimeout(1500);
  check('suonare in pausa non genera verdetti: nessuna richiesta di passo',
    conta('POST /practice/step') === passiPrimaPausa,
    `${conta('POST /practice/step') - passiPrimaPausa} richieste in piu'`);
  const cursoreDopoPausa = await page.evaluate(CURSORE);
  check('e il cursore resta fermo dove le mani si sono spente',
    cursorePrimaPausa?.left === cursoreDopoPausa?.left,
    `${cursorePrimaPausa?.left} -> ${cursoreDopoPausa?.left}`);
  const pianiPrimaRipresa = conta('POST /practice ');
  await dx.click();                                   // riaccende la destra: riparte DA SOLA
  await page.waitForFunction(() => document.querySelectorAll('.pk-expected').length === 1,
    null, { timeout: 10000 }).catch(() => {});
  const tastieraRipresa = await page.locator('.piano-kbd').count();
  check('riaccendere l\'ultima mano rimasta spenta fa ricomparire la tastiera',
    tastieraRipresa === 1);
  check('e riprende dal piano che c' + '\' era, senza chiedere niente al servizio',
    conta('POST /practice ') === pianiPrimaRipresa,
    `${conta('POST /practice ') - pianiPrimaRipresa} piani nuovi`);
  // Al riprendere con una mano sola riaccesa, il colore torna SOLO sul rigo di
  // quella mano: l'altra lettera e' ancora spenta, e il suo rigo resta grigio
  // finche' non la si riaccende. Lo spartito dice la verita' stato per stato.
  const righiRipresa = await statoRighi();
  check('al riprendere a destra il rigo sopra torna a colore e il sotto resta grigio',
    righiRipresa.sopra.grigi === 0 && righiRipresa.sotto.grigi === righiRipresa.sotto.n,
    JSON.stringify(righiRipresa));

  // ── 11. le scelte della striscia non si resettano ───────────────
  // Richiesta del 2026-11-10: "se la disattivo e faccio ripartire da capo il
  // brano ricompare di nuovo, lo stesso vale per L e R ... rendile persistenti,
  // non si devono resettare a meno che non lo scelga l'utente". Qui lo stato di
  // uscita dalla sezione 10 è: L spenta e R accesa, tastiera aperta. Si chiude
  // la tastiera DI DENTRO la pratica — e al rientro si deve trovare esattamente
  // così: lettera spenta dov'era, tastiera chiusa com'era stata lasciata. Non
  // c'è più nessun reset "a tutte e due le mani" che la pagina fa di testa sua.
  // Questa sezione ENTRA ed ESCE dalla pratica per conto suo; lascia la pagina
  // DENTRO la pratica, nello stato che la sezione 12 ("uscire") si aspetta.
  await page.click('#bar-keys-btn');
  await page.waitForFunction(() => document.querySelectorAll('.piano-kbd').length === 0,
    null, { timeout: 8000 }).catch(() => {});
  check('il click sul pianoforte chiude la tastiera quando è l' + '\'utente a volerlo',
    await page.locator('.piano-kbd').count() === 0);
  await page.click('#bar-step-btn');                  // esce
  await page.waitForSelector('.practice-bar', { state: 'detached', timeout: 15000 });
  const maniGiustePrima = richieste.filter((r) => r === 'POST /practice "hand":"right"').length;
  await page.click('#bar-step-btn');                  // e rientra in pratica
  await page.waitForSelector('#bar-keys-btn', { timeout: 20000 });
  await page.waitForFunction(
    () => ((document.querySelector('#bar-hand-left')?.className ?? '').includes('pb-chip-off')),
    null, { timeout: 15000 }).catch(() => {});
  const sxRientro = await page.evaluate(() => (document.querySelector('#bar-hand-left')?.className ?? ''));
  check('rientrando la lettera L resta spenta dove l' + '\'aveva lasciata chi suona',
    sxRientro.includes('pb-chip-off'), sxRientro);
  const dxRientro = await page.evaluate(() => (document.querySelector('#bar-hand-right')?.className ?? ''));
  check('e la lettera R resta accesa com' + '\'era', dxRientro.includes('pb-chip-on'), dxRientro);
  // La tastiera è il caso citato per primo dall'utente: chiusa a mano, non deve
  // riaprirsi da sola alla sessione successiva.
  check('la tastiera di richiamo non è riapparsa per conto suo',
    await page.locator('.piano-kbd').count() === 0);
  // Se L è spenta, il piano giusto a cui tornare è quello della destra: lo
  // chiede l'effetto che confronta interruttori e piano in carica, non una
  // ripartenza-di-testa della pagina. La prova sta nel traffico — un POST
  // /practice con "hand":"right" che parte da solo entro pochi secondi dal
  // rientro. Non si aspetta la tastiera disegnata: è chiusa per scelta
  // dell'utente, e quello che deve succedere succede comunque.
  let ripartenzaGiusta = false;
  for (let i = 0; i < 40 && !ripartenzaGiusta; i++) {
    await page.waitForTimeout(500);
    ripartenzaGiusta =
      richieste.filter((r) => r === 'POST /practice "hand":"right"').length > maniGiustePrima;
  }
  check('e l' + '\'esercizio riparte dalla mano scelta, non dal brano intero',
    ripartenzaGiusta, `richieste piano: ${richieste.filter((r) => r.startsWith('POST /practice')).slice(-3).join(' | ')}`);
  const prefsSalvate = await page.evaluate(() => localStorage.getItem('cadenza-practice-controls'));
  check('la scelta è salvata anche nel browser, per il caricamento successivo',
    /"left":\s*false/.test(prefsSalvate ?? '') && /"kb":\s*false/.test(prefsSalvate ?? ''),
    String(prefsSalvate).slice(0, 80));

  // ── 12. uscire dalla pratica ──────────────────────────────────
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
  // Nessun rigo "spento" fuori dalla pratica: uscendo, gli interruttori non
  // esistono piu' e lo spartito torna tutto a colore. Se la classe restasse,
  // nella modalita' normale due righi grigi racconterebbero una mano assente
  // che nessuno ha spento.
  const righiFuori = await statoRighi();
  check('uscire dalla pratica restituisce il colore a tutti i righi',
    righiFuori.sopra.grigi === 0 && righiFuori.sotto.grigi === 0,
    JSON.stringify(righiFuori));


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
}

// L'esito su disco vale PIU' della chiusura della finestra: si scrive PRIMA di
// close. Se il teardown di Chromium pende (succede su questa macchina sotto
// stress: il 2026-11-07 il log diceva 71/71 e il JSON era rimasto fermo alla
// run precedente perche' `browser.close()` girava prima della scrittura), il
// processo può anche crepare — ma gli esiti sono già salvati, e la dottrina
// che vuole il JSON come fonte d'autorità resta vera.
const falliti = esiti.filter((e) => !e.ok);
try {
  console.log('\n' + '='.repeat(60));
  console.log(`${esiti.length - falliti.length}/${esiti.length} controlli superati`);
  // L'elenco dei falliti viene riscritto QUI, dopo il riepilogo: quando l'output passa
  // da un pipe (Tee, Select-String) le ultime righe del flusso possono perdersi
  // nell'interlacciamento stdout/stderr, e così un controllo fallito sparisce dal log
  // pur essendo nel conteggio — successo due volte su questa macchina. Il file JSON è
  // la fonte d'autorità: tutti i controlli, uno per uno, con l'esito.
  for (const f of falliti) console.log(`FALLITO (elenco finale): ${f.nome}`);
  fs.writeFileSync(path.join(ROOT, 'alignment', '_probe_traces', 'browser-esiti.json'),
    JSON.stringify(esiti, null, 1));
  console.log('='.repeat(60));
} finally {
  // Il browser si chiude per ultimo, e un suo errore non deve cancellare la
  // notizia che gli esiti sono stati scritti.
  try { await browser.close(); } catch { console.log("(chiusura del browser fallita: non cambia nulla, gli esiti sono gia' sul disco)"); }
}
process.exit(falliti.length ? 1 : 0);
