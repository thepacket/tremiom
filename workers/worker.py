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
import os
import socket
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

# Per-network SeedLink upstream routing. AM stations (Raspberry Shake
# citizen seismometers) live on a different SeedLink server than the
# IRIS/EarthScope global network; everything else (IU, II, GE, IV, US,
# AU, NZ, …) is on IRIS rtserve.
DEFAULT_SEEDLINK = ("rtserve.iris.washington.edu", 18000)
NETWORK_UPSTREAMS: Dict[str, tuple] = {
    "AM": ("data.raspberryshake.org", 18000),
}

RING_SECONDS = 120          # per-channel buffer length

# Helicorder drum — 24 hours of envelope buckets per channel.
DRUM_HOURS = 24
DRUM_ROWS = 24                                  # one row per hour
DRUM_COLS_PER_ROW = 600                         # ~6 s per column at 1 h/row
DRUM_BUCKET_S = (DRUM_HOURS * 3600) // (DRUM_ROWS * DRUM_COLS_PER_ROW)  # = 6 s
DRUM_N_BUCKETS = DRUM_ROWS * DRUM_COLS_PER_ROW  # = 14 400

# PPSD (probabilistic PSD) — accumulating frequency × dB histogram.
PPSD_SEGMENT_S  = 60.0   # length of each PSD segment added to the histogram
PPSD_INTERVAL_S = 60.0   # how often a new segment is added
PPSD_F_BINS  = 100       # log-spaced frequency bins (0.01 – 50 Hz)
PPSD_DB_BINS = 60        # linear dB bins
PPSD_DB_MIN  = -200
PPSD_DB_MAX  = 100

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


class DrumHistory:
    """24-hour envelope history for the helicorder drum panel.

    Stores per-channel min/max amplitude in fixed 6-second buckets indexed
    by absolute unix time. Each bucket lives in a slot
    `(bucket_time // DRUM_BUCKET_S) % DRUM_N_BUCKETS` of a NumPy array;
    when a write lands in a slot whose recorded time is older than the new
    bucket time, the slot is reset. This is how the circular buffer "ages
    out" old data as wall time advances.

    Both the SeedLink callback (real-time tail) and the FDSN backfill
    thread (historical fill) call `write()` with the same shape. The drum
    panel computer reads the latest 24 h in time order via `snapshot()`.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._chan: Dict[str, dict] = {}

    @staticmethod
    def _bucket_t(t: float) -> int:
        return int(t // DRUM_BUCKET_S) * DRUM_BUCKET_S

    @staticmethod
    def _slot(bt: int) -> int:
        return (bt // DRUM_BUCKET_S) % DRUM_N_BUCKETS

    def _channel(self, nslc: str) -> dict:
        c = self._chan.get(nslc)
        if c is None:
            c = {
                "mins":       np.full(DRUM_N_BUCKETS, np.nan, dtype=np.float32) if HAS_SCIPY else None,
                "maxs":       np.full(DRUM_N_BUCKETS, np.nan, dtype=np.float32) if HAS_SCIPY else None,
                # RSAM needs mean(|x|) per bucket — track sum(|x|) and the
                # sample count so the mean can be reconstructed and bins
                # can be aggregated correctly across buckets.
                "sumabs":     np.zeros(DRUM_N_BUCKETS, dtype=np.float64) if HAS_SCIPY else None,
                "cnt":        np.zeros(DRUM_N_BUCKETS, dtype=np.int64) if HAS_SCIPY else None,
                "bt":         np.zeros(DRUM_N_BUCKETS, dtype=np.int64) if HAS_SCIPY else None,
                "last_write": 0.0,
            }
            self._chan[nslc] = c
        return c

    def write(self, nslc: str, t_start: float, sr: float, samples) -> None:
        if not HAS_SCIPY or sr <= 0:
            return
        arr = np.asarray(samples, dtype=np.float32)
        if arr.size == 0:
            return
        ts  = t_start + np.arange(arr.size) / sr
        bts = (ts // DRUM_BUCKET_S).astype(np.int64) * DRUM_BUCKET_S
        unique_bts, inverse = np.unique(bts, return_inverse=True)

        with self._lock:
            c = self._channel(nslc)
            c["last_write"] = max(c["last_write"],
                                  float(t_start + arr.size / sr))
            for k, bt in enumerate(unique_bts):
                sub = arr[inverse == k]
                lo, hi = float(sub.min()), float(sub.max())
                # RSAM uses mean(|x|) with the per-bucket mean removed so
                # a DC offset doesn't inflate the amplitude. Demean here.
                sabs = float(np.abs(sub - sub.mean()).sum())
                n_sub = int(sub.size)
                slot = self._slot(int(bt))
                if c["bt"][slot] != bt:
                    c["mins"][slot]   = lo
                    c["maxs"][slot]   = hi
                    c["sumabs"][slot] = sabs
                    c["cnt"][slot]    = n_sub
                    c["bt"][slot]     = int(bt)
                else:
                    if lo < c["mins"][slot]: c["mins"][slot] = lo
                    if hi > c["maxs"][slot]: c["maxs"][slot] = hi
                    c["sumabs"][slot] += sabs
                    c["cnt"][slot]    += n_sub

    def snapshot(self, nslc: str, now: float):
        """Return (start_bt, mins, maxs) covering the past 24 h in time
        order, oldest first. NaN where no data was ever written."""
        if not HAS_SCIPY:
            return None
        with self._lock:
            c = self._chan.get(nslc)
            if c is None:
                return None
            end_bt   = self._bucket_t(now)
            start_bt = end_bt - (DRUM_N_BUCKETS - 1) * DRUM_BUCKET_S
            # Vector lookup: slot for every bucket time we want.
            wanted = start_bt + np.arange(DRUM_N_BUCKETS, dtype=np.int64) * DRUM_BUCKET_S
            slots  = (wanted // DRUM_BUCKET_S) % DRUM_N_BUCKETS
            mins   = np.full(DRUM_N_BUCKETS, np.nan, dtype=np.float32)
            maxs   = np.full(DRUM_N_BUCKETS, np.nan, dtype=np.float32)
            present = c["bt"][slots] == wanted
            mins[present] = c["mins"][slots[present]]
            maxs[present] = c["maxs"][slots[present]]
            return int(start_bt), mins, maxs

    def rsam_snapshot(self, nslc: str, now: float, bin_s: int):
        """RSAM = mean(|x|) aggregated into `bin_s`-second bins over the
        past 24 h. `bin_s` is rounded to a multiple of DRUM_BUCKET_S.
        Returns (start_bt, bin_s_effective, values[]) where values are
        per-bin mean-abs amplitude, NaN for bins with no samples."""
        if not HAS_SCIPY:
            return None
        buckets_per_bin = max(1, round(bin_s / DRUM_BUCKET_S))
        bin_s_eff = buckets_per_bin * DRUM_BUCKET_S
        with self._lock:
            c = self._chan.get(nslc)
            if c is None:
                return None
            end_bt   = self._bucket_t(now)
            start_bt = end_bt - (DRUM_N_BUCKETS - 1) * DRUM_BUCKET_S
            wanted = start_bt + np.arange(DRUM_N_BUCKETS, dtype=np.int64) * DRUM_BUCKET_S
            slots  = (wanted // DRUM_BUCKET_S) % DRUM_N_BUCKETS
            present = c["bt"][slots] == wanted
            sumabs = np.where(present, c["sumabs"][slots], 0.0)
            cnt    = np.where(present, c["cnt"][slots],    0)
            # Aggregate consecutive buckets into bins: bin mean-abs =
            # total |x| over the bin / total samples in the bin.
            n_bins = DRUM_N_BUCKETS // buckets_per_bin
            usable = n_bins * buckets_per_bin
            sa = sumabs[:usable].reshape(n_bins, buckets_per_bin).sum(axis=1)
            ct = cnt[:usable].reshape(n_bins, buckets_per_bin).sum(axis=1)
            with np.errstate(invalid="ignore", divide="ignore"):
                vals = np.where(ct > 0, sa / np.maximum(ct, 1), np.nan)
            return int(start_bt), int(bin_s_eff), vals


# Module-level DrumHistory singleton. Panels + SeedLink callback + the
# backfill thread all write/read from this one instance.
DRUM = DrumHistory()


class PPSDStore:
    """Accumulating PSD histogram per NSLC for the probabilistic-PSD panel.

    Bins frequency (log-spaced 0.01–50 Hz, 100 bins) × power (linear
    dB, -200…+100, 60 bins). Each new 60-s segment computes one Welch
    PSD and increments the cells along the resulting curve. The panel
    function reads the histogram; the frontend renders it as a 2-D
    heatmap with NLNM/NHNM reference curves on top.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._chan: Dict[str, dict] = {}
        if HAS_SCIPY:
            self._f_edges = np.logspace(np.log10(0.01), np.log10(50), PPSD_F_BINS + 1)
            self._f_centers = np.sqrt(self._f_edges[:-1] * self._f_edges[1:])
            self._db_edges = np.linspace(PPSD_DB_MIN, PPSD_DB_MAX, PPSD_DB_BINS + 1)
            self._db_centers = (self._db_edges[:-1] + self._db_edges[1:]) / 2

    def _channel(self, nslc: str) -> dict:
        c = self._chan.get(nslc)
        if c is None:
            c = {
                "hist":             (np.zeros((PPSD_F_BINS, PPSD_DB_BINS), dtype=np.int32)
                                     if HAS_SCIPY else None),
                "n_segments":       0,
                "last_segment_at":  0.0,
            }
            self._chan[nslc] = c
        return c

    def add_segment(self, nslc: str, samples, sr: float) -> None:
        if not HAS_SCIPY or sr <= 0 or len(samples) < int(sr * 10):
            return
        arr = np.asarray(samples, dtype=np.float64)
        try:
            f, pxx = scipy_signal.welch(
                arr, fs=sr,
                nperseg=min(len(arr), max(256, int(sr * 4))),
                scaling="density", detrend="linear",
            )
        except Exception as e:
            log(f"ppsd({nslc}) welch failed: {e!r}")
            return
        if len(f) < 2:
            return
        # Drop DC bin so log axis works.
        f = f[1:]; pxx = pxx[1:]
        db = 10.0 * np.log10(np.maximum(pxx, 1e-30))
        f_idx  = np.digitize(f,  self._f_edges)  - 1
        db_idx = np.digitize(db, self._db_edges) - 1
        valid = ((f_idx  >= 0) & (f_idx  < PPSD_F_BINS) &
                 (db_idx >= 0) & (db_idx < PPSD_DB_BINS))
        with self._lock:
            c = self._channel(nslc)
            # np.add.at allows scattered increments; cheaper than a Python loop.
            np.add.at(c["hist"], (f_idx[valid], db_idx[valid]), 1)
            c["n_segments"]      += 1
            c["last_segment_at"]  = time.time()
            # Keep the latest segment's curve so the panel can draw a
            # bright line over the heatmap — that gives a useful display
            # on segment 1, before enough segments have accumulated for
            # the histogram to read on its own.
            c["latest_f"]  = f.astype(np.float32).tolist()
            c["latest_db"] = db.astype(np.float32).tolist()

    def snapshot(self, nslc: str):
        if not HAS_SCIPY:
            return None
        with self._lock:
            c = self._chan.get(nslc)
            if c is None or c["n_segments"] == 0:
                return None
            return {
                "f_centers":  self._f_centers.tolist(),
                "db_centers": self._db_centers.tolist(),
                "hist":       c["hist"].tolist(),
                "n_segments": int(c["n_segments"]),
                "latest_f":   c.get("latest_f")  or [],
                "latest_db":  c.get("latest_db") or [],
            }


PPSD = PPSDStore()


def _get_noise_models():
    """Return Peterson 1993 NLNM/NHNM reference curves via ObsPy. Cached
    after first call. {nlnm:{periods, db}, nhnm:{periods, db}} or None."""
    if not HAS_OBSPY:
        return None
    cached = getattr(_get_noise_models, "_cache", None)
    if cached is not None:
        return cached
    try:
        from obspy.signal.spectral_estimation import get_nlnm, get_nhnm
        l_p, l_db = get_nlnm()
        h_p, h_db = get_nhnm()
        cached = {
            "nlnm": {"periods": list(map(float, l_p)), "db": list(map(float, l_db))},
            "nhnm": {"periods": list(map(float, h_p)), "db": list(map(float, h_db))},
        }
    except Exception as e:
        log(f"noise models unavailable: {e!r}")
        cached = None
    _get_noise_models._cache = cached
    return cached


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
    data = apply_filter(data, sr, nslc)
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
    data, unit_label = preprocess(data, sr, nslc)
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
        "sr": sr, "windowS": RAW_SCOPE_WIN_S, "unit": unit_label, "data": out,
    }


def panel_spectrogram(nslc: str, ring: RingBuffer) -> dict | None:
    if not HAS_SCIPY:
        return None
    sr, data = ring.snapshot(nslc, SPECTROGRAM_WIN_S)
    if not data or sr <= 0 or len(data) < SPECTROGRAM_NPERSEG:
        return None
    data = apply_filter(data, sr, nslc)
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


SPECTRUM_WIN_S = 8.0    # window for the instantaneous FFT


def panel_spectrum(nslc: str, ring: RingBuffer) -> dict | None:
    """Instantaneous amplitude spectrum — |FFT| of the current window,
    updated live. Distinct from the spectrogram (rolling 2-D time-freq
    heatmap) and PSD (Welch-averaged power): this is the single live
    magnitude curve, the seismic equivalent of an audio spectrum
    analyzer (Swarm's "spectra" wave-view)."""
    if not HAS_SCIPY:
        return None
    sr, data = ring.snapshot(nslc, SPECTRUM_WIN_S)
    if not data or sr <= 0 or len(data) < 64:
        return None
    data = apply_filter(data, sr, nslc)
    arr = np.asarray(data, dtype=np.float64)
    arr = arr - arr.mean()
    # Hann window to suppress spectral leakage, then rFFT magnitude.
    win = np.hanning(len(arr))
    spec = np.fft.rfft(arr * win)
    freqs = np.fft.rfftfreq(len(arr), d=1.0 / sr)
    # Amplitude spectrum in dB (20·log10|X|), normalized by window sum.
    mag = np.abs(spec) / (win.sum() / 2.0)
    db = 20.0 * np.log10(np.maximum(mag, 1e-12))
    return {
        "frame": "panel", "panel": "spectrum",
        "station": nslc, "t": time.time(),
        "fMinHz": float(freqs[0]), "fMaxHz": float(freqs[-1]),
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


def panel_drum(nslc: str, _ring: RingBuffer) -> dict | None:
    """Helicorder drum panel — 24 h of min/max envelope buckets in time
    order, anchored to the current wall clock. Reads from the module-
    level DRUM instance (the SeedLink callback writes there)."""
    snap = DRUM.snapshot(nslc, time.time())
    if snap is None:
        return None
    start_bt, mins, maxs = snap
    # Allow rendering even if mostly NaN — the frontend handles empty
    # buckets — but skip if literally no bucket has ever been written
    # (avoid spamming all-NaN frames when a station was just subscribed).
    if not np.any(np.isfinite(mins)):
        return None
    return {
        "frame":   "panel",
        "panel":   "drum",
        "station": nslc,
        "t":       time.time(),
        "startMs": int(start_bt * 1000),
        "endMs":   int((start_bt + DRUM_N_BUCKETS * DRUM_BUCKET_S) * 1000),
        "rows":    DRUM_ROWS,
        "cols":    DRUM_COLS_PER_ROW,
        "bucketS": DRUM_BUCKET_S,
        # NaN -> None so JSON survives. Buckets without data render as a gap.
        "min": [None if not np.isfinite(v) else float(v) for v in mins],
        "max": [None if not np.isfinite(v) else float(v) for v in maxs],
    }


RSAM_BIN_S = 60   # 1-minute bins over 24 h → 1440 points


def panel_rsam(nslc: str, _ring: RingBuffer) -> dict | None:
    """RSAM (Real-time Seismic Amplitude Measurement) — mean |ground
    motion| in fixed time bins over the past 24 h. The volcano-
    monitoring community's primary tracker: a sustained rise flags
    tremor / eruption onset that individual events on the drum can
    miss. Reads the mean-abs accumulators in DrumHistory."""
    snap = DRUM.rsam_snapshot(nslc, time.time(), RSAM_BIN_S)
    if snap is None:
        return None
    start_bt, bin_s, vals = snap
    if not np.any(np.isfinite(vals)):
        return None
    return {
        "frame":   "panel",
        "panel":   "rsam",
        "station": nslc,
        "t":       time.time(),
        "startMs": int(start_bt * 1000),
        "binS":    int(bin_s),
        "data":    [None if not np.isfinite(v) else float(v) for v in vals],
    }


PARTICLE_MOTION_WIN_S = 30.0      # rolling window the hodogram covers
PARTICLE_MOTION_POINTS = 500      # target number of (N, E) pairs sent


def three_comp_siblings(nslc: str) -> list[str]:
    """Return *candidate* Z + horizontal NSLCs given any channel of a
    station. Most modern IRIS GSN stations (IU.ANMO and many others) use
    the unoriented 1/2 naming for horizontals — the sensor isn't
    perfectly aligned and the network publishes the actual azimuth in
    station metadata instead of relabelling the channels. So we ask for
    both naming schemes — N/E and 1/2 — and the SeedLink server simply
    ignores the ones that don't exist. The particle-motion panel reads
    whichever pair actually has data."""
    try:
        net, sta, loc, cha = nslc.split(".")
    except ValueError:
        return []
    if len(cha) != 3:
        return []
    base = cha[:-1]
    return [
        f"{net}.{sta}.{loc}.{base}Z",
        f"{net}.{sta}.{loc}.{base}N",
        f"{net}.{sta}.{loc}.{base}E",
        f"{net}.{sta}.{loc}.{base}1",
        f"{net}.{sta}.{loc}.{base}2",
    ]


def horizontal_pair(nslc: str, ring: RingBuffer, win_s: float):
    """Pick whichever horizontal pair has data in the ring buffer for
    this station: prefer N/E, fall back to 1/2. Returns
    (chN_label, chE_label, sr, n_data, e_data) or None if neither pair
    is populated."""
    try:
        net, sta, loc, cha = nslc.split(".")
    except ValueError:
        return None
    if len(cha) != 3:
        return None
    base = cha[:-1]
    for n_suffix, e_suffix in (("N", "E"), ("1", "2")):
        n_nslc = f"{net}.{sta}.{loc}.{base}{n_suffix}"
        e_nslc = f"{net}.{sta}.{loc}.{base}{e_suffix}"
        sr_n, n_data = ring.snapshot(n_nslc, win_s)
        sr_e, e_data = ring.snapshot(e_nslc, win_s)
        if n_data and e_data:
            return (n_suffix, e_suffix, min(sr_n, sr_e), n_data, e_data)
    return None


def panel_particle_motion(nslc: str, ring: RingBuffer) -> dict | None:
    """Particle motion hodogram — the trajectory of horizontal ground
    motion. Auto-picks N/E or 1/2 (whichever the station actually
    streams), aligns the two by length, decimates, and ships parallel
    arrays the frontend draws as a 2D path."""
    pair = horizontal_pair(nslc, ring, PARTICLE_MOTION_WIN_S)
    if pair is None:
        return None
    n_suffix, e_suffix, sr, n_data, e_data = pair
    if sr <= 0:
        return None
    n = min(len(n_data), len(e_data))
    if n < 32:
        return None
    n_data = n_data[-n:]
    e_data = e_data[-n:]
    # Reconstruct sibling NSLCs to apply the active filter (filters are
    # keyed per-NSLC server-side; the user picks BHZ, the worker also
    # filters BHN/BHE — or BH1/BH2 — with the same spec so the panel
    # reflects whatever band is dialed in).
    parts = nslc.split(".")
    net, sta, loc, cha = parts
    base = cha[:-1]
    n_nslc = f"{net}.{sta}.{loc}.{base}{n_suffix}"
    e_nslc = f"{net}.{sta}.{loc}.{base}{e_suffix}"
    # Make sure the horizontal channels inherit the Z channel's filter.
    with _subs_lock:
        z_spec = _filters.get(nslc)
        if z_spec:
            _filters[n_nslc] = z_spec
            _filters[e_nslc] = z_spec
    n_data = apply_filter(n_data, sr, n_nslc)
    e_data = apply_filter(e_data, sr, e_nslc)
    step = max(1, n // PARTICLE_MOTION_POINTS)
    n_out = [float(v) for v in n_data[::step][:PARTICLE_MOTION_POINTS]]
    e_out = [float(v) for v in e_data[::step][:PARTICLE_MOTION_POINTS]]
    return {
        "frame":   "panel",
        "panel":   "particle-motion",
        "station": nslc,
        "t":       time.time(),
        "windowS": PARTICLE_MOTION_WIN_S,
        "n":       n_out,
        "e":       e_out,
        "chN":     f"{base}{n_suffix}",
        "chE":     f"{base}{e_suffix}",
    }


THREE_COMP_WIN_S = 30.0
THREE_COMP_POINTS = 800


def panel_three_comp(nslc: str, ring: RingBuffer) -> dict | None:
    """3-component scope — Z, N(/1), E(/2) traces stacked in one panel
    over a common time window. The standard way to look at a teleseism:
    you see the same arrival on all three components and read the wave
    type from how the energy partitions (vertical-dominant P, horizontal
    -dominant S/surface). Auto-subscribes alongside the picked Z channel
    via three_comp_siblings (same path particle-motion uses)."""
    try:
        net, sta, loc, cha = nslc.split(".")
    except ValueError:
        return None
    if len(cha) != 3:
        return None
    base = cha[:-1]
    z_nslc = f"{net}.{sta}.{loc}.{base}Z"

    # Vertical.
    sr_z, z_data = ring.snapshot(z_nslc, THREE_COMP_WIN_S)
    # Horizontals (N/E or 1/2, whichever streams).
    pair = horizontal_pair(nslc, ring, THREE_COMP_WIN_S)
    if not z_data and pair is None:
        return None

    comps = []
    unit_label = "counts"
    with _subs_lock:
        z_spec = _filters.get(nslc)
        z_units = _units.get(nslc)

    def decimate(d):
        n = len(d)
        step = max(1, n // THREE_COMP_POINTS)
        return [float(v) for v in d[::step][:THREE_COMP_POINTS]]

    if z_data and sr_z > 0:
        zf, unit_label = preprocess(z_data, sr_z, z_nslc)
        comps.append({"label": f"{base}Z", "data": decimate(zf)})
    if pair is not None:
        n_suffix, e_suffix, sr_h, n_data, e_data = pair
        n_nslc = f"{net}.{sta}.{loc}.{base}{n_suffix}"
        e_nslc = f"{net}.{sta}.{loc}.{base}{e_suffix}"
        # Horizontals inherit the Z channel's filter + units.
        with _subs_lock:
            if z_spec:
                _filters[n_nslc] = z_spec; _filters[e_nslc] = z_spec
            if z_units:
                _units[n_nslc] = z_units; _units[e_nslc] = z_units
        nf, ul = preprocess(n_data, sr_h, n_nslc)
        ef, _  = preprocess(e_data, sr_h, e_nslc)
        unit_label = ul
        comps.append({"label": f"{base}{n_suffix}", "data": decimate(nf)})
        comps.append({"label": f"{base}{e_suffix}", "data": decimate(ef)})
    if not comps:
        return None
    return {
        "frame":   "panel",
        "panel":   "three-comp",
        "station": nslc,
        "t":       time.time(),
        "windowS": THREE_COMP_WIN_S,
        "unit":    unit_label,
        "components": comps,
    }


STA_WIN_S = 1.0   # short-term-average window
LTA_WIN_S = 10.0  # long-term-average window
STA_LTA_VIEW_S = 60.0   # how much history to ship to the client per frame
STA_LTA_THRESHOLD = 3.0 # standard trigger threshold for teleseismic-ish data


def panel_sta_lta(nslc: str, ring: RingBuffer) -> dict | None:
    """STA/LTA trigger ratio — the classic event-detection time series.

    A short-term-average of |signal| divided by a long-term-average:
    spikes when an arrival hits because STA reacts fast while LTA still
    reflects the pre-event background. Anything above ~3-5 is the
    standard "trigger" threshold; the client shades those regions red.
    """
    if not HAS_SCIPY:
        return None
    sr, data = ring.snapshot(nslc, STA_LTA_VIEW_S + LTA_WIN_S)
    if not data or sr <= 0:
        return None
    sta_n = max(1, int(STA_WIN_S * sr))
    lta_n = max(sta_n + 1, int(LTA_WIN_S * sr))
    if len(data) < lta_n + 1:
        return None
    data = apply_filter(data, sr, nslc)
    arr = np.abs(np.asarray(data, dtype=np.float32))
    # Rolling sums via cumsum.
    cs = np.cumsum(np.concatenate([[0.0], arr]))
    sta = (cs[sta_n:] - cs[:-sta_n]) / sta_n         # len N - sta_n + 1
    lta = (cs[lta_n:] - cs[:-lta_n]) / lta_n         # len N - lta_n + 1
    # Align ends so the i-th element corresponds to sample i + lta_n - 1.
    offset = lta_n - sta_n
    sta_aligned = sta[offset:]
    ratio = sta_aligned / np.maximum(lta, 1e-9)
    # Decimate to a manageable point count for transport / drawing.
    target = 1024
    step = max(1, len(ratio) // target)
    out = ratio[::step][:target].astype(np.float32)
    sr_out = sr / step
    return {
        "frame":     "panel",
        "panel":     "sta-lta",
        "station":   nslc,
        "t":         time.time(),
        "windowS":   STA_LTA_VIEW_S,
        "staWinS":   STA_WIN_S,
        "ltaWinS":   LTA_WIN_S,
        "threshold": STA_LTA_THRESHOLD,
        "sr":        float(sr_out),
        "data":      [float(v) for v in out],
    }


PANELS = {
    "helicorder":  panel_helicorder,
    "spectrogram": panel_spectrogram,
    "raw-scope":   panel_raw_scope,
    "psd":         panel_psd,
    "drum":        panel_drum,
    "rsam":        panel_rsam,
    "spectrum":    panel_spectrum,
    "sta-lta":     panel_sta_lta,
    "three-comp":  panel_three_comp,
    "particle-motion": panel_particle_motion,
    "ppsd":         None,  # bound below (definition uses PPSD instance)
}


def panel_ppsd(nslc: str, _ring: RingBuffer) -> dict | None:
    """Probabilistic PSD — heatmap of PSD vs frequency, accumulated over
    every minute of streamed data. NLNM/NHNM reference curves attached
    (frontend draws them as overlays). Returns None until at least one
    PSD segment has been added (typically ~60 s after subscribe)."""
    snap = PPSD.snapshot(nslc)
    if snap is None:
        return None
    out = {
        "frame":      "panel",
        "panel":      "ppsd",
        "station":    nslc,
        "t":          time.time(),
        "fHz":        snap["f_centers"],
        "dbCenters":  snap["db_centers"],
        "hist":       snap["hist"],
        "nSegments":  snap["n_segments"],
        "latestF":    snap["latest_f"],
        "latestDb":   snap["latest_db"],
    }
    # NLNM/NHNM reference models live in the displacement-PSD regime
    # (-200 … -100 dB). We're computing PSD on raw counts (~+30 … +60
    # dB), so the noise-model curves would fall off the chart entirely.
    # Skip them until v0.2.x adds instrument response removal; the
    # frontend handles the missing fields gracefully.
    return out


PANELS["ppsd"] = panel_ppsd


# ── Subscription registry ──────────────────────────────────────────────────

_subs_lock = threading.Lock()
_subscriptions: Dict[str, Set[str]] = defaultdict(set)  # station -> set of panel ids
_filters: Dict[str, dict] = {}                          # station -> filter spec
_units:   Dict[str, str]  = {}                          # station -> output units

# Output-unit options. "counts" = raw (no response removal). The rest
# need the StationXML response, fetched lazily per station.
UNIT_VEL   = "velocity"       # m/s   (output="VEL")
UNIT_DISP  = "displacement"   # m     (output="DISP")
UNIT_ACC   = "acceleration"   # m/s²  (output="ACC")
UNIT_WA    = "wood-anderson"  # mm    (Wood-Anderson displacement, for ML)
UNIT_LABELS = {
    "counts": "counts", UNIT_VEL: "m/s", UNIT_DISP: "m",
    UNIT_ACC: "m/s²", UNIT_WA: "mm (WA)",
}

# Per-station ObsPy Inventory cache. None = fetch attempted and failed
# (so we don't retry every tick); absent = not yet fetched.
_inv_lock = threading.Lock()
_inventories: Dict[str, "object | None"] = {}

# Wood-Anderson standard poles/zeros (gain 2080, damping 0.8, T0 0.8 s).
_WA_PAZ = {
    "poles": [-6.283 - 4.7124j, -6.283 + 4.7124j],
    "zeros": [0j, 0j],
    "gain": 1.0,
    "sensitivity": 2080.0,
}


def _station_key(nslc: str) -> str:
    """Inventory is keyed by NET.STA (one fetch covers all channels)."""
    p = nslc.split(".")
    return f"{p[0]}.{p[1]}" if len(p) >= 2 else nslc


def fetch_inventory(nslc: str):
    """Fetch + cache the response-level StationXML for this station.
    Returns an ObsPy Inventory or None. Network call; call off the hot
    path (it's invoked lazily from convert_units, guarded by the cache)."""
    if not HAS_OBSPY:
        return None
    key = _station_key(nslc)
    with _inv_lock:
        if key in _inventories:
            return _inventories[key]
    if "SSL_CERT_FILE" not in os.environ:
        try:
            import certifi
            os.environ["SSL_CERT_FILE"] = certifi.where()
        except ImportError:
            pass
    inv = None
    try:
        from obspy.clients.fdsn import Client as FdsnClient
        from obspy import UTCDateTime
        net, sta = key.split(".")
        # Derive the band+instrument code (e.g. "BH") from the channel so
        # we only fetch the seismic broadband/short-period channels, and
        # constrain to the currently-operating epoch (starttime=now) so
        # we don't pull every historical channel epoch — that's the
        # difference between ~3 channels and ~700, i.e. <2 s vs ~50 s.
        cha = nslc.split(".")[3] if len(nslc.split(".")) >= 4 else "BH?"
        band_inst = (cha[:2] + "?") if len(cha) >= 2 else "BH?"
        now = UTCDateTime()
        client = FdsnClient("IRIS", timeout=30)
        inv = client.get_stations(network=net, station=sta,
                                  channel=band_inst, starttime=now,
                                  level="response")
        log(f"inventory[{key}/{band_inst}]: fetched "
            f"({len(inv.get_contents()['channels'])} channels)")
    except Exception as e:
        log(f"inventory[{key}]: fetch failed: {e!r}")
        inv = None
    with _inv_lock:
        _inventories[key] = inv
    return inv


def convert_units(data: list, sr: float, nslc: str):
    """Convert raw counts to the active physical units for this station.
    Returns (data, unit_label). Falls back to ('counts') if units are
    raw, ObsPy/inventory unavailable, or anything errors."""
    units = _units.get(nslc, "counts")
    if units == "counts" or not HAS_OBSPY or sr <= 0 or len(data) < 64:
        return data, UNIT_LABELS.get(units, "counts")
    inv = fetch_inventory(nslc)
    if inv is None:
        return data, "counts"   # response unavailable — show raw, labelled honestly
    try:
        from obspy import Trace, UTCDateTime
        net, sta, loc, cha = nslc.split(".")
        tr = Trace(data=np.asarray(data, dtype=np.float64))
        tr.stats.network = net; tr.stats.station = sta
        tr.stats.location = loc; tr.stats.channel = cha
        tr.stats.sampling_rate = sr
        tr.stats.starttime = UTCDateTime(time.time() - len(data) / sr)
        tr.attach_response(inv)
        pre_filt = [0.005, 0.01, 0.45 * sr, 0.5 * sr]
        if units == UNIT_WA:
            tr.remove_response(output="DISP", pre_filt=pre_filt, water_level=60)
            tr.simulate(paz_simulate=_WA_PAZ)
            tr.data = tr.data * 1000.0  # m → mm
        else:
            out = {UNIT_VEL: "VEL", UNIT_DISP: "DISP", UNIT_ACC: "ACC"}[units]
            tr.remove_response(output=out, pre_filt=pre_filt, water_level=60)
        return tr.data.tolist(), UNIT_LABELS[units]
    except Exception as e:
        log(f"convert_units({nslc}, {units}) failed: {e!r}")
        return data, "counts"


def preprocess(data: list, sr: float, nslc: str):
    """Full waveform preprocessing for the time-domain panels: response
    removal (units) first, then the active bandpass/lo/hi filter.
    Returns (data, unit_label)."""
    data, unit_label = convert_units(data, sr, nslc)
    data = apply_filter(data, sr, nslc)
    return data, unit_label


def apply_filter(data: list, sr: float, nslc: str) -> list:
    """Apply the active filter (if any) for this station to `data`.

    Filter spec shape: {"kind": "bandpass"|"highpass"|"lowpass"|"none",
                        "low": Hz, "high": Hz}
    Returns the filtered samples (or the originals if no filter active /
    scipy missing / window too short). Same length as input."""
    if not HAS_SCIPY or sr <= 0 or len(data) < 32:
        return data
    spec = _filters.get(nslc)
    if not spec or spec.get("kind", "none") == "none":
        return data
    nyq = sr / 2
    arr = np.asarray(data, dtype=np.float32)
    try:
        if spec["kind"] == "bandpass":
            lo = max(1e-3, float(spec["low"])) / nyq
            hi = min(0.999, float(spec["high"]) / nyq)
            if lo >= hi:
                return data
            sos = scipy_signal.butter(4, [lo, hi], btype="band", output="sos")
        elif spec["kind"] == "highpass":
            hi = max(1e-3, float(spec["low"])) / nyq
            sos = scipy_signal.butter(4, hi, btype="high", output="sos")
        elif spec["kind"] == "lowpass":
            lo = min(0.999, float(spec["high"]) / nyq)
            sos = scipy_signal.butter(4, lo, btype="low", output="sos")
        else:
            return data
        out = scipy_signal.sosfiltfilt(sos, arr)
    except Exception as e:
        log(f"filter({nslc}) failed: {e!r}")
        return data
    return out.tolist()


# ── SeedLink ingestion (real mode) ─────────────────────────────────────────
#
# ObsPy's easyseedlink doesn't support dynamic stream changes after
# .run() is called — the SeedLink protocol itself negotiates streams
# during handshake and then goes into stream mode. To handle runtime
# subscribe/unsubscribe we tear down the connection and reconnect with
# the new stream set every time the subscription set changes.
#
# A small (~1 s) debounce coalesces bursts of subscribe calls so a user
# adding multiple stations in quick succession doesn't trigger N restarts.

# ── Drum backfill (past 24 h via FDSN) ────────────────────────────────────
#
# SeedLink only delivers samples from "now" forward. To make the helicorder
# drum useful immediately, fetch the past 24 h from FDSN dataselect when a
# station is first subscribed and feed it through DRUM.write() — buckets
# end up in the same circular store as the live tail.

_backfill_started: Set[str] = set()
_backfill_lock = threading.Lock()


def _backfill_one(nslc: str) -> None:
    if not HAS_OBSPY:
        return
    try:
        net, sta, loc, cha = nslc.split(".")
    except ValueError:
        return
    # Make urllib see certifi's bundle (macOS / fresh Linux containers
    # alike — same as event_fetch.py).
    if "SSL_CERT_FILE" not in os.environ:
        try:
            import certifi
            os.environ["SSL_CERT_FILE"] = certifi.where()
        except ImportError:
            pass
    try:
        from obspy import UTCDateTime
        from obspy.clients.fdsn import Client as FdsnClient
    except ImportError:
        return

    now = time.time()
    t_end   = UTCDateTime(now - 60)  # avoid the "not yet flushed" tail
    t_start = UTCDateTime(now - 24 * 3600)
    log(f"backfill[{nslc}]: fetching {t_start} → {t_end}")
    try:
        client = FdsnClient("IRIS", timeout=60)
        st = client.get_waveforms(
            network=net, station=sta, location=loc, channel=cha,
            starttime=t_start, endtime=t_end,
        )
    except Exception as e:
        log(f"backfill[{nslc}]: FDSN failed: {e!r}")
        return
    if not st:
        log(f"backfill[{nslc}]: empty result")
        return
    total = 0
    for tr in st:
        sr = float(tr.stats.sampling_rate)
        t0 = float(tr.stats.starttime.timestamp)
        DRUM.write(nslc, t0, sr, tr.data)
        total += int(len(tr.data))
    log(f"backfill[{nslc}]: wrote {total} samples ({len(st)} traces)")


def kick_backfill(nslc: str) -> None:
    """Schedule a one-shot backfill for this station, idempotently."""
    with _backfill_lock:
        if nslc in _backfill_started:
            return
        _backfill_started.add(nslc)
    threading.Thread(target=_backfill_one, args=(nslc,),
                     name=f"backfill-{nslc}", daemon=True).start()


def _tcp_reachable(host: str, port: int, timeout_s: float = 5.0) -> bool:
    """Quick TCP connect check. Returns True if the connect succeeds
    within `timeout_s`, False on any failure (DNS, timeout, refused, …)."""
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            return True
    except OSError:
        return False


class SeedLinkConnection:
    """One connection to one SeedLink upstream. Restarts on stream-set changes."""

    DEBOUNCE_S = 0.8

    def __init__(self, host: str, port: int, ring: RingBuffer) -> None:
        self._host = host
        self._port = port
        self._ring = ring
        self._lock = threading.Lock()
        self._client = None
        self._thread = None
        self._desired: Set[tuple] = set()   # set of (net, sta, cha)
        self._active: Set[tuple] = set()
        self._restart_at: float | None = None
        threading.Thread(target=self._supervisor,
                         name=f"sl-{host}-supervisor", daemon=True).start()

    def _on_data(self, trace) -> None:
        nslc = (f"{trace.stats.network}.{trace.stats.station}."
                f"{trace.stats.location}.{trace.stats.channel}")
        sr   = float(trace.stats.sampling_rate)
        data = trace.data
        self._ring.write(nslc, sr, data.tolist())
        # Feed the 24-h drum history as well. Use the trace's own start
        # time so historical (FDSN) and live samples land in the right
        # buckets regardless of when they arrive.
        try:
            t0 = float(trace.stats.starttime.timestamp)
        except Exception:
            t0 = time.time() - len(data) / max(sr, 1.0)
        DRUM.write(nslc, t0, sr, data)

    def set_streams(self, nslcs: list[str]) -> None:
        """Replace the desired stream set; reconnect debounced."""
        streams: Set[tuple] = set()
        for s in nslcs:
            try:
                net, sta, _loc, cha = s.split(".")
            except ValueError:
                log(f"sl[{self._host}]: bad nslc {s!r}")
                continue
            streams.add((net, sta, cha))
        with self._lock:
            self._desired = streams
            self._restart_at = time.time() + self.DEBOUNCE_S

    def _supervisor(self) -> None:
        while True:
            time.sleep(0.2)
            with self._lock:
                if self._restart_at is None:
                    continue
                if time.time() < self._restart_at:
                    continue
                if self._desired == self._active and self._thread \
                        and self._thread.is_alive():
                    self._restart_at = None
                    continue
                desired = set(self._desired)
                self._restart_at = None
            self._reconnect(desired)

    def _reconnect(self, desired: Set[tuple]) -> None:
        # Tear down any existing client.
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None
            if self._thread is not None:
                self._thread.join(timeout=3.0)
            self._thread = None
            self._active = set()

        if not desired:
            log(f"sl[{self._host}]: no streams desired — staying disconnected")
            return

        # Fail fast if the upstream is unreachable. easyseedlink's
        # create_client does a synchronous TCP connect with no exposed
        # timeout, so without this probe an unreachable host blocks the
        # supervisor for the OS connect timeout (~75 s on macOS).
        if not _tcp_reachable(self._host, self._port, timeout_s=6.0):
            log(f"sl[{self._host}]: upstream unreachable — backing off 60s "
                f"(network/firewall may be blocking outbound :{self._port})")
            with self._lock:
                self._restart_at = time.time() + 60.0
            return

        try:
            client = create_client(
                f"{self._host}:{self._port}",
                on_data=self._on_data,
            )
            for net, sta, cha in desired:
                client.select_stream(net, sta, cha)
        except Exception as e:
            log(f"sl[{self._host}]: create_client failed: {e!r}")
            # Try again later.
            with self._lock:
                self._restart_at = time.time() + 5.0
            return

        log(f"sl[{self._host}]: connecting streams={sorted(desired)}")

        def run() -> None:
            try:
                client.run()
            except Exception as e:
                log(f"sl[{self._host}]: client.run() exited: {e!r}")
            log(f"sl[{self._host}]: client thread exited")

        self._client = client
        self._active = set(desired)
        self._thread = threading.Thread(target=run, name=f"seedlink-{self._host}",
                                        daemon=True)
        self._thread.start()


class SeedLinkRouter:
    """Top-level: partitions subscribed stations across one connection
    per upstream, lazily creating connections as networks appear."""

    def __init__(self, ring: RingBuffer) -> None:
        self._ring = ring
        self._connections: Dict[tuple, SeedLinkConnection] = {}

    @staticmethod
    def upstream_for(network: str) -> tuple:
        return NETWORK_UPSTREAMS.get(network, DEFAULT_SEEDLINK)

    def set_streams(self, nslcs: list[str]) -> None:
        # Partition by upstream.
        by_upstream: Dict[tuple, list[str]] = defaultdict(list)
        for s in nslcs:
            try:
                net = s.split(".")[0]
            except Exception:
                continue
            by_upstream[self.upstream_for(net)].append(s)

        # Update every active upstream to either its new stream set or empty.
        all_upstreams = set(self._connections.keys()) | set(by_upstream.keys())
        for up in all_upstreams:
            if up not in self._connections:
                host, port = up
                self._connections[up] = SeedLinkConnection(host, port, self._ring)
                log(f"sl: new upstream {host}:{port}")
            self._connections[up].set_streams(by_upstream.get(up, []))


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
                    DRUM.write(st, time.time() - n / SR, SR, samples)
            time.sleep(1.0)

    threading.Thread(target=run, name="synthetic", daemon=True).start()


# ── stdin command loop ────────────────────────────────────────────────────

def cmd_loop(sl_router) -> None:
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
            # Drum + RSAM both want 24 h of context (they share the
            # DrumHistory store); fetch it once per station.
            if "drum" in panels or "rsam" in panels:
                kick_backfill(station)
        elif op == "unsubscribe":
            with _subs_lock:
                _subscriptions.pop(station, None)
                _filters.pop(station, None)
            log(f"-sub {station}")
        elif op == "filter":
            spec = msg.get("spec") or {"kind": "none"}
            with _subs_lock:
                _filters[station] = spec
            log(f"filter {station} = {spec}")
            # Don't trigger a SeedLink restart for a filter change — it
            # only affects panel computation.
            continue
        elif op == "units":
            units = msg.get("units") or "counts"
            with _subs_lock:
                _units[station] = units
            log(f"units {station} = {units}")
            # Warm the inventory cache off the hot path so the first
            # converted frame doesn't block the panel loop on a network
            # fetch. No-op for "counts".
            if units != "counts":
                threading.Thread(target=fetch_inventory, args=(station,),
                                 name="inv-fetch", daemon=True).start()
            continue
        else:
            continue
        # Recompute SeedLink stream sets from current subscriptions.
        # Particle-motion panels need horizontal components too, so we
        # expand the desired stream list to include the Z/N/E siblings.
        if sl_router is not None:
            with _subs_lock:
                streams: list[str] = []
                for s, panels in _subscriptions.items():
                    streams.append(s)
                    if "particle-motion" in panels or "three-comp" in panels:
                        for sib in three_comp_siblings(s):
                            if sib not in streams:
                                streams.append(sib)
            sl_router.set_streams(streams)


# ── Panel timer thread ────────────────────────────────────────────────────

def ppsd_loop(ring: RingBuffer) -> None:
    """Background thread: every PPSD_INTERVAL_S, snapshot a fresh
    segment from each station that has the ppsd panel subscribed and
    feed it into PPSD."""
    while True:
        time.sleep(PPSD_INTERVAL_S)
        with _subs_lock:
            stations = [s for s, panels in _subscriptions.items() if "ppsd" in panels]
        for nslc in stations:
            sr, data = ring.snapshot(nslc, PPSD_SEGMENT_S)
            if not data:
                continue
            try:
                PPSD.add_segment(nslc, data, sr)
            except Exception as e:
                log(f"ppsd({nslc}) add_segment failed: {e!r}")


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

    mode = "synthetic" if (args.synthetic or not HAS_OBSPY) else "live"
    log(f"start  obspy={HAS_OBSPY}  scipy={HAS_SCIPY}  mode={mode}")
    if mode == "live":
        upstreams = {DEFAULT_SEEDLINK, *NETWORK_UPSTREAMS.values()}
        log(f"seedlink upstreams: default={DEFAULT_SEEDLINK} "
            f"per-network={NETWORK_UPSTREAMS} "
            f"({len(upstreams)} unique)")

    ring = RingBuffer()
    if args.synthetic or not HAS_OBSPY:
        if not HAS_SCIPY:
            log("warning: scipy missing — spectrogram & PSD will be skipped")
        start_synthetic(ring)
        sl_router = None
    else:
        sl_router = SeedLinkRouter(ring)

    threading.Thread(target=panel_loop, args=(ring,),
                     name="panels", daemon=True).start()
    threading.Thread(target=ppsd_loop, args=(ring,),
                     name="ppsd", daemon=True).start()

    # cmd_loop blocks the main thread on stdin.
    cmd_loop(sl_router)


if __name__ == "__main__":
    main()
