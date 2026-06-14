#!/usr/bin/env python3
"""Tremiom one-shot panel computer for History / Event data.

Fetches a channel (and, when a 3-component panel is requested, its Z/N/E
or Z/1/2 siblings) over an arbitrary time window from FDSN dataselect —
same fetch + units + filter path as `waveform_fetch.py` — and computes
static analysis-panel frames over that window. This lets the live
dashboard panels also be shown for a browsed history window or a selected
event station, not just the live stream.

The compute mirrors the live `worker.py` panel computers (same scipy
calls / constants) so the result reads the same; the difference is the
data source (a fixed fetched window) and that the spectrogram is a real
multi-column STFT over the whole window.

Input (stdin JSON):
    {"nslc":"IU.ANMO.00.BHZ", "startMs": 1730000000000, "durS": 600,
     "units":"counts"|"velocity"|..., "filter": {...},
     "panels": ["spectrogram","psd","spectrum","raw-scope","sta-lta",
                "three-comp","particle-motion","hv"]}

Output (stdout JSON):
    {"nslc":..,"t0Ms":..,"sr":..,"unit":..,"frames": { <panel>: <frame> }}
"""

from __future__ import annotations

import json
import os
import sys
import time

if "SSL_CERT_FILE" not in os.environ:
    try:
        import certifi
        os.environ["SSL_CERT_FILE"] = certifi.where()
    except ImportError:
        pass

# Mirror the live worker's constants so results match the live panels.
SPECTROGRAM_NPERSEG = 256
PSD_NPERSEG = 1024
SPECTROGRAM_MAX_COLS = 240
RAW_SCOPE_POINTS = 1024
STA_WIN_S = 1.0
LTA_WIN_S = 10.0
STA_LTA_THRESHOLD = 3.0
THREE_COMP_POINTS = 800
PM_POINTS = 600
HV_NPERSEG = 1024

SINGLE_PANELS = {"psd", "spectrum", "spectrogram", "raw-scope", "sta-lta"}
THREEC_PANELS = {"three-comp", "particle-motion", "hv"}


# Heavy deps imported once at module load. panel_server.py keeps this module
# resident so each request avoids the (~1-2 s) ObsPy import cost.
try:
    import numpy as np
    from scipy import signal as ss
    from obspy import UTCDateTime
    from obspy.clients.fdsn import Client as FdsnClient
    HAVE_DEPS = True
except ImportError:
    HAVE_DEPS = False


def fail(msg, **extra):
    sys.stdout.write(json.dumps({"error": msg, **extra}))
    sys.stdout.flush()
    sys.exit(0)


# Reuse FDSN clients across requests — the service discovery handshake is then
# done once, not on every window.
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


# ── Per-trace units + filter (mirrors waveform_fetch.py) ─────────────────
def prep_trace(tr, inv, units, filt, np, ss):
    sr = float(tr.stats.sampling_rate)
    unit_label = "counts"
    if units != "counts" and inv is not None:
        try:
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
            sys.stderr.write(f"units failed ({tr.id}): {e!r}\n")
            unit_label = "counts"
    data = np.nan_to_num(np.ma.getdata(tr.data).astype(np.float64))
    if filt.get("kind", "none") != "none":
        try:
            nyq = sr / 2
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
                data = ss.sosfiltfilt(sos, data)
        except Exception as e:
            sys.stderr.write(f"filter failed ({tr.id}): {e!r}\n")
    return data, sr, unit_label


# ── Pure compute cores (mirror the live worker.py panel computers) ───────
def _decimate(d, pts, np):
    step = max(1, len(d) // pts)
    return [float(v) for v in np.asarray(d)[::step][:pts]]


def compute_psd(sr, data, np, ss):
    if sr <= 0 or len(data) < 16:
        return None
    f, pxx = ss.welch(np.asarray(data, dtype=np.float64), fs=sr,
                      nperseg=min(PSD_NPERSEG, len(data)),
                      scaling="density", detrend="linear")
    db = 10.0 * np.log10(np.maximum(pxx, 1e-30))
    return {"fMinHz": float(f[0]), "fMaxHz": float(f[-1]),
            "data": db.astype("float32").tolist()}


def compute_spectrum(sr, data, np, ss):
    if sr <= 0 or len(data) < 64:
        return None
    f, pxx = ss.welch(np.asarray(data, dtype=np.float64), fs=sr,
                      nperseg=min(PSD_NPERSEG, len(data)),
                      window="hann", scaling="spectrum", detrend="constant")
    db = 20.0 * np.log10(np.maximum(np.sqrt(np.maximum(pxx, 1e-30)), 1e-12))
    return {"fMinHz": float(f[0]), "fMaxHz": float(f[-1]),
            "data": db.astype("float32").tolist()}


def compute_spectrogram(sr, data, np, ss):
    if sr <= 0 or len(data) < SPECTROGRAM_NPERSEG:
        return None
    nperseg = min(SPECTROGRAM_NPERSEG, len(data))
    f, _t, sxx = ss.spectrogram(np.asarray(data, dtype=np.float64), fs=sr,
                                nperseg=nperseg, noverlap=nperseg // 2,
                                scaling="density", detrend="constant", mode="psd")
    db = 10.0 * np.log10(np.maximum(sxx, 1e-30))
    ncols = db.shape[1]
    if ncols == 0:
        return None
    if ncols > SPECTROGRAM_MAX_COLS:
        edges = np.linspace(0, ncols, SPECTROGRAM_MAX_COLS + 1).astype(int)
        cols = [db[:, edges[i]:edges[i + 1]].max(axis=1)
                for i in range(SPECTROGRAM_MAX_COLS) if edges[i + 1] > edges[i]]
    else:
        cols = [db[:, i] for i in range(ncols)]
    return {"fMinHz": float(f[0]), "fMaxHz": float(f[-1]),
            "columns": [c.astype("float32").tolist() for c in cols]}


def compute_raw_scope(sr, data, unit, np):
    if sr <= 0 or len(data) == 0:
        return None
    return {"sr": float(sr), "windowS": len(data) / sr, "unit": unit,
            "data": _decimate(data, RAW_SCOPE_POINTS, np)}


def compute_sta_lta(sr, data, np):
    if sr <= 0:
        return None
    sta_n = max(1, int(STA_WIN_S * sr))
    lta_n = max(sta_n + 1, int(LTA_WIN_S * sr))
    if len(data) < lta_n + 1:
        return None
    arr = np.abs(np.asarray(data, dtype=np.float64))
    cs = np.cumsum(np.concatenate([[0.0], arr]))
    sta = (cs[sta_n:] - cs[:-sta_n]) / sta_n
    lta = (cs[lta_n:] - cs[:-lta_n]) / lta_n
    ratio = sta[lta_n - sta_n:] / np.maximum(lta, 1e-9)
    step = max(1, len(ratio) // 1024)
    out = ratio[::step][:1024]
    return {"sr": float(sr / step), "windowS": len(arr) / sr,
            "staWinS": STA_WIN_S, "ltaWinS": LTA_WIN_S,
            "threshold": STA_LTA_THRESHOLD, "t": time.time(),
            "data": [float(v) for v in out]}


def compute_three_comp(comps, base, unit, win_s, np):
    """comps: dict suffix → (data, sr). Build Z, N/1, E/2 component list."""
    out = []
    for suf in ("Z",):
        if suf in comps:
            out.append({"label": base + suf, "data": _decimate(comps[suf][0], THREE_COMP_POINTS, np)})
    for nsuf, esuf in (("N", "E"), ("1", "2")):
        if nsuf in comps and esuf in comps:
            out.append({"label": base + nsuf, "data": _decimate(comps[nsuf][0], THREE_COMP_POINTS, np)})
            out.append({"label": base + esuf, "data": _decimate(comps[esuf][0], THREE_COMP_POINTS, np)})
            break
    if not out:
        return None
    return {"station": "", "t": time.time(), "windowS": win_s,
            "unit": unit, "components": out}


def compute_particle_motion(comps, base, win_s, np):
    for nsuf, esuf in (("N", "E"), ("1", "2")):
        if nsuf in comps and esuf in comps:
            nd, ne = comps[nsuf][0], comps[esuf][0]
            n = min(len(nd), len(ne))
            if n < 32:
                return None
            return {"station": "", "t": time.time(), "windowS": win_s,
                    "n": _decimate(nd[:n], PM_POINTS, np),
                    "e": _decimate(ne[:n], PM_POINTS, np),
                    "chN": base + nsuf, "chE": base + esuf}
    return None


def compute_hv(comps, base, np, ss):
    if "Z" not in comps:
        return None
    for nsuf, esuf in (("N", "E"), ("1", "2")):
        if nsuf in comps and esuf in comps:
            z, sr = comps["Z"]
            n = comps[nsuf][0]
            e = comps[esuf][0]
            L = min(len(z), len(n), len(e))
            if sr <= 0 or L < HV_NPERSEG:
                return None
            nper = min(HV_NPERSEG, L)
            fz, pz = ss.welch(np.asarray(z[-L:], dtype=np.float64), fs=sr, nperseg=nper, detrend="linear")
            _, pn = ss.welch(np.asarray(n[-L:], dtype=np.float64), fs=sr, nperseg=nper, detrend="linear")
            _, pe = ss.welch(np.asarray(e[-L:], dtype=np.float64), fs=sr, nperseg=nper, detrend="linear")
            with np.errstate(divide="ignore", invalid="ignore"):
                hv = np.sqrt((pn + pe) / 2.0 / np.maximum(pz, 1e-30))
            freqs, hv = fz[1:], hv[1:]
            if len(freqs) < 4:
                return None
            band = (freqs >= 0.1) & (freqs <= 20)
            peak = float(freqs[np.argmax(np.where(band, hv, -np.inf))]) if np.any(band) else None
            return {"fMinHz": float(freqs[0]), "fMaxHz": float(freqs[-1]),
                    "data": [float(v) for v in hv], "peakHz": peak,
                    "chN": base + nsuf, "chE": base + esuf}
    return None


# ── Fetch + compute one window's panels. Returns a result dict (or an
#    {"error": ...} dict); never exits — so panel_server.py can call it in a
#    loop. ──────────────────────────────────────────────────────────────────
def run_panels(req):
    if not HAVE_DEPS:
        return {"error": "deps missing"}
    nslc = req.get("nslc", "")
    start_ms = req.get("startMs")
    dur_s = float(req.get("durS") or 600)
    units = req.get("units") or "counts"
    filt = req.get("filter") or {"kind": "none"}
    panels = req.get("panels") or ["spectrogram", "psd", "spectrum"]
    try:
        net, sta, loc, cha = nslc.split(".")
    except ValueError:
        return {"error": "bad nslc"}
    if start_ms is None:
        return {"error": "missing startMs"}
    if len(cha) != 3:
        return {"error": "bad channel"}

    base = cha[:-1]
    need_3c = any(p in THREEC_PANELS for p in panels)
    ch_query = base + "?" if need_3c else cha

    t0 = UTCDateTime(start_ms / 1000.0)
    t1 = t0 + dur_s
    try:
        client = fdsn_client_for(net)
        st = client.get_waveforms(network=net, station=sta, location=loc,
                                  channel=ch_query, starttime=t0, endtime=t1)
    except Exception as e:
        return {"error": f"fetch failed: {e!r}", "nslc": nslc}
    if not st:
        return {"error": "no data for window", "nslc": nslc}
    st.merge(method=0, fill_value=0)

    inv = None
    if units != "counts":
        try:
            inv = client.get_stations(network=net, station=sta, channel=ch_query,
                                      starttime=t0, level="response")
        except Exception as e:
            sys.stderr.write(f"inventory failed: {e!r}\n")

    # Build per-component data (suffix letter → (data, sr)).
    comps = {}
    unit_label = "counts"
    t0_actual_ms = start_ms
    for tr in st:
        c = tr.stats.channel[-1]
        data, sr, ul = prep_trace(tr, inv, units, filt, np, ss)
        comps[c] = (data, sr)
        if c == cha[-1]:
            unit_label = ul
            t0_actual_ms = int(tr.stats.starttime.timestamp * 1000)
    if not comps:
        return {"error": "empty trace", "nslc": nslc}

    prim = comps.get(cha[-1]) or comps.get("Z") or next(iter(comps.values()))
    prim_data, prim_sr = prim
    win_s = len(prim_data) / prim_sr if prim_sr > 0 else dur_s

    frames = {}
    for p in panels:
        try:
            if p == "psd":
                fr = compute_psd(prim_sr, prim_data, np, ss)
            elif p == "spectrum":
                fr = compute_spectrum(prim_sr, prim_data, np, ss)
            elif p == "spectrogram":
                fr = compute_spectrogram(prim_sr, prim_data, np, ss)
            elif p == "raw-scope":
                fr = compute_raw_scope(prim_sr, prim_data, unit_label, np)
            elif p == "sta-lta":
                fr = compute_sta_lta(prim_sr, prim_data, np)
            elif p == "three-comp":
                fr = compute_three_comp(comps, base, unit_label, win_s, np)
            elif p == "particle-motion":
                fr = compute_particle_motion(comps, base, win_s, np)
            elif p == "hv":
                fr = compute_hv(comps, base, np, ss)
            else:
                fr = None
            if fr is not None:
                frames[p] = fr
        except Exception as e:
            sys.stderr.write(f"panel {p} failed: {e!r}\n")

    return {"nslc": nslc, "t0Ms": t0_actual_ms, "sr": prim_sr,
            "unit": unit_label, "frames": frames}


def main():
    """One-shot mode: read one request from stdin, print the result."""
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        fail(f"bad input: {e!r}")
    out = run_panels(req)
    sys.stdout.write(json.dumps(out, separators=(",", ":")))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
