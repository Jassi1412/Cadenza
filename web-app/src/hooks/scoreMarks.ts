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
}

/** La forma minima di un verdetto che questo modulo sa leggere. */
export interface VerdictLike {
  ok: boolean;
  exit: number;
  /** presente solo su exit 1; assente o vuoto = violazione senza un punto */
  locations?: ScoreLocation[] | null;
}

export type VerdictsLike = Record<string, VerdictLike>;

/** Un punto da colorare: posizione + le regole che sono cascate proprio li'. */
export interface MarkColumn {
  measure: number;
  beat: number;
  /** l'attacco da raggiungere; null se il servizio non sa dove puntare il dito */
  attack: number | null;
  /** nomi delle regole come chiavi del payload, in ordine di comparsa */
  rules: string[];
}

export interface MarkPlan {
  /** punti da colorare, in ordine di lettura; l'ordine del cammino e' attack */
  columns: MarkColumn[];
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
 */
export function planMarks(verdicts: VerdictsLike): MarkPlan {
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
      if (!col.rules.includes(rule)) col.rules.push(rule);
      placed = true;
    }
    if (!placed) unpinned.add(rule);
  }

  const columns = [...byPos.values()].sort(
    (a, b) => a.measure - b.measure || a.beat - b.beat,
  );
  return {
    columns,
    unpinned: [...unpinned].sort(),
    broken: broken.sort(),
  };
}

/** Il tooltip del punto: solo i nomi delle regole. Nient'altro, per richiesta. */
export function hoverLabel(column: MarkColumn): string {
  return column.rules.join(', ');
}

/**
 * Le righe che restano al posto dell'elenco dei verdetti. Sono due o tre frasi
 * in tutto, e ognuna copre un caso che LO SPARTITO da solo non puo' dire: i
 * punti rossi dicono cosa e' andato storto li', ma un monitor rotto o una
 * violazione senza una nota (il pedale giudicato sulla intera esecuzione) li
 * leggerebbe come un silenzio di assoluzione. Inglese per contratto (User
 * Preferences nel DOX root).
 */
export function summaryLines(
  plan: MarkPlan,
  markedCount: number,
  missedRules: string[],
  noteCount: number,
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
  return lines;
}
