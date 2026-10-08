"""Endpoint unico di Cadenza: riceve l'esecuzione, restituisce i sette verdetti.

Il browser, a fine brano, manda lo spartito in MusicXML, l'elenco degli eventi
che sono usciti da WebMIDI e il tempo al quale ha suonato. Qui lo spartito viene
letto, le aspettative vengono messe accanto a quello che e' realmente successo,
e i sette exit code dei monitor RML vengono letti.

Il verdetto e' interamente in Prolog: questo file non contiene nessuna soglia,
nessuna classificazione, nessun giudizio. Fa solo il lavoro di trasporto.

Uso
    PORT=8080 python server.py
    curl -X POST localhost:8080/ -H 'Content-Type: application/json' -d @req.json

    req.json  {"score": "<musicxml ...>",
               "notes": [{"time_ms":0,"dur_ms":250,"pitch":60,"velocity":90}],
               "control_changes": [{"time_ms":0,"controller":64,"value":127}],
               "tempo_factor": 1.0}
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

from join import ScoreModel, join, to_jsonl

MONITOR = os.environ.get("RML_MONITOR", "/opt/rml")
SPECS = os.environ.get("RML_SPECS", "/opt/specs")
# batch.pl sta accanto a server.py: stessa directory, quindi stesso ROOT.
ROOT = os.path.dirname(os.path.abspath(__file__))

# Le sette metriche. Ogni nome e' anche il file <nome>.pl in SPECS.
METRICS = ("articulation", "chord-jitter", "dynamics-adherence", "pedal-toggle",
           "pitch-agreement", "pitch-range", "syncopated-pedal")

# Tetto di richiesta. Uno spartito reale e' 90 KB; 2 MB lascia spazio per
# spartiti corposi senza dare a un chiamante spazio per far saturare l'istanza
# da solo, che su Render Free e' 512 MB condivisi con tutto il resto.
MAX_BODY = 2 * 1024 * 1024


def read_tempo_factor(body):
    """Quanti millisecondi reali vale un millisecondo scritto nello spartito.

    Lo manda la pagina, che e' il posto dove l'utente sceglie il tempo con lo
    slider: 1 se suona al tempo scritto, 2 se suona a meta' velocita'. Se il
    campo manca o ha un valore che non ha senso, si torna al tempo scritto
    invece di rifiutare la richiesta: e' un valore che cambia solo la scala dei
    tempi, e perdere una prova intera per quello sarebbe peggio.
    """
    try:
        f = float(body.get("tempo_factor", 1.0))
    except (TypeError, ValueError):
        return 1.0
    if not np.isfinite(f) or f <= 0:
        return 1.0
    return f


def validate(body):
    """Controllo di ingresso. Questa e' una frontiera fidata: il corpo arriva
    da un browser, non da noi."""
    if not isinstance(body.get("score"), str) or "<" not in body.get("score", ""):
        raise ValueError("manca lo spartito MusicXML")
    notes = body.get("notes")
    if not isinstance(notes, list) or not notes:
        raise ValueError("nessuna nota suonata")
    out = []
    for n in notes:
        if not isinstance(n, dict):
            raise ValueError("nota malformata")
        try:
            out.append({"time_ms": float(n["time_ms"]), "dur_ms": float(n["dur_ms"]),
                        "pitch": int(n["pitch"]), "velocity": int(n["velocity"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("nota malformata: servono time_ms, dur_ms, pitch, velocity")
    cc = []
    for c in body.get("control_changes") or []:
        try:
            cc.append({"time_ms": float(c["time_ms"]),
                       "controller": int(c["controller"]), "value": int(c["value"])})
        except (KeyError, TypeError, ValueError):
            raise ValueError("control change malformato")
    return out, cc


def analyse(body):
    notes, cc = validate(body)

    with tempfile.TemporaryDirectory() as tmp:
        score = os.path.join(tmp, "score.musicxml")
        trace = os.path.join(tmp, "trace.jsonl")
        with open(score, "w", encoding="utf-8") as f:
            f.write(body["score"])

        model = ScoreModel.from_musicxml(score)
        events = join(model, notes, read_tempo_factor(body), cc)
        with open(trace, "w", encoding="utf-8") as f:
            f.write(to_jsonl(events) + "\n")

        # Le sette specifiche in un solo processo Prolog. Un processo SWI-Prolog
        # regge una sola specifica RML (match/2 viene importata in `user`, e
        # importarne una seconda nella stessa VM fallisce), quindi qui si
        # caricano e si scaricano una alla volta dentro la stessa VM: le
        # clausole sono identiche, cambia solo quante volte si avvia
        # l'interprete. batch.pl se ne occupa e scrive "<nome> <exit>" per riga.
        # exit 0 = traccia conforme, 1 = violata.
        specs = []
        for name in METRICS:
            specs += [name, os.path.join(SPECS, "%s.pl" % name)]
        proc = subprocess.run(
            ["swipl", "-O", "-p", "monitor=%s" % MONITOR,
             os.path.join(ROOT, "batch.pl"), "--", trace] + specs,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        verdicts = {}
        for line in proc.stdout.decode().splitlines():
            parts = line.split()
            if len(parts) != 2 or parts[0] not in METRICS:
                continue
            name, code = parts
            verdicts[name] = (code == "0", int(code), "")
        for name in METRICS:
            if name not in verdicts:
                verdicts[name] = (False, 2, proc.stderr.decode()[-400:])
        return verdicts, events


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        # Il frontend sta su Vercel, il servizio su Render: domini diversi.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        self._send(200, {"service": "cadenza", "metrics": list(METRICS)})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self._send(413, {"error": "corpo fuori dai limiti"})
            body = json.loads(self.rfile.read(n))
            verdicts, events = analyse(body)
            self._send(200, {
                "events": len(events),
                "verdicts": {k: {"ok": v[0], "exit": v[1]} for k, v in verdicts.items()},
                "stderr": {k: v[2] for k, v in verdicts.items() if v[2].strip()},
            })
        except Exception as e:
            traceback.print_exc()
            self._send(400, {"error": "%s: %s" % (type(e).__name__, e)})

    def log_message(self, fmt, *a):
        sys.stderr.write("[cadenza] " + fmt % a + "\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", 8080))), Handler).serve_forever()