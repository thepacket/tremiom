#!/usr/bin/env python3
"""Parse a user-uploaded waveform file (MiniSEED / SAC / GSE2 / etc.)
into per-trace envelopes for display in History mode.

ObsPy's read() autodetects most seismological formats, so this accepts
whatever the user has locally — the "open my own data" capability that
Snuffler / ObsPy / SeisGram2K provide and a fetch-only viewer lacks.

Input:  raw file bytes on stdin.
Output (stdout JSON):
    {"traces": [
       {"nslc":"IU.ANMO.00.BHZ","t0Ms":..,"sr":..,"durS":..,"npts":..,
        "binMs":..,"min":[...],"max":[...]}, ...]}
or {"error": "..."}.
"""

from __future__ import annotations

import io
import json
import sys

MAX_BINS = 3000


def main():
    raw = sys.stdin.buffer.read()
    if not raw:
        print(json.dumps({"error": "empty upload"})); return
    try:
        import numpy as np
        from obspy import read
    except ImportError as e:
        print(json.dumps({"error": f"deps missing: {e!r}"})); return
    try:
        st = read(io.BytesIO(raw))
    except Exception as e:
        print(json.dumps({"error": f"unreadable file: {e!r}"})); return
    if len(st) == 0:
        print(json.dumps({"error": "no traces in file"})); return

    out_traces = []
    for tr in st[:24]:  # cap at 24 traces
        data = np.asarray(tr.data, dtype=np.float64)
        n = len(data)
        if n == 0:
            continue
        sr = float(tr.stats.sampling_rate)
        bins = min(MAX_BINS, n)
        idx = np.linspace(0, n, bins + 1).astype(int)
        mins, maxs = [], []
        for i in range(bins):
            a, b = idx[i], idx[i + 1]
            if b <= a:
                mins.append(None); maxs.append(None)
            else:
                seg = data[a:b]
                mins.append(float(seg.min())); maxs.append(float(seg.max()))
        nslc = (f"{tr.stats.network}.{tr.stats.station}."
                f"{tr.stats.location}.{tr.stats.channel}")
        dur_s = n / sr if sr > 0 else 0.0
        out_traces.append({
            "nslc": nslc or "?.?..?",
            "t0Ms": int(tr.stats.starttime.timestamp * 1000),
            "sr": sr,
            "durS": dur_s,
            "npts": n,
            "binMs": (dur_s * 1000.0 / bins) if bins else 0.0,
            "min": mins, "max": maxs,
        })
    if not out_traces:
        print(json.dumps({"error": "no usable trace data"})); return
    sys.stdout.write(json.dumps({"traces": out_traces}, separators=(",", ":")))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
