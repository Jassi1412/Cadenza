import { useCallback, useRef, useState } from 'react';
import type { MidiEvent } from './useMidi';
import { API_URL } from './useVerdict';
import { stepStatus } from './practiceSteps';
import type { PracticeStep, StepStatus, StepVerdict } from './practiceSteps';

// Le regole dell'esercizio (completezza del passo, pitch premuti, nomi delle
// note) stanno in practiceSteps.ts: sono pure, non toccano React ne' la rete, e
// da li' si possono provare davvero. Questo file fa il trasporto verso il
// servizio e tiene lo stato della sessione.
//
// I tipi si ri-esportano perche' chi consuma la pratica non debba sapere in
// quale dei due file sta cosa; le funzioni no, e chi le vuole importa il modulo
// puro — cosi' un test che le prova non tira dentro React, `import.meta.env` e
// la rete.
export type { PracticeStep, StepStatus, StepVerdict, VerdictsSnapshot } from './practiceSteps';

/**
 * La modalita' practice: lo spartito a passi, e il verdetto di ogni passo.
 *
 * COSA CAMBIA RISPETTO ALLA MODALITA' NORMALE, e perche' il tempo non c'e'.
 * In `useVerdict` la pagina manda il brano intero e riceve sette verdetti: la'
 * l'esecuzione scorre su un asse temporale e `join()` deve dedurre in che
 * battuta dello spartito e' caduta ogni nota. Qui il brano sta fermo e avanza di
 * un passo quando l'allievo ha premuto i tasti giusti: la posizione nello
 * spartito non e' da dedurre, e' l'indice del passo. Niente tempo, niente
 * allineamento, niente `tempo_factor`.
 *
 * I DUE RUOLI, CHE NON VANNO CONFUSI (vedi alignment/practice.py):
 *
 *   AVANZAMENTO  decide se il cursore passa al passo dopo. E' un confronto fra
 *                insiemi — le note che il PIANO dichiara per questo passo contro
 *                quelle premute — ed e' controllo di flusso dell'esercizio, non
 *                un giudizio. Sta qui, in `pressedPitches`/`stepComplete`, ed e'
 *                l'unica cosa di questo file che somiglia a una decisione.
 *
 *   GIUDIZIO     dice come hai suonato. E' di RML, arriva dal servizio, e non
 *                tocca il cursore.
 *
 * Il perche' e' MISURATO, non di gusto. Il verdetto di un passo costa ~170 ms in
 * locale ma **~2 s** sul servizio deployato (Render Free ha 0,1 CPU). Se il
 * cursore aspettasse il verdetto, l'allievo fisserebbe lo schermo per due
 * secondi dopo ogni nota. Cosi' invece il verdetto arriva mentre sta gia'
 * suonando il passo successivo: le regole RML non rallentano l'esercizio, lo
 * commentano.
 *
 * E c'e' un motivo indipendente dalla latenza per non usare pitch-agreement come
 * cancello: la regola guarda una nota alla volta e non sa quante ne mancavano,
 * quindi non distingue "hai sbagliato nota" da "hai aggiunto una nota". Le due
 * situazioni vogliono l'opposto (la prima deve bloccare, la seconda no) e per la
 * regola sono identiche. Verificato su traccia vera in alignment/_probe_practice.py.
 */

// `StepVerdict` non e' dichiarato qui: vive in practiceSteps.ts, dove lo provano i
// test sulle regole. Ri-dichiararlo identico in due file e' il modo classico per
// farli divergere al primo cambiamento.

/** La mano su cui si sta studiando: null = il brano intero, come prima. */
export type PracticeHand = 'right' | 'left' | null;

/**
 * Che cosa questo spartito permette di separare, dichiarato dal servizio.
 *
 * `split: false` vuol dire che il file non dichiara i righi: non c'e' nessuna
 * destra da isolare, e il toggle deve restare spento e spiegato, non spento e
 * basta. Sarebbe la stessa bugia di un tasto che sembra regolabile mentre non
 * regola niente (vedi la scelta del cursore del tempo nascosto in pratica).
 */
export interface HandInfo {
  right: number;
  left: number;
  unknown: number;
  split: boolean;
}

export interface StepResult {
  step: number;
  total: number;
  /** la mano su cui il servizio ha costruito i passi, null per il brano intero */
  hand: PracticeHand;
  status: StepStatus;
  verdicts: Record<string, StepVerdict>;
  /** le regole che in questa modalita' non si applicano, con il motivo */
  suspended: Record<string, string>;
}

export type PracticePhase = 'idle' | 'loading' | 'ready' | 'error';

export interface UsePracticeReturn {
  phase: PracticePhase;
  steps: PracticeStep[];
  /** indice del passo su cui il cursore e' fermo */
  index: number;
  error: string | null;
  /** le regole attive e quelle sospese, dal servizio */
  rules: string[];
  suspended: Record<string, string>;
  /**
   * dynamics-adherence e' accesa? Si parte da accesa.
   *
   * E' l'unica regola di pratica che si puo' spegnere, e la ragione e' di merito
   * e non tecnica: la specifica confronta due numeri e non guarda nessun istante
   * di tempo, quindi funziona identica accesa o spenta. Ma la dinamica e' una
   * cosa che si studia quando il resto viene gia' da se', e a un principiante
   * che sta ancora cercando i tasti un "violata" sulla velocity e' rumore.
   * Deciderlo e' dell'allievo, non del servizio: per questo il filtro sta qui e
   * non in una specifica diversa.
   */
  dynamicsOn: boolean;
  setDynamicsOn: (on: boolean) => void;
  /**
   * La mano su cui si sta studiando. `null` = il brano intero.
   *
   * Il filtro mano NON e' come quello della dinamica, e la differenza va mantenuta
   * separata perche' sono due meccanismi opposti:
   *
   *   `dynamicsOn` filtra la VISTA. Il servizio ha gia' giudicato tutto; qui si
   *                decide solo quale verdetto mostrare, e accenderlo non costa un
   *                giro di rete.
   *   `hand` cambia l'ESERCIZIO. Cambia quanti passi ci sono, quali tasti chiede
   *                ogni passo, cosa fa avanzare il cursore e quali eventi finiscono
   *                nella traccia che va a Prolog (vedi `alignment/practice.py`).
   *                Per questo cambiarla richiede di chiedere un piano nuovo: tenere
   *                lo stesso elenco di passi vorrebbe dire suonare la mano destra
   *                venendo giudicati su quella sinistra.
   */
  hand: PracticeHand;
  /** che cosa questo spartito permette di separare; null finche' non si e' risposto */
  hands: HandInfo | null;
  /** cambia mano e ricostruisce i passi; riparte dal passo 0 */
  setHand: (hand: PracticeHand) => Promise<void>;
  /**
   * Lo stato del passo corrente, calcolato IN LOCALE e aggiornato subito.
   *
   * Non e' un verdetto: e' quali tasti risultano premuti, quali mancano, e se il
   * passo e' completo. Serve alla grafica, che deve reagire mentre il dito e'
   * ancora sul tasto.
   *
   * E' `null` quando riguarda un altro passo: vedi `statusStep`.
   */
  status: StepStatus | null;
  /** ultimo verdetto ricevuto dal servizio: e' del passo `verdictStep` */
  last: StepResult | null;
  verdictStep: number;
  /** true mentre una richiesta di verdetto e' in volo */
  judging: boolean;
  /** comincia la pratica: legge lo spartito dal servizio e costruisce i passi */
  start: (scoreXml: string) => Promise<void>;
  /** gli eventi suonati davanti al passo corrente */
  submit: (events: readonly MidiEvent[]) => void;
  /** torna al primo passo */
  restart: () => void;
  reset: () => void;
}

export function usePractice(): UsePracticeReturn {
  const [phase, setPhase] = useState<PracticePhase>('idle');
  const [steps, setSteps] = useState<PracticeStep[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<string[]>([]);
  const [suspended, setSuspended] = useState<Record<string, string>>({});
  const [last, setLast] = useState<StepResult | null>(null);
  const [verdictStep, setVerdictStep] = useState(0);
  const [judging, setJudging] = useState(false);
  // dynamics-adherence accesa di partenza. Vedi `UsePracticeReturn.dynamicsOn`.
  //
  // Il toggle NON cambia quello che il servizio calcola: le quattro regole di
  // pratica girano sempre tutte, e questo decide solo cosa il pannello mostra.
  // Filtrare lato servizio costringerebbe a una seconda richiesta per riaccendere
  // la regola, e soprattutto metterebbe nella richiesta una scelta di
  // presentazione: il giudizio resta di RML, cosa guardarlo e' dell'allievo.
  const [dynamicsOn, setDynamicsOn] = useState(true);
  // La mano su cui si studia: null = brano intero. `handRef` esiste perche' i
  // callback (`ask`, `loadPlan`) sono creati una volta sola con `useCallback([])`
  // e leggerebbero lo stato vecchio: la richiesta di verdetto deve portare la STESSA
  // mano su cui il piano e' stato costruito, o il passo numero 5 della mano sinistra
  // verrebbe giudicato contro il passo numero 5 del brano intero.
  const [hand, setHandState] = useState<PracticeHand>(null);
  const [hands, setHands] = useState<HandInfo | null>(null);
  const handRef = useRef<PracticeHand>(null);
  // Lo stato del passo corrente, tenuto qui e aggiornato a ogni submit.
  //
  // Perche' non si ricava a render-time da `midi.recording`: quel valore e' la
  // registrazione intera e cambia a ogni evento, quindi ricalcolarlo a ogni
  // render sarebbe corretto ma inutile — e soprattutto lo stato va FISSATO,
  // perche' quando il cursore avanza la registrazione contiene ancora gli eventi
  // del passo appena finito, e i tasti appena premuti risulterebbero "in piu'"
  // sul passo nuovo. Qui si fotografa il momento del submit, che e' quello che
  // l'allievo ha suonato davanti a quel passo.
  const [status, setStatus] = useState<StepStatus | null>(null);
  // A QUALE passo appartiene `status`.
  //
  // Serve perche' le due cose non coincidono: un passo di una nota sola si
  // completa alla prima pressione, quindi `submit` fissa lo stato E fa avanzare
  // il cursore nello stesso giro. Senza questo indice il pannello mostrerebbe i
  // tasti del passo nuovo colorati secondo quello vecchio, cioe' darebbe per
  // premuti dei tasti che non sono stati toccati.
  const [statusStep, setStatusStep] = useState(0);

  // Lo spartito serve a OGNI richiesta di verdetto, ma e' lo stesso per tutta la
  // sessione: tenerlo qui evita di rileggerlo dal file a ogni nota. E' il testo,
  // non un oggetto con stato, quindi conservarlo per riferimento va bene.
  const scoreRef = useRef<string | null>(null);

  // Una richiesta per volta.
  //
  // Non e' solo prudenza: il verdetto e' lento sul piano gratuito, e senza
  // questo ogni pressione ne accoderebbe una. Le richieste si accavallerebbero,
  // le risposte arriverebbero fuori ordine e il pannello mostrerebbe il verdetto
  // di un passo mentre l'allievo ne sta suonando un altro. Con il flag, una
  // richiesta in volo assorbe le pressioni successive: si giudica l'ultimo stato
  // del passo, che e' quello che conta.
  const busy = useRef(false);
  const pending = useRef<readonly MidiEvent[] | null>(null);

  // Costruisce (o ricostruisce) i passi per la mano corrente.
  //
  // Sta separata da `start` perche' il piano va chiesto di nuovo ogni volta che
  // cambia la mano: il filtro non e' una presentazione, e' un esercizio diverso —
  // numero di passi diverso, tasti chiesti diversi, cursore che punta ad altri
  // attacchi. Tenere l'elenco vecchio vorrebbe dire suonare la destra ed essere
  // giudicati sulla sinistra.
  const loadPlan = useCallback(async (scoreXml: string) => {
    setPhase('loading');
    setError(null);
    try {
      const res = await fetch(`${API_URL}/practice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: scoreXml, hand: handRef.current ?? 'both' }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error ?? `il servizio ha risposto ${res.status}`);
      const list = (payload.steps ?? []) as PracticeStep[];
      if (list.length === 0) {
        throw new Error('Il servizio non ha trovato passi da suonare in questo spartito.');
      }
      setSteps(list);
      setRules((payload.rules ?? []) as string[]);
      setSuspended((payload.suspended ?? {}) as Record<string, string>);
      // Che cosa si puo' separare in questo spartito: il toggle della mano legge
      // questi numeri per accendersi o per restare spento e dichiarato.
      setHands((payload.hands ?? null) as HandInfo | null);
      setIndex(0);
      setVerdictStep(0);
      setLast(null);
      setStatus(null);
      setStatusStep(0);
      setPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, []);

  const start = useCallback(async (scoreXml: string) => {
    scoreRef.current = scoreXml;
    await loadPlan(scoreXml);
  }, [loadPlan]);

  const setHand = useCallback(async (next: PracticeHand) => {
    // Un pezzo che non dichiara i righi non ha una destra da isolare: la scelta non
    // viene nemmeno registrata. Un toggle che accetta una selezione e poi non puo'
    // produrre niente e' solo un modo per far credere che stia succedendo qualcosa.
    if (hands && !hands.split && next !== null) return;
    const score = scoreRef.current;
    handRef.current = next;
    setHandState(next);
    if (!score) return;
    await loadPlan(score);
  }, [hands, loadPlan]);

  const ask = useCallback(async (stepIndex: number, events: readonly MidiEvent[]) => {
    const score = scoreRef.current;
    if (!score) return;
    busy.current = true;
    setJudging(true);
    try {
      const res = await fetch(`${API_URL}/practice/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          score,
          step: stepIndex,
          // La stessa mano del piano, letta dal ref e non dallo stato: chiedere il
          // verdetto con la mano sbagliata e' un errore silenzioso. Il servizio
          // costruirebbe i passi su un'altra mano e giudicherebbe note che
          // l'allievo non stava cercando di suonare.
          hand: handRef.current ?? 'both',
          // Gli eventi vanno come li manda Web MIDI, con la loro forma:
          // l'accoppiamento attacco/rilascio lo fa il servizio, in un posto solo.
          //
          // `rawAttack ?? 64` e non `?? 0`: un note-on con velocity 0 E' un
          // rilascio, quindi mandare 0 al posto di una velocity mancante
          // trasformerebbe una pressione in un rilascio e il passo non
          // avanzerebbe mai. Il 64 e' il centro della scala, come fa
          // `toPerformance` con la stessa evenienza.
          events: events.map((e) => ({
            type: e.type,
            pitch: e.note,
            velocity: e.rawAttack ?? 64,
            time_ms: e.timestamp,
          })),
          control_changes: events
            .filter((e) => e.type === 'controlchange' && e.controller !== undefined)
            .map((e) => ({
              time_ms: e.timestamp,
              controller: e.controller as number,
              value: e.value ?? 0,
            })),
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error ?? `il servizio ha risposto ${res.status}`);
      setLast(payload as StepResult);
      setVerdictStep(stepIndex);
      setError(null);
    } catch (err) {
      // Un verdetto mancato NON e' un errore dell'esercizio e non deve fermare
      // la pratica: si segnala e si va avanti. L'allievo sta suonando, e
      // interromperlo per un problema di rete sarebbe la cosa peggiore.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
      setJudging(false);
      // Se nel frattempo sono arrivate altre pressioni, si giudica quella piu'
      // recente: e' lo stato definitivo del passo.
      const next = pending.current;
      pending.current = null;
      if (next) void ask(stepIndex, next);
    }
  }, []);

  const submit = useCallback(
    (events: readonly MidiEvent[]) => {
      const step = steps[index];
      if (!step) return;

      // Il cursore avanza SUBITO, senza aspettare il verdetto: e' un confronto
      // fra insiemi fatto sui dati che il piano ha gia' dato.
      const now = stepStatus(step, events);
      setStatus(now);
      setStatusStep(index);
      if (now.advance && index < steps.length - 1) {
        setIndex(index + 1);
      }

      // Il verdetto riguarda il passo appena suonato, anche se il cursore e' gia'
      // passato oltre: si chiede con l'indice di QUEL passo, non con `index`.
      if (busy.current) {
        pending.current = events;
        return;
      }
      void ask(index, events);
    },
    [steps, index, ask],
  );

  const restart = useCallback(() => {
    setIndex(0);
    setVerdictStep(0);
    setLast(null);
    setStatus(null);
    setStatusStep(0);
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setPhase('idle');
    setSteps([]);
    setIndex(0);
    setVerdictStep(0);
    setLast(null);
    setStatus(null);
    setStatusStep(0);
    setError(null);
    setRules([]);
    setSuspended({});
    // La mano si azzera insieme alla sessione: rientrare nella pratica deve trovare
    // il brano intero, non la mano sinistra scelta l'ultima volta. Senza questo, il
    // primo passo di una sessione nuova sarebbe uno solo e sembrerebbe un guasto.
    setHandState(null);
    setHands(null);
    handRef.current = null;
    scoreRef.current = null;
    pending.current = null;
  }, []);

  return {
    phase, steps, index, error, rules, suspended,
    dynamicsOn, setDynamicsOn,
    hand, hands, setHand,
    // Lo stato vale solo per il passo a cui si riferisce: se il cursore e' gia'
    // passato oltre, mostrarlo sui tasti del passo nuovo sarebbe sbagliato.
    status: statusStep === index ? status : null,
    last, verdictStep, judging, start, submit, restart, reset,
  };
}
