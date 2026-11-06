%% batch.pl ' le sette specifiche in un solo processo SWI-Prolog.
%%
%% Perch' esiste: il server lancia sette processi separati, uno per metrica.
%% Su un'istanza piccola l'avvio di Prolog costa circa un secondo ciascuno: sette
%% secondi fissi su ogni richiesta, anche quando l'allineamento ' istantaneo.
%% Misurato con mezza CPU e la stessa traccia: sette processi 1958 ms, un
%% processo 604 ms.
%%
%% Non ' una riforma del metodo: le clausole sono quelle che produce
%% rml-compiler, cambia solo quante volte si avvia l'interprete. I verdetti
%% devono restare identici, ed ' quello che va verificato a ogni modifica.
%%
%% Ogni specifica compilata dichiara il modulo `spec`, che non pu' essere
%% ridefinito finch' resta caricato: fra una specifica e l'altra il file va
%% scaricato, altrimenti il caricamento successivo muore con "No permission to
%% redefine module `spec'". Non si tentano retractall, perch' le clausole che
%% use_module porta in `user` sono statiche e non modificabili a runtime.
%%
%% `verify/2`, `verify/3` e `verify_end/1` arrivano da monitor.pl di RML@DIBRIS
%% (MIT, RML_DOCS/RML_TESTS/monitor/LICENSE): quel file ' uno script con
%% `:- initialization(main)`, quindi importarlo eseguirebbe il main e farebbe le
%% verifiche da solo. Sono le tre sole procedure servono (monitor.pl righe
%% 83-116), in versione silenziosa: il server vuole il codice di uscita, non
%% l'elenco degli eventi.
%%
%% I nomi delle metriche li passa Python, alternati al percorso del file: sono
%% gi' noti l', e ricavarli quiparsingando il percorso ' fragile.
%%
%% Uso: swipl -O -p monitor=<dir> batch.pl -- <traccia.jsonl> <nome1> <spec1.pl> [<nome2> <spec2.pl> ...]
%% Una riga per specifica: "<nome> <exit>", dove 0 = conforme, 1 = violata,
%% 2 = errore. Quando una regola risulta violata la riga continua con gli indici
%% (0-based, lo stesso ordine della traccia) degli eventi su cui la macchina si
%% e' fermata: "<nome> 1 7 19 40". Sono il punto in cui l'allievo ha sbagliato,
%% e servono alla pagina per colorare di rosso LA nota giusta invece di dire
%% solo "una di queste sette regole e' saltata". Il codice di uscita continua a
%% venire dalla passata intera, identica a prima: gli indici sono un'aggiunta,
%% non un ripensamento del verdetto.
%%
%% Perche' servono piu' passaggi, e perche' il primo non basta: la macchina di
%% RML si ferma alla prima nota che non riesce a leggere (monitor.pl riga 115
%% stampa "unmatched event #Id" esattamente prima di arrendersi). Per colorare
%% TUTTI gli errori bisogna ripartire con l'espressione iniziale dalla riga
%% successiva a quella incriminata e cercare il prossimo arresto. Ogni ripartenza
%% salta via gli eventi che non interessano alla regola, perche' la semantica di
%% next/3 lascia passare quelli che non c'entrano niente, quindi la seconda
%% caccia non inventa violazioni che la prima non aveva visto: al piu' ne trova
%% oltre, e comunque solo su regole gia' giudicate violate. Il costo e' una
%% passata per errore trovato, su tracce di qualche centinaia di eventi: si ferma
%% a 40 indici per regola, perche' colorare quattrocento note non aiuta nessuno
%% e il tempo su un'istanza da mezza CPU non e' un dettaglio.

:- use_module(library(http/json)).
:- use_module(monitor(trace_expressions_semantics)).
:- initialization(main).

main :-
    current_prolog_flag(argv, [TraceFile | Rest]),
    Rest \== [],
    pair_up(Rest, Pairs),
    open_trace(TraceFile, Stream),
    forall(member(Name-Spec, Pairs), run_one(Name, Spec, Stream)),
    close(Stream),
    halt(0).

main :-
    format("batch.pl: attesi <traccia.jsonl> poi coppie <nome> <specifica.pl>~n"),
    halt(2).

pair_up([], []).
pair_up([Name, Spec | Rest], [Name-Spec | Pairs]) :-
    pair_up(Rest, Pairs).

open_trace(TraceFile, Stream) :-
    catch(open(TraceFile, read, Stream), Error, trace_error(2, Error)).

%% Una specifica: carica, prendi l'espressione, verifica, riporta, scarica.
run_one(Name, SpecFile, Stream) :-
    seek(Stream, 0, bof, _),
    (   catch(( load_spec(SpecFile, TraceExp),
                (   verify(Stream, TraceExp)
                ->  Exit = 0, Ids = []
                ;   Exit = 1, collect_ids(Stream, TraceExp, Ids) )),
              Error, ( print_message(error, Error), Exit = 2, Ids = [] ))
    ->  true
    ;   Exit = 2, Ids = []
    ),
    unload_spec(SpecFile),
    format("~w ~w", [Name, Exit]),
    forall(member(I, Ids), (write(' '), write(I))),
    nl.

%% -------------------------------------------------- i punti della violazione

%% Tetto di indici per regola. Non e' pigrizia: una traccia senza pedale per
%% tutto il brano si ferma una volta per attacco, e colorare trecento note non
%% dice all'allievo niente di piu' delle prime quaranta. Ferma qui la caccia,
%% non il verdetto, che arriva dalla passata intera.
max_ids(40).

collect_ids(Stream, ExpInit, Ids) :-
    collect_ids(Stream, ExpInit, 0, [], Rev),
    reverse(Rev, Ids).

collect_ids(Stream, ExpInit, Skip, Acc, Rev) :-
    length(Acc, N),
    max_ids(Max),
    (   N >= Max
    ->  Rev = Acc
    ;   catch(run_from(Stream, ExpInit, Skip, Outcome), _Error, Outcome = end_of_trace),
        (   Outcome = stuck(Line)
        ->  Acc2 = [Line|Acc], NextSkip is Line + 1,
            collect_ids(Stream, ExpInit, NextSkip, Acc2, Rev)
        ;   Rev = Acc
        )
    ).

%% Avanza la macchina saltando i primi Skip eventi della traccia e riporta dove
%% si e' fermata: conform se da li' in fondo va tutto bene, end_of_trace se la
%% traccia finisce mentre un evento era ancora atteso (e' una regola che vuole
%% qualcosa in coda: non ha una nota precisa da incolpare), stuck(Line) con Line
%% indice 0-based dell'evento che la macchina non e' riuscita a leggere.
run_from(Stream, ExpInit, Skip, Outcome) :-
    seek(Stream, 0, bof, _),
    feed(Stream, ExpInit, 0, Skip, Outcome).

feed(Stream, Exp, Line, Skip, Outcome) :-
    json_read_dict(Stream, Event, [end_of_file(@(eof))]),
    (   Event == @(eof)
    ->  (   may_halt(Exp) -> Outcome = conform
        ;   Outcome = end_of_trace )
    ;   Line < Skip
    ->  NextLine is Line + 1, feed(Stream, Exp, NextLine, Skip, Outcome)
    ;   (   next(Exp, Event, NewExp)
        ->  NextLine is Line + 1, feed(Stream, NewExp, NextLine, Skip, Outcome)
        ;   Outcome = stuck(Line)
        )
    ).

load_spec(SpecFile, TraceExp) :-
    use_module(SpecFile),
    trace_expression(_, TraceExp).

unload_spec(SpecFile) :-
    catch(unload_file(SpecFile), _, true).

trace_error(Exit, _) :- format("~w ~w~n", ['monitor', Exit]).

%% '' da monitor.pl (RML@DIBRIS, MIT), versione silenziosa ''''''''''''''

verify_end(TraceExp) :- may_halt(TraceExp) -> true ; fail.

verify(TraceStream, TraceExp) :-
    catch(
        ( reject -> \+ verify(TraceStream, TraceExp, 1) ; verify(TraceStream, TraceExp, 1) ),
        error(syntax_error(json(illegal_json)), _),
        fail).

verify(TraceStream, TraceExp, EventId) :-
    json_read_dict(TraceStream, Event, [end_of_file(@(eof))]),
    (   Event == @(eof) -> verify_end(TraceExp)
    ;   next(TraceExp, Event, NewTraceExp)
    ->  NextEventId is EventId + 1,
        verify(TraceStream, NewTraceExp, NextEventId)
    ;   fail
    ).

%% Senza --reject l'esecuzione non conforme ' un normale fallimento.
reject :- fail.
