# Analisi per il Tirocinio: Runtime Verification applicata a "Cadenza"

Questo documento sintetizza lo studio preliminare, la mappa delle metriche di esecuzione al pianoforte, il modello degli eventi **Web MIDI** adottato e alcuni **esempi pratici di implementazione in RML** per il progetto **Cadenza** (React + TypeScript + WebMIDI). La piattaforma di Runtime Verification scelta è **RML**, con monitor compilato per **SWI-Prolog**.

---

## 1. Mappa delle Metriche di Esecuzione Monitorabili

Le metriche sono state ottimizzate eliminando le esitazioni (per preservare l'espressività dell'utente) e le pedalizzazioni complesse (mezzo pedale) per concentrarsi su parametri oggettivi e fattibili. Gli eventi MIDI coinvolti fanno riferimento al modello **webmidi v3** descritto in dettaglio nella Sezione 2.

| Categoria | Metrica | Descrizione Tecnica | Eventi MIDI Coinvolti | Valore del Feedback per l'Utente |
| :--- | :--- | :--- | :--- | :--- |
| **1. Accuratezza delle Note (Pitch)** | **Note Errate (Extraneous Notes)** | Pressione di note non presenti nello spartito in quel determinato momento. | Evento `noteon` con `note.number` non atteso. | Rileva errori di lettura dello spartito o tasti premuti per errore. |
| | **Note Mancanti (Missed Notes)** | Note dello spartito saltate o non registrate dal monitor. | Mancato `noteon` prima dell'avanzamento dello spartito. | Evidenzia note saltate o passaggi non letti. |
| | **Note "Ghost" (Slip-offs)** | Note a bassissima velocità e durata brevissima adiacenti a note corrette. | Coppia `noteon`/`noteoff` ravvicinata (es. $\Delta t < 80\text{ ms}$) con `rawAttack < 15`. | Rileva problemi di precisione delle dita (il dito "scivola" su un tasto adiacente). |
| **2. Tempismo e Ritmo (Timing)** | **Precisione dell'Accordo (Chord Jitter)** | Scostamento temporale massimo nella pressione simultanea delle note di un accordo. | Delta `timestamp` tra i diversi `noteon` dell'accordo. | Un accordo ben eseguito ha le note simultanee (jitter < 50 ms). Identifica arpeggiature involontarie. |
| | **Rapporto di Durata (IOI - Inter-Onset)** | Rapporto tra l'intervallo di inizio di note consecutive rispetto al valore nominale dello spartito. | Delta `timestamp` tra `noteon` consecutivi. | Valuta se le proporzioni ritmiche vengono rispettate (es. croma eseguita esattamente come metà tempo di una semiminima). |
| | **Stabilità del Tempo (BPM Drift)** | Oscillazioni o deviazioni sistematiche del tempo metronomico globale (rallentando/accelerando non richiesti). | Analisi dei `timestamp` medi dei battiti nel tempo. | Aiuta a mantenere un tempo costante, evidenziando se si accelera nei passaggi facili o si rallenta in quelli difficili. |
| **3. Dinamica ed Espressione** | **Aderenza alla Dinamica dello Spartito** | Confronto tra l'intensità della nota suonata e l'indicazione dello spartito (es. *p*, *mp*, *f*, *ff*). | Valore `note.rawAttack` (0-127) o `note.attack` (0-1) nei `noteon`, confrontato con la dinamica teorica estratta da OSMD. | Valuta se l'esecutore rispetta il colore dinamico dello spartito (es. controllando che una nota segnata come *forte* superi una velocity di 80, e una segnata come *piano* sia sotto 50). |
| **4. Pedalizzazione (Sustain)** | **Tempismo del Pedale di Risonanza** | Il pedale deve essere premuto *subito dopo* l'attacco del tasto e rilasciato *subito prima/durante* il cambio di accordo (pedale sincopato). | `controlchange` con `controller = 64` e `value` 0 oppure 127, relazionato a `noteon`/`noteoff`. | Rileva l'uso scorretto del pedale di risonanza che causa un suono "secco" (rilascio anticipato) o "impastato" (mancato rilascio al cambio accordo). |
| **5. Articolazione e Tocco** | **Legato vs Staccato** | Grado di sovrapposizione temporale tra la fine di una nota e l'inizio della successiva. | Delta temporale tra `noteoff` della nota $N$ e `noteon` della nota $N+1$. | *Legato*: sovrapposizione positiva (tasto premuto prima di rilasciare il precedente). *Staccato*: distacco netto (silenzio tra le due note). Verifica la fedeltà all'articolazione richiesta. |

---

## 2. Modello degli Eventi: Web MIDI (webmidi v3)

Gli eventi catturati dal probe MIDI seguono il formato **webmidi v3**, verificato sperimentalmente tramite una sonda su pianoforte digitale **Kawai CN301**. Ogni evento è un oggetto JSON annidato:

```json
{"type":"noteon","note":{"number":60,"rawAttack":74,"attack":0.583,"identifier":"C4"},"channel":1,"timestamp":22776.01,"rawBytes":[144,60,74]}
{"type":"noteoff","note":{"number":60,"rawRelease":112,"release":0.882,"identifier":"C4"},"channel":1,"timestamp":22895.99,"rawBytes":[128,60,112]}
{"type":"controlchange","controller":64,"value":127,"channel":1,"timestamp":12345.67,"rawBytes":[176,64,127]}
```

Campi rilevanti per le specifiche RML:

| Campo | Tipo | Significato |
| :--- | :--- | :--- |
| `type` | stringa | Tipo di evento: `'noteon'`, `'noteoff'`, `'controlchange'`, ecc. |
| `note.number` | int 0-127 | Numero MIDI della nota (C4 = 60, A0 = 21, C8 = 108). |
| `note.rawAttack` | int 0-127 | Velocity grezza di pressione. |
| `note.attack` | float 0-1 | Velocity normalizzata: $\text{attack} = \text{rawAttack} / 127$. |
| `note.rawRelease` | int 0-127 | Velocity grezza di rilascio (solo `noteoff`). |
| `note.identifier` | stringa | Nome scientifico della nota, es. `"C4"`. |
| `channel` | int 1-16 | Canale MIDI (numerazione webmidi 1-16; su filo i byte usano 0-15). |
| `timestamp` | float | Millisecondi da `performance.now()` (**non** epoch Unix). I vincoli temporali nelle specifiche operano su differenze relative di questo valore. |
| `controller`, `value` | int | Solo per `controlchange`: pedale di risonanza = `controller` 64, `value` 0 (rilasciato) oppure 127 (premuto). |
| `rawBytes` | array int | Byte MIDI grezzi su filo, es. `[144,60,74]` = `noteon` canale 1, nota 60, velocity 74. |

---

## 3. Scenario di Esecuzione: Offline / Post-Run

Un dettaglio fondamentale è che **il monitor registra gli eventi in tempo reale, ma il feedback viene calcolato ed elaborato solo alla fine dell'esecuzione** (o comunque a fine sessione di prova):

* **Latenza real-time irrilevante**: non essendoci la necessità di colorare lo spartito all'istante o interrompere l'utente mentre suona, le prestazioni del monitor non sono un fattore critico. Anche se l'elaborazione finale richiede 1-2 secondi, l'esperienza utente rimane eccellente.
* **Monitoraggio offline-first**: la traccia di eventi JSON raccolta durante l'esecuzione viene sottoposta al monitor RML compilato in **SWI-Prolog**, sia in modalità *offline* (riproduzione della traccia salvata) sia in modalità *online* (stream live con verdetto a fine brano). Non è richiesta alcuna esecuzione del monitor Prolog nel browser dell'utente: il componente di verifica può vivere nell'ambiente di sviluppo/analisi.

---

## 4. Sintassi RML: Riferimento Rapido

Le specifiche usate in questo documento si basano sulla sintassi ufficiale di RML (cfr. `RML_DOCS/02_GUIDA_INTRODUTTIVA.md`). Costrutti principali:

* **Tipi di evento per pattern matching**: `noteOn(num) matches {type:'noteon', note:{number:num}};`
* **Vincoli numerici**: `noteOnValid(num) matches noteOn(num) with num >= 21 && num <= 108;`
* **Tipi derivati**: `noteOn matches noteOn(_);` (overload di arità: `noteOn/0` deriva da `noteOn/1`)
* **Negazione**: `nonNote not matches noteOn(_) | noteOff(_);`
* **Operatori** (precedenza decrescente): concatenazione `A B` (giustapposizione), intersezione `A /\ B`, unione `A \/ B`, shuffle `A | B`; chiusura prefissa postfissa `Spec!`.
* **Costanti**: `empty` (traccia vuota), `any` (qualsiasi evento), `none` (nessun evento), `all` (qualsiasi traccia, abbreviazione di `any*`).
* **Operatori di Kleene derivati**: `*`, `+`, `?`.
* **Parametricità con variabili locali**: `{let num; noteOn(num) spec(num)}` — `let` dichiara variabili di dato il cui scope è delimitato dalle graffe; l'inizializzazione è guidata dal matching degli eventi.
* **Filtro**: `eventType >> Spec` — la traccia ristretta agli eventi che fanno match con `eventType` deve verificare `Spec`.
* **Specifiche generiche (state variables)**: `Counter<n> = noteOn Counter<n+1>;` — parametri con valori calcolati da espressioni.
* **Espressione condizionale**: `if (n>0) spec else empty;`
* **Verdetti a 4 valori**: **True**, **Maybe True**, **Maybe False**, **False** (i primi e gli ultimi conclusivi, quelli intermedi inconclusivi). Il suffisso `!` permette di considerare validi tutti i prefissi, abilitando verdetti *Maybe True* su specifiche ricorsive infinite.

---

## 5. Esempi Concreti di Implementazione in RML

Gli esempi seguenti assumono gli eventi webmidi della Sezione 2. Definizioni di base condivise (range della tastiera a 88 tasti: A0 = 21, C8 = 108):

```rml
// Tipi di evento di base (condivisi dagli esempi)
noteOn(num) matches {type:'noteon', note:{number:num}} with num >= 21 && num <= 108;
noteOff(num) matches {type:'noteoff', note:{number:num}} with num >= 21 && num <= 108;

noteOn matches noteOn(_);
noteOff matches noteOff(_);

noteEvent matches noteOn | noteOff;
nonNote not matches noteOn | noteOff;
```

### Esempio 1: Note fuori range (Pitch Range)

Qualsiasi nota suonata al di fuori del range 21-108 (estensione di un pianoforte a 88 tasti) è un errore di pitch o un artefatto dello strumento.

```rml
noteInRange(num) matches {type:'noteon', note:{number:num}} with num >= 21 && num <= 108;
noteOutOfRange not matches noteInRange(_);

// La traccia è corretta se contiene solo note in range;
// il primo evento fuori range produce verdetto False.
Main = noteInRange(_)*;
```

*Spiegazione*: il tipo `noteInRange(num)` incorpora il vincolo numerico direttamente nella clausola `with`. Appena arriva un `noteon` con `note.number` fuori da $[21, 108]$, il match fallisce e il monitor emette verdetto **False**.

---

### Esempio 2: Note "Ghost" (durata breve e velocity bassa)

Una nota *ghost* è una nota con velocity molto bassa (`rawAttack < 15`) tenuta premuta pochissimo ($t_{\text{off}} - t_{\text{on}} < 80\text{ ms}$). Vogliamo rilevarle per segnalare dita che "scivolano".

```rml
ghostOn(num,t,v) matches {type:'noteon', note:{number:num, rawAttack:v}, timestamp:t}
                         with v < 15;
ghostOff(num,t) matches {type:'noteoff', note:{number:num}, timestamp:t};
other not matches ghostOn(_,_,_) | ghostOff(_,_);

// Per OGNI nota debole premuta, se il rilascio della STESSA nota
// arriva entro 80ms, la ghost e' stata confermata (verdetto True);
// altrimenti il monitor resta in attesa (Maybe True).
Ghost = {let num, tOn, tOff;
         ghostOn(num,tOn,_)
         (other* ghostOff(num,tOff)
          with tOff - tOn < 80)}!;

Main = Ghost;
```

*Spiegazione*: `let` dichiara variabili locali il cui scope è delimitato dalle graffe; `num` viene legato al numero della nota dal primo match, e il vincolo `with` confronta i timestamp `performance.now()` dei due eventi. La chiusura prefissa `!` consente verdetti *Maybe True* mentre il monitor attende il `noteoff` corrispondente.

---

### Esempio 3: Precisione dell'Accordo (Chord Jitter < 50 ms)

Due note di un accordo (es. Do4 = 60 e Mi4 = 64) devono essere suonate quasi simultaneamente: $|t_1 - t_2| < 50\text{ ms}$, in qualunque ordine.

```rml
noteOnT(num,t) matches {type:'noteon', note:{number:num}, timestamp:t};

ChordJitter = {let t1, t2;
               // shuffle: le due note possono arrivare in ordine qualsiasi
               (noteOnT(60,t1) | noteOnT(64,t2))
               with abs(t1 - t2) < 50};
```

*Spiegazione*: l'operatore shuffle `|` accetta l'interleaving in entrambi gli ordini; la clausola `with` fallisce se lo scostamento supera i 50 ms, segnalando un'arpeggiatura involontaria.

---

### Esempio 4: Aderenza alla Dinamica (velocity di un *forte*)

Una nota segnata come *forte* sullo spartito (qui Do4 = 60) deve essere suonata con velocity sufficiente: $\text{rawAttack} \ge 80$.

```rml
strongNote(num,v) matches {type:'noteon', note:{number:num, rawAttack:v}}
                          with v >= 80;

// La verifica e' ristretta alle sole note Do4; gli altri eventi sono ignorati.
c4 matches {type:'noteon', note:{number:60}};

Main = c4 >> (strongNote(60,_) all);
```

*Spiegazione*: il filtro `>>` restringe l'analisi ai soli attacchi di Do4; per ciascuno, la velocity deve superare la soglia. Dopo il primo match riuscito, `all` permette al monitor di emettere verdetto **True** conclusivo per quell'istanza (il pattern va poi ricorsivamente generalizzato per più occorrenze con una specifica di tipo `(strongNote(60,_) other*)*`).

---

### Esempio 5: Pedale di Risonanza Sincopato (attivazione entro 200 ms dalla nota)

Il pedale deve essere premuto *subito dopo* l'attacco del tasto: `noteon` al tempo $t_1$, seguito da `controlchange` (controller 64, value 127) al tempo $t_2$ con $0 < t_2 - t_1 < 200\text{ ms}$.

```rml
noteOnT(t) matches {type:'noteon', timestamp:t};
pedalOn(t) matches {type:'controlchange', controller:64, value:127, timestamp:t};
other not matches noteOnT(_) | pedalOn(_);

PedalSincopato = {let t1, t2;
                  noteOnT(t1) other* pedalOn(t2)
                  with t2 > t1 && t2 - t1 < 200};

Main = PedalSincopato;
```

*Spiegazione*: `other*` tollera eventi intermedi (altre note) tra l'attacco e la pressione del pedale; il vincolo `with` verifica la finestra temporale del pedale sincopato. Se il pedale arriva troppo tardi (o prima della nota), il match fallisce.

---

## 6. Formalizzabilità delle Metriche in RML

Le metriche della Sezione 1 presentano gradi diversi di difficoltà di formalizzazione in RML:

### Facili (pattern matching + vincoli numerici su singolo evento)
* **Note fuori range / note errate**: tipo di evento con vincolo `with` su `note.number` (Esempio 1).
* **Aderenza alla dinamica**: vincolo su `note.rawAttack`/`note.attack` del singolo `noteon` (Esempio 4).
* **Attivazione/rilascio del pedale**: match diretto su `{type:'controlchange', controller:64, value:...}`.

### Medie (parametricità con `let`, confronto di due eventi correlati)
* **Note ghost**: richiede di legare il numero della nota e confrontare `noteon`/`noteoff` della stessa nota con vincoli su durata e velocity (Esempio 2). La difficoltà è gestire le note sovrapposte: servono istanze separate per ogni nota attiva, ottenibili con shuffle e `let` annidati.
* **Chord jitter**: shuffle di $n$ `noteon` con vincolo su max-min dei timestamp; per accordi di 3+ note il vincolo si esprime come catena di disuguaglianze (Esempio 3).
* **Pedale sincopato**: sequenza con tolleranza di eventi intermedi e vincolo sulla finestra temporale (Esempio 5).
* **Legato vs staccato**: delta tra `noteoff` della nota $N$ e `noteon` della nota $N+1$; formalizzabile con `let` su timestamp consecutivi, con segno del delta che discrimina le due articolazioni.

### Difficili (specifiche generiche con state variables e aggregazione)
* **Rapporto di durata IOI**: richiede di mantenere uno stato (timestamp dell'attacco precedente e valore ritmico nominale) e calcolare rapporti $r = \Delta t_{\text{osservato}} / \Delta t_{\text{nominale}}$; si formalizza con specifiche generiche tipo `IOI<tPrev, denom>` dove i parametri vengono aggiornati ricorsivamente (`Counter<n>-style`).
* **Stabilità del tempo (BPM drift)**: richiede aggregazione statistica su finestre di battiti (media mobile degli IOI). In RML puro questo è possibile ma verboso: conviene mantenere stato con parametri generici che accumulano conteggio e somma, oppure pre-elaborare la traccia in TypeScript e verificare in RML solo le soglie di deviazione.
* **Allineamento con lo spartito (note mancanti/errate rispetto al brano)**: è la metrica concettualmente più ricca, perché presuppone uno *score follower* che associa ogni evento alla posizione attesa sullo spartito. Strategia pragmatica: lo score following resta in TypeScript (OSMD), che emette eventi arricchiti `expected(nota, posizione)`; la specifica RML verifica poi solo la relazione tra `expected` e `noteon` osservati, riducendo il problema a una metrica media.

---

## 7. Pipeline di Sviluppo: da .rml a SWI-Prolog

Il flusso di lavoro effettivo per sviluppare e collaudare i monitor è:

```
events (webmidi, browser/probe) ──► events.json (traccia)
                                        │
cadenza-spec.rml ──► RML compiler ──► cadenza-spec.pl ──► SWI-Prolog
                     (ANTLR+Kotlin)     (trace expressions)   monitor
                                        │
                                        ▼
                                   verdict a 4 valori
                                   (True / Maybe True / Maybe False / False)
```

1. **Scrittura della specifica** in un file `.rml` con i tipi di evento webmidi della Sezione 2.
2. **Compilazione**: il compilatore RML ufficiale (basato su ANTLR + Kotlin) traduce la specifica in un file `.pl` contenente le *trace expressions* equivalenti.
3. **Esecuzione del monitor** in **SWI-Prolog**:
   * *offline*: la traccia `events.json` raccolta durante l'esecuzione viene riprodotta evento per evento contro il monitor, che emette il verdetto finale;
   * *online*: gli eventi vengono inviati al monitor man mano che arrivano, con verdetto aggiornato a ogni evento e resoconto a fine brano.
4. **Analisi del verdetto**: i verdetti inconclusivi (*Maybe True/False*) a fine traccia vengono interpretati in base alla chiusura prefissa `!` dichiarata nelle specifiche.

### Proof of Concept esistente

La directory `RML_DOCS/RML_TESTS/midi-probe/` contiene un proof of concept funzionante dell'intera pipeline:

| File | Ruolo |
| :--- | :--- |
| `probe.js` | Sonda Node.js che cattura gli eventi webmidi dal Kawai CN301 e li serializza in `events.json`. |
| `events.json` | Traccia reale raccolta (eventi nel formato della Sezione 2). |
| `piano-test.rml` | Specifica RML di esempio: tipi `noteOn(num)`/`noteOff(num)` con vincolo di range `num >= 21 && num <= 108`, tipi derivati `noteOn`/`noteOff`, e `Main = noteEvent*`. |
| `piano-test.pl` | Output del compilatore RML (trace expressions per SWI-Prolog). |
| `verdict.txt` | Verdetto emesso dal monitor SWI-Prolog sulla traccia. |

Questo PoC dimostra end-to-end che la catena probe → traccia → specifica → compilatore → monitor SWI-Prolog funziona con eventi reali dello strumento target.

---

## 8. Stato dell'Arte e Lavori Correlati

Per verificare se esistono ricerche simili sul web, si indicano i riferimenti scientifici e le parole chiave da utilizzare nei motori accademici (Google Scholar, ISMIR Archive):

### Query di Ricerca consigliate
* `"runtime verification" AND ("music" OR "MIDI" OR "piano")`
* `"temporal logic" AND "musical performance"`

### Lavori Correlati Esistenti
1. **Logiche Temporali in Musica**: molti lavori usano varianti di LTL (Linear Temporal Logic) e STL (Signal Temporal Logic) per formalizzare le regole della composizione e dell'improvvisazione jazz (es. all'Università di Udine), focalizzandosi sulle note "teoriche" corrette piuttosto che sul feedback esecutivo/didattico dell'allievo.
2. **Score Following (IRCAM / Antescofo)**: sistemi che ascoltano il musicista live e sincronizzano l'elettronica sul suo tempo. Sono pensati per la sincronizzazione delle performance live, non per validare la correttezza a fini didattici post-run. In Cadenza lo score following resta delegato al layer TypeScript/OSMD, mentre RML verifica le proprietà della traccia.
3. **App Didattiche Commerciali (Simply Piano, Skoove)**: usano algoritmi di allineamento MIDI proprietari, cablati nel codice dell'app. **La novità scientifica del tirocinio** è l'applicazione di un linguaggio di specifica formale e dichiarativo (RML) disaccoppiato dall'applicazione, che permette regole di verifica flessibili, componibili (shuffle, intersezione, filtri) e con semantica dei verdetti matematicamente definita.

---

## 9. Fonti Scientifiche e Bibliografia

1. **Timed Trace Expressions**: L. Ciccone, A. Ferrando, D. Ancona, V. Mascardi. *Timed Trace Expressions*. CILC 2019, Trieste. [Link PDF](http://ceur-ws.org/Vol-2396/paper19.pdf).
2. **Estensione RML Metric Time**: proposta di ricerca del Prof. Ferrando in collaborazione con D. Ancona. [Link Progetto](https://angeloferrando.github.io/website/thesis.html#fv).
3. **RML Foundational Paper**: D. Ancona, A. Ferrando, L. Franceschini, V. Mascardi. *RML: Theory and practice of a domain specific language for runtime verification*. Computer Languages, Systems & Structures, Vol. 53, 2018. [Link DOI](https://doi.org/10.1016/j.cl.2018.01.005).
4. **Guida ufficiale RML**: *An introductory guide to RML*, RMLatDIBRIS. [Link](https://rmlatdibris.github.io/rml.html) (contenuto estratto localmente in `RML_DOCS/02_GUIDA_INTRODUTTIVA.md`).
5. **Web MIDI API / webmidi v3**: documentazione della libreria webmidi (v3.x) per `Input.addListener` e struttura dell'oggetto `Note` (riferimento per il formato eventi della Sezione 2, verificato sperimentalmente su Kawai CN301).
