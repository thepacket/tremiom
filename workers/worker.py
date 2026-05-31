#!/usr/bin/env python3
"""Tremiom unified seismic worker.

Single Python process that:

  1. Holds the SeedLink TCP connection to IRIS (or any FDSN seedlink server)
  2. Maintains a per-channel ring buffer of recent samples
  3. Runs the panel computers (helicorder, spectrogram, PSD, raw scope, …)
     on a timer thread and emits NDJSON frames on stdout

Spawning one Python process per panel-kind (the v0.0.1 sketch) would mean
N independent SeedLink connections to IRIS — bad citizen, wasted band-
width. One unified worker shares the connection and the buffer.

Protocol:

    stdin  NDJSON   {"op": "subscribe",   "station": "IU.ANMO.00.BHZ",
                     "panels": ["helicorder", "spectrogram", ...]}
                   {"op": "unsubscribe", "station": "..."}

    stdout NDJSON  {"frame": "panel", "panel": "spectrogram",
                    "station": "IU.ANMO.00.BHZ", "t": 1748736000.0,
                    "data": [...], ...}

If ObsPy is not installed (no `npm run workers:install` yet) the worker
falls back to synthetic-frame mode so the frontend stays usable.

Run standalone for debugging:

    python workers/worker.py
    # then on stdin:
    {"op":"subscribe","station":"IU.ANMO.00.BHZ","panels":["spectrogram","psd"]}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import threading
import time
from collections import defaultdict, deque
from typing import Deque, Dict, Set

# Optional scientific stack. The worker degrades gracefully without it.
try:
    import numpy as np
    from scipy import signal as scipy_signal
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False

try:
    from obspy.clients.seedlink.easyseedlink import create_client  # type: ignore
    HAS_OBSPY = True
except ImportError:
    HAS_OBSPY = False


# ── Configuration ──────────────────────────────────────────────────────────

SEEDLINK_HOST = "rtserve.iris.washington.edu"
SEEDLINK_PORT = 18000

RING_SECONDS = 120          # per-channel buffer length
SPECTROGRAM_WIN_S = 8.0     # STFT window for the spectrogram column
SPECTROGRAM_NPERSEG = 256
PSD_WIN_S = 60.0            # Welch window for the PSD panel
PSD_NPERSEG = 1024
RAW_SCOPE_WIN_S = 10.0
RAW_SCOPE_POINTS = 1024     # decimation target
HELICORDER_WIN_S = 60.0
HELICORDER_POINTS = 600

PANEL_TICK_HZ = 1.0


# ── Ring buffer ────────────────────────────────────────────────────────────

class RingBuffer:
    """Per-NSLC ring of (sample_rate, deque[float]).

    Thread-safe writes from the SeedLink callback thread, thread-safe reads
    from the panel timer thread.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buf: Dict[str, Deque[float]] = {}
        self._sr: Dict[str, float] = {}

    def write(self, nslc: str, sr: float, samples) -> None:
        with self._lock:
            if self._sr.get(nslc) != sr:
                self._buf[nslc] = deque(maxlen=int(RING_SECONDS * sr))
                self._sr[nslc] = sr
            self._buf[nslc].extend(samples)

    def snapshot(self, nslc: str, seconds: float):
        """Return (sample_rate, list[float]) of the most recent `seconds`."""
        with self._lock:
            sr = self._sr.get(nslc, 0.0)
            buf = self._buf.get(nslc)
            if not buf or sr <= 0:
                return 0.0, []
            n = int(min(len(buf), seconds * sr))
            if n <= 0:
                return sr, []
            return sr, list(buf)[-n:]


# ── Output ────────────────────────────────────────────────────────────────

_emit_lock = threading.Lock()


def emit(obj: dict) -> None:
    line = json.dumps(obj, separators=(",", ":"))
    with _emit_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[worker] {msg}\n")
    sys.stderr.flush()


# ── Panel computers ────────────────────────────────────────────────────────
#
# Each panel is a function `(nslc, ring) -> dict | None`. Returning None
# means "not enough data yet, skip this tick".

def panel_helicorder(nslc: str, ring: RingBuffer) -> dict | None:
    sr, data = ring.snapshot(nslc, HELICORDER_WIN_S)
    if not data:
        return None
    # Downsample to a fixed number of points by simple block-mean.
    if HAS_SCIPY and len(data) > HELICORDER_POINTS:
        arr = np.asarray(data, dtype=np.float32)
        block = len(arr) // HELICORDER_POINTS
        trimmed = arr[: block * HELICORDER_POINTS]
        ds = trimmed.reshape(HELICORDER_POINTS, block).mean(axis=1)
        out = ds.tolist()
    else:
        step = max(1, len(data) // HELICORDER_POINTS)
        out = data[::step][:HELICORDER_POINTS]
    return {
        "frame": "panel", "panel": "helicorder",
        "station": nslc, "t": time.time(),
        "sr": sr, "windowS": HELICORDER_WIN_S, "data": out,
    }


def panel_raw_scope(nslc: str, ring: RingBuffer) -> dict | None:
    sr, data = ring.snapshot(nslc, RAW_SCOPE_WIN_S)
    if not data:
        return None
    if HAS_SCIPY and len(data) > RAW_SCOPE_POINTS:
        arr = np.asarray(data, dtype=np.float32)
        ds = scipy_signal.decimate(
            arr, max(1, len(arr) // RAW_SCOPE_POINTS), ftype="fir",
        )
        out = ds[:RAW_SCOPE_POINTS].tolist()
    else:
        step = max(1, len(data) // RAW_SCOPE_POINTS)
        out = data[::step][:RAW_SCOPE_POINTS]
    return {
        "frame": "panel", "panel": "raw-scope",
        "station": nslc, "t": time.time(),
        "sr": sr, "windowS": RAW_SCOPE_WIN_S, "data": out,
    }


def panel_spectrogram(nslc: str, ring: RingBuffer) -> dict | None:
    if not HAS_SCIPY:
        return None
    sr, data = ring.snapshot(nslc, SPECTROGRAM_WIN_S)
    if not data or sr <= 0 or len(data) < SPECTROGRAM_NPERSEG:
        return None
    arr = np.asarray(data, dtype=np.float32)
    # Single-segment Welch is equivalent to the latest STFT column.
    f, pxx = scipy_signal.welch(
        arr, fs=sr, nperseg=min(SPECTROGRAM_NPERSEG, len(arr)),
        scaling="density", detrend="constant",
    )
    # Convert to dB and clip to a sensible floor.
    db = 10.0 * np.log10(np.maximum(pxx, 1e-30))
    return {
        "frame": "panel", "panel": "spectrogram",
        "station": nslc, "t": time.time(),
        "fMinHz": float(f[0]), "fMaxHz": float(f[-1]),
        "data": db.astype(np.float32).tolist(),
    }


def panel_psd(nslc: str, ring: RingBuffer) -> dict | None:
    if not HAS_SCIPY:
        return None
    sr, data = ring.snapshot(nslc, PSD_WIN_S)
    if not data or sr <= 0 or len(data) < PSD_NPERSEG:
        return None
    arr = np.asarray(data, dtype=np.float32)
    f, pxx = scipy_signal.welch(
        arr, fs=sr, nperseg=min(PSD_NPERSEG, len(arr)),
        scaling="density", detrend="linear",
    )
    db = 10.0 * np.log10(np.maximum(pxx, 1e-30))
    return {
        "frame": "panel", "panel": "psd",
        "station": nslc, "t": time.time(),
        "fMinHz": float(f[0]), "fMaxHz": float(f[-1]),
        "data": db.astype(np.float32).tolist(),
    }


PANELS = {
    "helicorder":  panel_helicorder,
    "spectrogram": panel_spectrogram,
    "raw-scope":   panel_raw_scope,
    "psd":         panel_psd,
}


# ── Subscription registry ──────────────────────────────────────────────────

_subs_lock = threading.Lock()
_subscriptions: Dict[str, Set[str]] = defaultdict(set)  # station -> set of panel ids


# ── SeedLink ingestion (real mode) ─────────────────────────────────────────

def start_seedlink(ring: RingBuffer):
    """Connect to IRIS SeedLink and stream into the ring buffer.

    Returns the easyseedlink client object (or None if ObsPy isn't installed).
    """
    if not HAS_OBSPY:
        log("ObsPy not available — running in SYNTHETIC mode "
            "(`npm run workers:install` to enable real data)")
        return None

    def on_data(trace):  # obspy Trace
        nslc = (f"{trace.stats.network}.{trace.stats.station}."
                f"{trace.stats.location}.{trace.stats.channel}")
        ring.write(nslc, float(trace.stats.sampling_rate),
                   trace.data.tolist())

    client = create_client(
        f"{SEEDLINK_HOST}:{SEEDLINK_PORT}",
        on_data=on_data,
    )
    log(f"connecting to seedlink {SEEDLINK_HOST}:{SEEDLINK_PORT}")
    threading.Thread(target=client.run, name="seedlink", daemon=True).start()
    return client


# ── Synthetic ingestion (fallback when ObsPy missing) ──────────────────────

def start_synthetic(ring: RingBuffer):
    """Generate sinusoid+noise samples for any subscribed station."""
    SR = 40.0  # Hz, mimics broadband Z channel

    def run():
        t0 = time.time()
        while True:
            t = time.time() - t0
            with _subs_lock:
                stations = list(_subscriptions.keys())
            if stations:
                # 1 second's worth of samples per tick.
                n = int(SR)
                base = np.arange(n) / SR + t
                # Multi-tone "earthquake-like" signal.
                samples = (
                    50 * np.sin(2 * math.pi * 0.5 * base) +
                    20 * np.sin(2 * math.pi * 2.3 * base) +
                    10 * np.sin(2 * math.pi * 7.1 * base) +
                    np.random.default_rng().standard_normal(n) * 5
                ).astype(np.float32).tolist() if HAS_SCIPY else [
                    50 * math.sin(2 * math.pi * 0.5 * (t + i / SR)) +
                    20 * math.sin(2 * math.pi * 2.3 * (t + i / SR)) +
                    10 * math.sin(2 * math.pi * 7.1 * (t + i / SR))
                    for i in range(int(SR))
                ]
                for st in stations:
                    ring.write(st, SR, samples)
            time.sleep(1.0)

    threading.Thread(target=run, name="synthetic", daemon=True).start()


# ── stdin command loop ────────────────────────────────────────────────────

def cmd_loop(client) -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        op = msg.get("op")
        station = msg.get("station", "")
        if op == "subscribe":
            panels = set(msg.get("panels") or PANELS.keys())
            with _subs_lock:
                _subscriptions[station] |= panels
            log(f"+sub {station} panels={sorted(panels)}")
            if client is not None:
                try:
                    net, sta, _loc, cha = station.split(".")
                    client.select_stream(net, sta, cha)
                except ValueError:
                    log(f"bad station id {station!r}")
        elif op == "unsubscribe":
            with _subs_lock:
                _subscriptions.pop(station, None)
            log(f"-sub {station}")


# ── Panel timer thread ────────────────────────────────────────────────────

def panel_loop(ring: RingBuffer) -> None:
    period = 1.0 / PANEL_TICK_HZ
    while True:
        t0 = time.time()
        with _subs_lock:
            snapshot = {st: set(panels) for st, panels in _subscriptions.items()}
        for station, panels in snapshot.items():
            for pid in panels:
                fn = PANELS.get(pid)
                if not fn:
                    continue
                try:
                    frame = fn(station, ring)
                except Exception as e:
                    log(f"{pid}({station}) failed: {e!r}")
                    continue
                if frame is not None:
                    emit(frame)
        elapsed = time.time() - t0
        time.sleep(max(0.0, period - elapsed))


# ── Entry ─────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--synthetic", action="store_true",
                    help="force synthetic ingestion even if ObsPy is present")
    args = ap.parse_args()

    log(f"start  obspy={HAS_OBSPY}  scipy={HAS_SCIPY}  "
        f"synthetic={args.synthetic or not HAS_OBSPY}")

    ring = RingBuffer()
    if args.synthetic or not HAS_OBSPY:
        if not HAS_SCIPY:
            log("warning: scipy missing — spectrogram & PSD will be skipped")
        start_synthetic(ring)
        seedlink_client = None
    else:
        seedlink_client = start_seedlink(ring)

    threading.Thread(target=panel_loop, args=(ring,),
                     name="panels", daemon=True).start()

    # cmd_loop blocks the main thread on stdin.
    cmd_loop(seedlink_client)


if __name__ == "__main__":
    main()
