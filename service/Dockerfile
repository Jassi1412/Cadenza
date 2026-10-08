# Servizio unico di Cadenza: Python (pipeline) + SWI-Prolog (verdetti) nella
# stessa immagine. Non ne servono altri.
#
# Il verdetto arriva a fine esecuzione, quindi niente streaming e niente stato
# sul server: si riceve l'esecuzione, si gira join.py, si lancia sette volte
# swipl in batch e si rispondono sette exit code. Il frontend non fa round-trip
# per ogni tasto.
#
# USO LOCALE
#   docker build -f service/Dockerfile -t cadenza-service .
#   docker run -e PORT=8080 -p 8080:8080 cadenza-service
#   curl -X POST localhost:8080/ -H 'Content-Type: application/json' -d @req.json
#
# ── Stage 1: i .rml diventano Prolog ────────────────────
# I .pl NON sono nel repo (.gitignore li esclude) e non devono esserlo: due copie
# della stessa regola divergono appena una viene modificata, e se dimentichi di
# ricompilare il servizio valuta la versione vecchia senza avvisare nessuno.
# Qui nascono dai .rml, che sono l'unica fonte.
#
# Il compiler e' vendorizzato in vendor/rml-compiler/ (37 MB) invece di essere
# ricostruito con Gradle a ogni build: Gradle scarica ~300 MB di dipendenze e su
# Render Free rischia di mangiare il tempo di build. Costo: se aggiorni RML,
# ricopia i jar. L'output e' verificato identico byte per byte a quello di Gradle.
#
# Java serve solo in questo stage: l'immagine finale non lo contiene.
FROM eclipse-temurin:21-jdk AS specs

COPY vendor/rml-compiler/ /opt/rmlc/
COPY RML_DOCS/RML_TESTS/metrics/ /src/

RUN set -e; \
    mkdir -p /specs; \
    # git non conserva il bit di esecuzione sui clone fatti da Windows: senza
    # questo chmod il launcher arriva non eseguibile e muore con "Permission
    # denied", exit 126. Non fidarsi del bit, impostarlo qui.
    chmod +x /opt/rmlc/bin/rml-compiler; \
    for f in /src/*.rml; do \
        /opt/rmlc/bin/rml-compiler --input "$f" --output "/specs/$(basename "$f" .rml).pl"; \
    done; \
    n=$(ls -1 /specs/*.pl | wc -l); \
    echo "specifiche compilate: $n"; \
    test "$n" -eq 7 || { echo "ATTESE 7, TROVATE $n"; exit 1; }

# ── Stage 2: runtime ────────────────────────────────────
# Immagine Python minimale: il verdetto e' in Prolog, il resto e' lettura dello
# spartito. Non serve piu' nessun motore di allineamento audio, quindi niente
# torch, niente librosa: le dipendenze sono elencate esplicitamente in
# requirements.txt, cosi' Render le ricostruisce da zero a ogni build.
FROM python:3.12-slim

# swi-prolog-nox e' il pacchetto Debian di SWI-Prolog senza interfaccia grafica.
# `swipl/swipl:stable` NON esiste su Docker Hub: pull access denied. Verificato.
RUN apt-get update && apt-get install -y --no-install-recommends swi-prolog-nox \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# Prima le dipendenze, cosi' il layer si riusa finche' non cambiano.
COPY service/requirements.txt /opt/requirements.txt
RUN pip install --no-cache-dir -r /opt/requirements.txt

COPY RML_DOCS/RML_TESTS/monitor/ /opt/rml/
COPY --from=specs /specs/             /opt/specs/
COPY alignment/join.py   /opt/join.py
COPY alignment/server.py /opt/server.py
COPY service/batch.pl     /opt/batch.pl

# Una specifica mancante o vuota deve far fallire la build, non produrre un
# servizio che risponde "conforme" perche' non ha guardato niente.
RUN test "$(ls -1 /opt/specs/*.pl | wc -l)" -eq 7 \
 && ! grep -qs ':- dynamic' /opt/specs/*.pl \
 && for f in /opt/specs/*.pl; do test -s "$f"; done

ENV RML_MONITOR=/opt/rml
ENV RML_SPECS=/opt/specs
ENV PORT=8080

# ── Thread: la cosa piu' importante di questo file ──────────────────
# OpenBLAS e OpenMP decidono quanti thread creare leggendo i core della
# macchina che ha fatto la build, non quelli del container che la esegue.
# Su Render l'istanza free ha poco meno di un core: lanciano una dozzina di
# thread che si contendono lo stesso core e il throughput crolla.
#
# Con un solo thread la costruzione della traccia resta nell'ordine del
# secondo, che e' la velocita' che si misura in locale. Nessun costo, una riga.
ENV OMP_NUM_THREADS=1
ENV OPENBLAS_NUM_THREADS=1
ENV MKL_NUM_THREADS=1
ENV NUMBA_NUM_THREADS=1

EXPOSE 8080

# Render comanda via CMD, non ENTRYPOINT.
CMD ["python", "/opt/server.py"]