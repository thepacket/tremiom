#!/usr/bin/env python3
"""Persistent (warm) panel-compute worker.

Reads one NDJSON request per line from stdin and writes one NDJSON response
per line to stdout, each carrying the request's `id` so the Node server can
match them. The heavy `waveform_panels` / `waveform_fetch` modules
(ObsPy/scipy/numpy) are imported once at startup and stay resident, so each
request avoids the ~1-2 s import cold-start a fresh process would pay; the
FDSN client is reused too (warm connection).

Requests are processed one at a time, in order. That keeps it simple and
robust — ObsPy's FDSN client is not thread-safe, and on the single-CPU VM
there's nothing to gain from overlapping CPU-bound scipy work. Each request
is fast (~0.1-0.8 s with the warm client), so brief queuing is fine.

`readline()` (not `for line in sys.stdin`) is used so a request is handled
as soon as its line arrives, without stdin read-ahead buffering.

Protocol:
    stdin  : {"id": 7, "op": "waveform"|<panels>, ...}\n
    stdout : {"id": 7, ...result}\n   (or {"id": 7, "error": ...})
"""

from __future__ import annotations

import json
import sys

import waveform_panels as wp
import waveform_fetch as wf


def _emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _handle(line):
    try:
        req = json.loads(line)
    except Exception:
        return
    rid = req.get("id")
    try:
        if req.get("op") == "waveform":
            result = wf.run_waveform(req)   # History envelope
        else:
            result = wp.run_panels(req)     # analysis panels
    except Exception as e:  # never let one request kill the worker
        result = {"error": f"{e!r}"}
    result["id"] = rid
    _emit(result)


def main():
    while True:
        line = sys.stdin.readline()
        if not line:          # EOF — parent closed the pipe
            break
        line = line.strip()
        if line:
            _handle(line)


if __name__ == "__main__":
    main()
