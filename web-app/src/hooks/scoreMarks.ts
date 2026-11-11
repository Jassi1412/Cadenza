/**
 * Dove colorare di rosso, e cosa scrivere nel tooltip quando il mouse si ferma
 * li'. Il verdetto continua a essere sette si/no: qui non nasce nessun giudizio,
 * si traduce soltanto IL PUNTO che il servizio ha gia' indicato.
 *
 * Il modulo e' puro come practiceSteps.ts: niente React, niente rete, niente
 * import.meta.env. E' la parte delle marcature che decide qualcosa (raggruppa,
 * deduplica, prepara la coda del cammino), e la decisione deve restare
 * eseguibile da sola, senza browser ne' servizio — vedi
 * ../alignment/run_scoremarks_tests.mjs.
 *
 * Perche' ogni punto porta l'INDICE DELL'ATTACCO (`attack`) e non basta la
 * battuta: lo spartito che OSMD disegna riporta le note tre ottave sotto il
 * piano (octave-shift), mentre la traccia del servizio porta i pitch veri. Il
 * ponte fra i due mondi e' il CONTARE gli attacchi in ordine cronologico, mai
 * l'altezza del suono: e' il contratto su cui cammina il cursore in pratica,
 * misurato 128 fermate su 128 in alignment/_probe_osmd.mjs. Il servizio manda
 * anche misura e battitura per dire che quel numero sta in un punto leggibile,
 * ma a chi colora serve l'indice: chi prova a leggere le note sbaglia di tre
 * ottave in ogni spartito, chi conta no.
 */

/** Un punto dello spartito: arriva dal servizio gia' deduplicato per posizione. */
export interface ScoreLocation {
  measure: number;
  beat: number;
  /**
   * Indice assoluto dell'attacco nello spartito completo: la fermata che il
   * cursore deve raggiungere. Il servizio lo mette solo quando lo sa davvero;
   * null = punto indicato a parole ma senza una nota da colorare.
   */
  attack?: number | null;
  /**
   * I numeri nudi dell'errore, allegati dal servizio dove esistono davvero:
   * 'pitch' = il tasto premuto e quello scritto, 'velocity' = le due velocita',
   * 'timing' = di quanto un tasto giusto e' arrivato fuori tempo (played =
   * millisecondi col segno, positivo = in ritardo; lo produce solo la copertura
   * "out of time" del servizio). Assenti altrove (jitter, pedale, articolazione,
   * "never played"): nessuna riga inventata.
   */
  kind?: 'pitch' | 'velocity' | 'timing' | null;
  played?: number | null;
  written?: number | null;
}

/** La forma minima di un verdetto che questo modulo sa leggere. */
export interface VerdictLike {
  ok: boolean;
  exit: number;
  /** presente solo su exit 1; assente o vuoto = violazione senza un punto */
  locations?: ScoreLocation[] | null;
}

export type VerdictsLike = Record<string, VerdictLike>;

/** Una regola caduta su un punto, con i suoi numeri quando il servizio li ha. */
export interface MarkRule {
  name: string;
  kind?: 'pitch' | 'velocity' | 'timing';
  played?: number;
  written?: number;
}

/** Un punto da colorare: posizione + le regole che sono cascate proprio li'. */
export interface MarkColumn {
  measure: number;
  beat: number;
  /** l'attacco da raggiungere; null se il servizio non sa dove puntare il dito */
  attack: number | null;
  /** regole, in ordine di comparsa; i dettagli stanno nei campi numerici */
  rules: MarkRule[];
}

/** Un attacco scritto che ha suonato il suo pitch giusto, dentro il tempo.
 *  Lo dichiara il servizio (campo "correct") e la pagina lo tinge di VERDE:
 *  nessun hover, nessuna spiegazione — il verde non deve dire altro che "li'
 *  hai fatto la cosa giusta" (richiesta 2026-11-10). */
export interface GreenSpot {
  measure: number;
  beat: number;
  /** obbligatorio: senza indice da contare la pagina non ha nessuna testa da colorare */
  attack: number;
}

export interface MarkPlan {
  /** punti da colorare, in ordine di lettura; l'ordine del cammino e' attack */
  columns: MarkColumn[];
  /** attacchi puliti da tingere di verde; mai sovrapposti ai rossi, vedi planMarks */
  green: GreenSpot[];
  /** regole violate che non indicano nessun punto: solo nomi nella riga sotto */
  unpinned: string[];
  /** exit 2: il monitor non e' partito. Mai una nota rossa per questo. */
  broken: string[];
}

/**
 * Da sette verdetti a un piano di marcatura.
 *
 * Due regole cascano sullo stesso punto (nota stonata e dinamica sbagliata
 * nella stessa battitura)? UNO solo punto rosso, con tutte e due i nomi nel
 * tooltip: all'allievo serve sapere COSA non ha rispettato in quel punto, non
 * contare due macchie rosse sovrapposte. La chiave di deduplica e' l'indice
 * dell'attacco perche' e' ESATTO per costruzione (lo calcola la stessa griglia
 * che genera i passi del piano); senza indice si ripiega su misura:battitura,
 * che arriva dalla stessa funzione di snap per entrambi gli eventi.
 *
 * exit 2 NON produce note: il servizio non ha giudicato niente, e una nota
 * rossa sarebbe un'accusa inventata a chi ha suonato. Finisce nell'elenco
 * `broken`, che la pagina dichiara a parte.
 *
 * `correct` (richiesta 2026-11-10: "le note premute correttamente fossero
 * colorate di verde, e tutte le altre di rosso") sono gli attacchi puliti che
 * il servizio ha ri-ancorato ai tasti premuti. Qui diventano `green`, con la
 * stessa deduplica dei rossi e ESCLUSI dove un rosso c'e' gia': un punto non
 * porta due colori, e il rosso vince — se una regola ha qualcosa da ridire
 * li', "hai premuto giusto" non e' piu' una frase vera. Un verde senza indice
 * dell'attacco non e' colorabile (la pagina ci arriva contando) e non compare.
 */
export function planMarks(verdicts: VerdictsLike, correct?: ScoreLocation[] | null): MarkPlan {
  const byPos = new Map<string, MarkColumn>();
  const unpinned = new Set<string>();
  const broken: string[] = [];

  for (const [rule, v] of Object.entries(verdicts)) {
    if (!v) continue;
    if (v.exit === 2) {
      broken.push(rule);
      continue;
    }
    if (v.exit !== 1) continue; // 0 = conforme: niente rosso, niente nomi

    const locations = Array.isArray(v.locations) ? v.locations : [];
    let placed = false;
    for (const l of locations) {
      if (typeof l?.beat !== 'number' || typeof l?.measure !== 'number'
        || !Number.isFinite(l.beat) || !Number.isFinite(l.measure)) {
        continue;
      }
      const attack = Number.isInteger(l.attack) ? (l.attack as number) : null;
      // La chiave e' il numero ESATTO: lo stesso punto arriva identico da eventi
      // diversi perche' l'ha calcolato la stessa griglia di snap.
      const key = attack !== null ? `a${attack}` : `${l.measure}:${l.beat}`;
      let col = byPos.get(key);
      if (!col) {
        col = { measure: l.measure, beat: l.beat, attack, rules: [] };
        byPos.set(key, col);
      }
      if (!col.rules.some((r) => r.name === rule)) {
        col.rules.push({
          name: rule,
          ...(l.kind === 'pitch' || l.kind === 'velocity' || l.kind === 'timing'
            ? { kind: l.kind, played: l.played ?? undefined, written: l.written ?? undefined }
            : {}),
        });
      }
      placed = true;
    }
    if (!placed) unpinned.add(rule);
  }

  const columns = [...byPos.values()].sort(
    (a, b) => a.measure - b.measure || a.beat - b.beat,
  );

  // Il verde passa di qua solo dove il rosso non c'e'. Il servizio l'ha gia'
  // tolto, qui si ricontrolla: un punto con due colori sarebbe peggio di una
  // verifica ripetuta, e un attack duplicato non deve colorare due volte.
  const taken = new Set(
    columns.map((c) => (c.attack !== null ? `a${c.attack}` : `${c.measure}:${c.beat}`)),
  );
  const green: GreenSpot[] = [];
  for (const l of Array.isArray(correct) ? correct : []) {
    if (!Number.isInteger(l?.attack)) continue;
    if (typeof l.beat !== 'number' || typeof l.measure !== 'number') continue;
    const key = `a${l.attack as number}`;
    if (taken.has(key)) continue;
    taken.add(key);
    green.push({ measure: l.measure, beat: l.beat, attack: l.attack as number });
  }

  return {
    columns,
    green,
    unpinned: [...unpinned].sort(),
    broken: broken.sort(),
  };
}

import { noteName } from './practiceSteps';

/**
 * Il rigo MusicXML che porta una mano, nella convenzione del servizio:
 * 1 = destra (sopra), 2 = sinistra (sotto). `null`, `'both'` o assente =
 * nessun filtro, si colora tutto.
 *
 * Serve alla pagina per NON colorare l'altra mano quando la presa ne giudica
 * una sola. Sul Warmup il primo attacco e' insieme il Do4 della destra e
 * l'accordo di sinistra: colorando la colonna intera, il verdetto della
 * sinistra finiva addosso alla nota di destra — verde compreso
 * ("il primo accordo la nota piu' alta e' verde", 2026-11-11).
 */
export function staffForHand(hand: string | null | undefined): number | null {
  if (hand === 'right') return 1;
  if (hand === 'left') return 2;
  return null;
}

/** Una riga della card d'hover: il nome della regola e, dove c'è, la coppia di numeri. */
export interface MarkLine {
  rule: string;
  /**
   * Inglese, al minimo, formato qui perché è testo e la prova sta nel modulo puro:
   * `you C#4 · score D4` per un tasto, `you 101 · score 84` per una dinamica.
   * Il servizio manda i numeri nudi (`kind`/`played`/`written`): le frasi le
   * scrive una parte sola. Definisca due nomi diversi lo stesso numero in due
   * posti, e sarà la prossima divergenza da spiegare.
   */
  detail?: string;
}

/**
 * Le righe della card d'hover su una nota rossa: UNA per ogni regola caduta
 * lì, nell'ordine di comparsa. Niente frasi di circostanza — chi ha appena
 * letto "pitch-agreement · you F3 · score G3" non deve leggere altro (la
 * richiesta del 2026-11-10: minimizzare ciò che si legge, massimizzare ciò
 * che si capisce).
 */
export function markLines(column: MarkColumn): MarkLine[] {
  return column.rules.map((r) => {
    if (r.kind === 'pitch' && typeof r.played === 'number' && typeof r.written === 'number') {
      return { rule: r.name, detail: `you ${noteName(r.played)} · score ${noteName(r.written)}` };
    }
    if (r.kind === 'velocity' && typeof r.played === 'number' && typeof r.written === 'number') {
      return { rule: r.name, detail: `you ${r.played} · score ${r.written}` };
    }
    if (r.kind === 'timing' && typeof r.played === 'number') {
      // "out of time": il numero e' il ritardo col segno, la frase la scrive
      // qui come per le altre coppie — il servizio passa solo numeri nudi.
      const ms = Math.abs(Math.round(r.played));
      return {
        rule: r.name,
        detail: `you ${ms} ms ${r.played >= 0 ? 'late' : 'early'} · score on time`,
      };
    }
    return { rule: r.name }; // jitter, pedale, articolazione, never played: nessun numero da mostrare
  });
}

/** Tutto quello che la card d'hover su una nota deve dire. */
export interface MarkTip {
  measure: number;
  beat: number;
  lines: MarkLine[];
}

export function markTipFor(column: MarkColumn): MarkTip {
  return { measure: column.measure, beat: column.beat, lines: markLines(column) };
}

/**
 * La lettura completa del piano, in due o tre frasi: i punti rossi dicono cosa
 * e' andato storto li', ma un monitor rotto o una violazione senza una nota (il
 * pedale giudicato sulla intera esecuzione) li leggerebbe come un silenzio di
 * assoluzione. Inglese per contratto (User Preferences nel DOX root).
 *
 * Dal 2026-11-11 la card mostra SOLO il numero e la pagina non disegna piu'
 * queste righe (richiesta dell'utente); la funzione resta pura e provata perche'
 * e' la lettura completa del piano, non perche' qualcuno la stampi.
 */
export function summaryLines(
  plan: MarkPlan,
  markedCount: number,
  missedRules: string[],
  noteCount: number,
  suspended: string[] = [],
): string[] {
  const unlocatable = [...new Set([...plan.unpinned, ...missedRules])].sort();
  const lines: string[] = [];

  if (markedCount > 0) {
    lines.push(
      `${noteCount} notes analysed · ${markedCount} ` +
      `${markedCount === 1 ? 'spot' : 'spots'} marked in the score — hover a red ` +
      'note to see which rules were not respected there',
    );
  } else if (unlocatable.length === 0 && plan.broken.length === 0) {
    lines.push(`${noteCount} notes analysed — every rule the service judged was respected`);
  } else if (plan.broken.length === 7 && unlocatable.length === 0) {
    lines.push('the monitor did not start on any rule: nothing could be checked');
  }

  if (unlocatable.length) {
    lines.push(`violated without a point in the score: ${unlocatable.join(', ')}`);
  }
  if (plan.broken.length) {
    lines.push(`not judged, the monitor did not start: ${plan.broken.join(', ')}`);
  }
  // Con una mano sola il pedale non e' di nessuna delle due: il servizio lo
  // dichiara sospeso, e la riga lo dice invece di lasciare un silenzio che si
  // legge come "conforme" (stessa regola dei monitor che non partono).
  if (suspended.length) {
    lines.push(`not judged with one hand: ${[...new Set(suspended)].sort().join(', ')}`);
  }
  return lines;
}

/** Il verdetto ridotto a un numero, con il suo perché accanto. */
export interface ScoreOutcome {
  /** 0..100; null quando Nessuna regola è potuta partire: nessun voto da dire */
  score: number | null;
  /** punti giudicati in fallo, contati UNA VOLTA ciascuno anche se più regole ci cascano */
  flagged: number;
  /** note dell'esecuzione che il servizio ha potuto giudicare — il denominatore */
  notes: number;
}

/**
 * Il punteggio 0-100 della carta centrata (richiesta 2026-11-10: "one score
 * relative to the score, based on how many errors you made").
 *
 * LA METRICA, dichiarata per intero perché è una scelta, non un numero sacro:
 *   punteggio = 100 × (1 − punti in fallo / note suonate)
 * Un punto conta UNA volta anche se due regole cascano sullo stesso attacco —
 * come per i rossi sulla partitura, un errore solo non deve scalare la pagella
 * due volte (`planMarks` deduplica già così, e qui si usa la stessa chiave:
 * `attack`, o misura:battitura in sua vece). Le regole violate senza un punto
 * (il pedale giudicato sull'intera esecuzione) contano come un errore ciascuna:
 * non indicano una nota da colorare, ma una colpa è rimasta comunque.
 *
 * Il denominatore sono LE NOTE SUONATE, non quelle scritte: la metrica nasce
 * relativa all'esecuzione di chi ha suonato — il servizio gliel'ha già contate
 * (`noteCount` di useVerdict), e nessuna pagina può conoscere quante note
 * "doveva" suonare senza re-implementare il parsing dello spartito: una soglia
 * duplicata fuori dal servizio è vietata dal contratto (pages/AGENTS.md).
 *
 * exit 2 NON scala niente: un monitor che non è partito non è un errore di
 * chi suona, e se nessun monitor è partito il voto NON si dà per niente
 * (score null): dire 100 a chi non è stato giudicato sarebbe la bugia più
 * grossa del progetto.
 */
export function performanceScore(verdicts: VerdictsLike, noteCount: number): ScoreOutcome {
  const points = new Set<string>();
  let unpinned = 0;
  let judged = 0;

  for (const [, v] of Object.entries(verdicts)) {
    if (!v) continue;
    if (v.exit === 2) continue; // non ha giudicato: fuori dal conto, dentro il caveat
    judged++;
    if (v.exit !== 1) continue; // conforme
    const locations = Array.isArray(v.locations) ? v.locations : [];
    let placed = false;
    for (const l of locations) {
      if (typeof l?.beat !== 'number' || typeof l?.measure !== 'number') continue;
      const attack = Number.isInteger(l.attack) ? (l.attack as number) : null;
      points.add(attack !== null ? `a${attack}` : `${l.measure}:${l.beat}`);
      placed = true;
    }
    if (!placed) unpinned++; // violazione che non indica nessuna nota: un errore, non zero
  }

  const notes = Math.max(Math.floor(noteCount) || 0, 0);
  const flagged = points.size + unpinned;
  if (judged === 0) return { score: null, flagged, notes };
  // Il denominatore non scende mai sotto gli errori trovati (zero note con un
  // errore in mano sarebbe una divisione bugiarda), e un'esecuzione senza note
  // né macchie resta a 100: non c'è niente da togliere.
  const ratio = flagged / Math.max(notes, flagged, 1);
  return { score: Math.round(100 * (1 - ratio)), flagged, notes };
}

/**
 * QUANDO il brano è finito — la domanda a cui l'utente non voleva si rispondesse
 * con una stima (2026-11-10, dopo la prima cura dell'euristica all'85%):
 * "preferirei qualcosa di più robusto che è sicuro al 100% che lo spartito è
 * terminato". La risposta qui non osserva comportamenti tipici ("di solito il
 * player salta a zero"): giudica due fatti, ciascuno certo per definizione.
 *
 * 1. 'top' — `position` tocca il tetto del suo getter. Il bundle del player
 *    (verificato): `get position(){ return max(0, min(sequencer.currentTime·1e3,
 *    duration-1)) }`. Quel valore è raggiungibile SOLO quando il tempo di
 *    esecuzione ha consumato la durata intera: certezza per definizione.
 *    END_SLACK_MS=2 segue quel tetto esatto, non una tolleranza comoda (con 250
 *    ms generosi il verdetto partiva col fondo ancora da suonare).
 *
 * 2. 'rewind' — `position` scende con il contatore di bordo già alla fine.
 *    Il chiamante (page) somma SOLO gli avanzamenti positivi di position: su
 *    una sequenza che sale e basta, fino all'eventuale riavvolgimento, quella
 *    somma è la distanza percorsa lungo la traccia — è la posizione reale
 *    stessa, non un orologio, quindi sospensioni d'audio o tab in background
 *    non la toccano. Un brano finito senza che il sample veda la cima (è il
 *    caso segnalato dall'utente: il tick a ~16 ms con playbackRate > 1
 *    scavalca la finestrella di 2 ms) produce UNA sola sequenza possibile:
 *    salita quasi fino a duration, poi caduta. La caduta conta solo se la
 *    distanza percorsa arriva a duration meno il passo di CAMPITURA mancato —
 *    e il passo mancato è al massimo un frame d'avanzamento, dello stesso
 *    ordine del più grosso mai osservato: WRAP_MARGIN_FACTOR moltiplica quel
 *    passo misurato, non una frazione del brano. La finestra di incertezza è
 *    larga due passi del sequencer (~30 ms anche a 4×), e vive solo DOPO che
 *    il brano è davvero finito: prima di lì nessun'altra caduta può passarla,
 *    perché a metà brano la distanza percorsa è lontana dalla durata. Non c'è
 *    soglia percentuale: un calo a metà trova il contatore lontano e viene
 *    ignorato per costruzione.
 *
 * Il modulo resta puro: non vede il player, riceve i numeri già letti dal
 * page (durata, prelievo attuale, prelievo precedente, somma dei passi
 * positivi, passo massimo) e risponde solo 'top' | 'rewind' | null. La rete di
 * sicurezza sul sequencer congelato (STALL_MS) resta nel page: è un "arrendersi
 * e mandar giù lo stesso", non una fine certa, e qui si dichiara solo ciò che
 * è certo.
 *
 * Vero primato (2026-11-10, stesse ore della richiesta): il worklet di
 * SpessaSynth dichiara i fatti LUI stesso, e il bundle lo dice alla lettera —
 * `pauseInternal(finito)` chiama `callEvent('songEnded')`, e il thread
 * principale (handleMessage, caso 'pause') lo gira a `eventHandler` del
 * sequencer: lì la page si iscrive con `addEvent('songEnded', ...)`, e quel
 * segnale significa "tutto quel che c'era da suonare è stato suonato", senza
 * nulla da dedurre. Per il salto di loop il caso 'loopCountChange' AGGIORNA il
 * contatore `.loopCount` del thread principale SENZA chiamare l'eventHandler
 * (verbatim dal sorgente: `this._loopCount = m.data.newCount; break;`): il
 * fatto nudo arriva quindi come CALO di quella proprietà, che il tick confronta
 * col valore del fotogramma prima. A quel punto resta aperta UNA sola domanda,
 * e risponde questa funzione: il salto è avvenuto a traccia consumata (fine
 * reale: era il "secondo giro" denunciato dall'utente) o a metà brano
 * (ripetizione scritta: si prosegue a registrare)? Le regole 'top'/'rewind'
 * sotto restano la rete per quando il canale eventi non parla.
 */

/** Margine col quale `position` ha toccato il tetto del suo getter. */
export const END_SLACK_MS = 2;

/** Multipla del passo di campitura più grosso osservato: il passo mai visto. */
export const WRAP_MARGIN_FACTOR = 2;

/** 'top' = cima raggiunta; 'rewind' = fine consumata + caduta; null = si suona. */
export type EndSignal = 'top' | 'rewind' | null;

/**
 * La traccia è stata percorsa per intero (meno un margine di campitura): la
 * stessa domanda che fa 'rewind', posta da sola. La page la rimanda identica
 * quando il WORKLET dichiara un salto di loop (`loopCountChange` nel sequencer
 * di SpessaSynth, letto dal bundle): lì non serve dedurre nulla dal grafico di
 * position — l'evento dice CHE IL PLAYER È RIPARTITO, e a questa funzione
 * chiede solo se quel salto è avvenuto a brano consumato (fine vera) o a metà
 * (ripetizione scritta, che si attraversa senza fermare la presa).
 */
export function consumedFullTrack(dur: number, pathMs: number, maxStepMs: number): boolean {
  if (dur <= 0) return false;
  return pathMs >= dur - Math.max(maxStepMs * WRAP_MARGIN_FACTOR, END_SLACK_MS);
}

export function endSignal(
  dur: number,
  pos: number,
  prevPos: number,
  pathMs: number,
  maxStepMs: number,
): EndSignal {
  if (dur <= 0) return null;
  if (pos >= dur - END_SLACK_MS) return 'top';
  // Il primo prelievo non ha un "prima": nessuna caduta da leggere.
  if (prevPos < 0) return null;
  if (pos >= prevPos) return null;
  if (consumedFullTrack(dur, pathMs, maxStepMs)) return 'rewind';
  return null;
}
