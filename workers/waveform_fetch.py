#!/usr/bin/env python3
"""Tremiom arbitrary-window waveform fetcher.

Fetches a single channel over an arbitrary time window from FDSN
dataselect and returns it decimated to a transport-friendly point count
as JSON. Powers the History (waveform-browser) mode's zoom / pan /
arbitrary-time navigation — the everyday capability that distinguishes
a real seismic viewer (Swarm, Snuffler, Wilber 3) from a live-only one.

Input (stdin JSON):
    {"nslc":"IU.ANMO.00.BHZ", "startMs": 1730000000000, "durS": 3600,
     "maxPoints": 3000, "units": "counts"|"velocity"|..., "filter": {...}}

Output (stdout JSON):
    {"nslc":..,"t0Ms":..,"sr":..,"durS":..,"unit":"counts",
     "min":[...],"max":[...],   # per-pixel envelope (min/max decimation)
     "gaps":[[startMs,endMs],...]}

Envelope (min/max per output bin) is used rather than plain decimation
so transient spikes aren't aliased away when zoomed out over hours.
"""

from __future__ import annotations

import json
import os
import sys

if "SSL_CERT_FILE" not in os.environ:
    try:
        import certifi
        os.environ["SSL_CERT_FILE"] = certifi.where()
    except ImportError:
        pass


def fail(msg, **extra):
    sys.stdout.write(json.dumps({"error": msg, **extra}))
    sys.stdout.flush()
    sys.exit(0)


# Heavy deps imported once at module load (panel_server.py keeps this module
# resident, so requests skip the ObsPy import cold-start).
try:
    import numpy as np
    from scipy import signal as ss
    from obspy import UTCDateTime
    from obspy.clients.fdsn import Client as FdsnClient
    HAVE_DEPS = True
except ImportError:
    HAVE_DEPS = False


# Per-network FDSN routing (AM = Raspberry Shake). Clients are cached so the
# service-discovery handshake + TCP connection are reused across windows.
_clients = {}


def fdsn_client_for(net):
    key = "AM" if net == "AM" else "default"
    cl = _clients.get(key)
    if cl is None:
        cl = (FdsnClient("https://data.raspberryshake.org", timeout=60) if net == "AM"
              else FdsnClient("EARTHSCOPE", timeout=60))
        _clients[key] = cl
    return cl


_WA_PAZ = {"poles": [-6.283 - 4.7124j, -6.283 + 4.7124j],
           "zeros": [0j, 0j], "gain": 1.0, "sensitivity": 2080.0}


def run_waveform(req):
    """Fetch + decimate one window; returns a result dict (or {"error":..})."""
    if not HAVE_DEPS:
        return {"error": "deps missing"}
    nslc = req.get("nslc", "")
    start_ms = req.get("startMs")
    dur_s = float(req.get("durS") or 3600)
    max_points = int(req.get("maxPoints") or 3000)
    units = req.get("units") or "counts"
    filt = req.get("filter") or {"kind": "none"}
    try:
        net, sta, loc, cha = nslc.split(".")
    except ValueError:
        return {"error": "bad nslc"}
    if start_ms is None:
        return {"error": "missing startMs"}

    t0 = UTCDateTime(start_ms / 1000.0)
    t1 = t0 + dur_s
    try:
        client = fdsn_client_for(net)
        st = client.get_waveforms(network=net, station=sta, location=loc,
                                  channel=cha, starttime=t0, endtime=t1)
    except Exception as e:
        return {"error": f"fetch failed: {e!r}", "nslc": nslc}
    if not st:
        return {"error": "no data for window", "nslc": nslc}

    st.merge(method=0)  # keep gaps as masked
    tr = st[0]
    sr = float(tr.stats.sampling_rate)

    # Optional response removal (units).
    unit_label = "counts"
    if units != "counts":
        try:
            inv = client.get_stations(network=net, station=sta, channel=cha,
                                      starttime=t0, level="response")
            tr.attach_response(inv)
            pre = [0.005, 0.01, 0.45 * sr, 0.5 * sr]
            if units == "wood-anderson":
                tr.remove_response(output="DISP", pre_filt=pre, water_level=60)
                tr.simulate(paz_simulate=_WA_PAZ)
                tr.data = tr.data * 1000.0
                unit_label = "mm (WA)"
            else:
                out = {"velocity": "VEL", "displacement": "DISP",
                       "acceleration": "ACC"}.get(units, "VEL")
                tr.remove_response(output=out, pre_filt=pre, water_level=60)
                unit_label = {"velocity": "m/s", "displacement": "m",
                              "acceleration": "m/s²"}.get(units, "m/s")
        except Exception as e:
            sys.stderr.write(f"units failed: {e!r}\n")
            unit_label = "counts"

    # Optional bandpass/lo/hi filter.
    if filt.get("kind", "none") != "none":
        try:
            nyq = sr / 2
            data = np.asarray(tr.data, dtype=np.float64)
            data = np.nan_to_num(data)
            if filt["kind"] == "bandpass":
                sos = ss.butter(4, [max(1e-3, filt["low"]) / nyq,
                                    min(0.999, filt["high"] / nyq)],
                                btype="band", output="sos")
            elif filt["kind"] == "highpass":
                sos = ss.butter(4, max(1e-3, filt["low"]) / nyq, btype="high", output="sos")
            elif filt["kind"] == "lowpass":
                sos = ss.butter(4, min(0.999, filt["high"] / nyq), btype="low", output="sos")
            else:
                sos = None
            if sos is not None:
                tr.data = ss.sosfiltfilt(sos, data)
        except Exception as e:
            sys.stderr.write(f"filter failed: {e!r}\n")

    data = np.ma.getdata(tr.data).astype(np.float64)
    mask = np.ma.getmaskarray(tr.data) if np.ma.isMaskedArray(tr.data) else None
    n = len(data)
    t0_actual_ms = int(tr.stats.starttime.timestamp * 1000)

    # Envelope decimation: split into max_points bins, take min+max of each.
    bins = min(max_points, n)
    if bins < 1:
        return {"error": "empty trace"}
    idx = (np.linspace(0, n, bins + 1)).astype(int)
    mins, maxs = [], []
    for i in range(bins):
        a, b = idx[i], idx[i + 1]
        if b <= a:
            mins.append(None); maxs.append(None); continue
        seg = data[a:b]
        if mask is not None and mask[a:b].all():
            mins.append(None); maxs.append(None)
        else:
            if mask is not None:
                seg = seg[~mask[a:b]]
                if seg.size == 0:
                    mins.append(None); maxs.append(None); continue
            mins.append(float(seg.min())); maxs.append(float(seg.max()))

    return {
        "nslc": nslc,
        "t0Ms": t0_actual_ms,
        "sr": sr,
        "durS": dur_s,
        "binMs": dur_s * 1000.0 / bins,
        "unit": unit_label,
        "min": mins,
        "max": maxs,
    }


def main():
    """One-shot mode: read one request from stdin, print the result."""
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        fail(f"bad input: {e!r}")
    out = run_waveform(req)
    sys.stdout.write(json.dumps(out, separators=(",", ":")))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
