#!/usr/bin/env python3
"""Tremiom SeedLink ingestor.

Connects to one or more SeedLink servers (IRIS by default), subscribes to
the channels requested by the multiplexer, and maintains a per-channel
ring buffer of recent samples. Other worker processes (panel computers)
read window snapshots out of these buffers and produce panel frames.

For v0.1 the ingestor and panel computers run in the SAME Python
process to keep IPC trivial. We'll split them when load demands it.

Protocol (stdin / stdout, NDJSON):

    stdin:   {"op": "subscribe",   "station": "IU.ANMO.00.BHZ"}
             {"op": "unsubscribe", "station": "IU.ANMO.00.BHZ"}

    stdout:  {"frame": "tick", "station": "IU.ANMO.00.BHZ",
              "t": 1748736000.0, "sr": 40.0, "n": 40, "data": [...]}

Run standalone:  python workers/ingestor.py
"""

from __future__ import annotations

import json
import sys
import threading
from collections import deque
from typing import Deque, Dict

try:
    from obspy.clients.seedlink.easyseedlink import create_client  # type: ignore
except ImportError:
    sys.stderr.write(
        "obspy not installed — run `npm run workers:install`\n"
    )
    sys.exit(1)


SEEDLINK_HOST = "rtserve.iris.washington.edu"
SEEDLINK_PORT = 18000

# Ring buffer length in seconds per channel.
RING_SECONDS = 600


class RingBuffer:
    """Simple per-channel ring buffer keyed by NSLC string."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buffers: Dict[str, Deque[float]] = {}
        self._sample_rates: Dict[str, float] = {}

    def write(self, nslc: str, sr: float, samples) -> None:
        with self._lock:
            buf = self._buffers.get(nslc)
            if buf is None or self._sample_rates.get(nslc) != sr:
                buf = deque(maxlen=int(RING_SECONDS * sr))
                self._buffers[nslc] = buf
                self._sample_rates[nslc] = sr
            buf.extend(samples)

    def snapshot(self, nslc: str, seconds: float) -> tuple[float, list[float]]:
        with self._lock:
            buf = self._buffers.get(nslc)
            sr = self._sample_rates.get(nslc, 0.0)
            if not buf or sr == 0:
                return 0.0, []
            n = int(min(len(buf), seconds * sr))
            return sr, list(buf)[-n:]


RING = RingBuffer()


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def on_data(trace) -> None:  # obspy Trace
    nslc = f"{trace.stats.network}.{trace.stats.station}." \
           f"{trace.stats.location}.{trace.stats.channel}"
    RING.write(nslc, float(trace.stats.sampling_rate), trace.data.tolist())
    # Hand a small tick to the multiplexer too. v0.1 keeps it modest.
    emit({
        "frame": "tick",
        "station": nslc,
        "t": float(trace.stats.starttime.timestamp),
        "sr": float(trace.stats.sampling_rate),
        "n": int(len(trace.data)),
    })


def cmd_loop(client) -> None:
    """Read NDJSON commands on stdin and route to the SeedLink client."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        op = msg.get("op")
        station = msg.get("station", "")
        try:
            net, sta, loc, cha = station.split(".")
        except ValueError:
            continue
        if op == "subscribe":
            client.select_stream(net, sta, cha)
            sys.stderr.write(f"[ingestor] +subscribe {station}\n")
        elif op == "unsubscribe":
            # easyseedlink has no unsubscribe; track in v0.2.
            sys.stderr.write(f"[ingestor] (ignored) -unsubscribe {station}\n")


def main() -> None:
    client = create_client(
        f"{SEEDLINK_HOST}:{SEEDLINK_PORT}",
        on_data=on_data,
    )
    # Start the command loop in a background thread; the SeedLink client
    # blocks the main thread once `run()` is called.
    threading.Thread(target=cmd_loop, args=(client,), daemon=True).start()
    sys.stderr.write(
        f"[ingestor] connecting to {SEEDLINK_HOST}:{SEEDLINK_PORT}\n"
    )
    client.run()


if __name__ == "__main__":
    main()
