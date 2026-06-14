#!/usr/bin/env python3
"""Persistent (warm) panel-compute worker.

Reads one NDJSON request per line from stdin and writes one NDJSON response
per line to stdout, each carrying the request's `id` so the Node server can
match them. The heavy `waveform_panels` module (ObsPy/scipy/numpy) is
imported once at startup and stays resident, so each request avoids the
~1-2 s import cold-start that a fresh `python waveform_panels.py` paid.

Requests are handled on a small thread pool: FDSN fetches are I/O-bound, so
a slow fetch for one window doesn't block others. Responses may therefore
arrive out of order — that's why each carries its `id`.

Protocol:
    stdin  : {"id": 7, "nslc": "...", "startMs": ..., "durS": ..., ...}\n
    stdout : {"id": 7, "nslc": "...", "frames": {...}}\n   (or {"id":7,"error":..})
"""

from __future__ import annotations

import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import waveform_panels as wp
import waveform_fetch as wf

_out_lock = threading.Lock()


def _emit(obj):
    line = json.dumps(obj, separators=(",", ":"))
    with _out_lock:
        sys.stdout.write(line + "\n")
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
    pool = ThreadPoolExecutor(max_workers=3)
    try:
        for line in sys.stdin:
            line = line.strip()
            if line:
                pool.submit(_handle, line)
    except KeyboardInterrupt:
        pass
    finally:
        pool.shutdown(wait=False)


if __name__ == "__main__":
    main()
