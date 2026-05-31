#!/usr/bin/env python3
"""Tremiom panel computer (v0.1 — stub).

v0.1 generates synthetic frames so the frontend can be developed without
a SeedLink connection. The real implementation pulls windows from the
shared ring buffer (see ingestor.py) and runs ObsPy DSP.

Usage:
    python workers/panels.py --panel <id>

Stdin protocol:
    {"op": "subscribe",   "station": "IU.ANMO.00.BHZ"}
    {"op": "unsubscribe", "station": "..."}

Stdout protocol (NDJSON):
    {"frame": "panel", "panel": "spectrogram", "station": "...",
     "t": 1748736000.0, "data": [...]}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import threading
import time
from typing import Set


STATIONS: Set[str] = set()
_lock = threading.Lock()


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def cmd_loop() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        with _lock:
            if msg.get("op") == "subscribe":
                STATIONS.add(msg["station"])
            elif msg.get("op") == "unsubscribe":
                STATIONS.discard(msg["station"])


# ── Synthetic frame generators ────────────────────────────────────────────

def gen_helicorder(station: str, t: float) -> dict:
    # 60 samples of a slow sine + noise
    data = [
        math.sin(2 * math.pi * (t + i / 60.0) * 0.05) * 100
        + (math.sin(i * 1.3) * 20)
        for i in range(600)
    ]
    return {"frame": "panel", "panel": "helicorder", "station": station,
            "t": t, "data": data}


def gen_spectrogram(station: str, t: float) -> dict:
    bins = 128
    # Drifting peak, looks like a chirp.
    peak = (math.sin(t * 0.1) * 0.4 + 0.5) * bins
    data = [
        -150 + 80 * math.exp(-((b - peak) ** 2) / (2 * 8 ** 2))
        for b in range(bins)
    ]
    return {"frame": "panel", "panel": "spectrogram", "station": station,
            "t": t, "fMinHz": 0.0, "fMaxHz": 20.0, "data": data}


def gen_raw_scope(station: str, t: float) -> dict:
    n = 1024
    data = [
        math.sin(2 * math.pi * (t + i / 100.0) * 1.0) * 50
        + math.sin(2 * math.pi * (t + i / 100.0) * 4.7) * 15
        for i in range(n)
    ]
    return {"frame": "panel", "panel": "raw-scope", "station": station,
            "t": t, "data": data}


def gen_psd(station: str, t: float) -> dict:
    bins = 256
    data = [-180 + 40 * math.exp(-((b - 60) ** 2) / (2 * 30 ** 2))
            + (math.sin(t * 0.2 + b * 0.1) * 2)
            for b in range(bins)]
    return {"frame": "panel", "panel": "psd", "station": station,
            "t": t, "fMinHz": 0.01, "fMaxHz": 50.0, "data": data}


GENERATORS = {
    "helicorder":  gen_helicorder,
    "spectrogram": gen_spectrogram,
    "raw-scope":   gen_raw_scope,
    "psd":         gen_psd,
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--panel", required=True, choices=sorted(GENERATORS.keys()))
    ap.add_argument("--rate-hz", type=float, default=1.0)
    args = ap.parse_args()

    gen = GENERATORS[args.panel]
    threading.Thread(target=cmd_loop, daemon=True).start()

    period = 1.0 / args.rate_hz
    sys.stderr.write(f"[panels:{args.panel}] up\n")
    while True:
        t = time.time()
        with _lock:
            subs = list(STATIONS)
        for st in subs:
            emit(gen(st, t))
        time.sleep(period)


if __name__ == "__main__":
    main()
