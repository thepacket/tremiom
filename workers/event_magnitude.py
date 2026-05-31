#!/usr/bin/env python3
"""Tremiom local-magnitude (ML) estimator.

For a given event, fetches the horizontal components of the nearest
curated stations, removes the instrument response, simulates a
Wood-Anderson seismometer, measures the peak zero-to-peak amplitude
(mm) on each, and computes a station ML via the IASPEI (2005) standard
local-magnitude formula:

    ML = log10(A) + 1.11*log10(R) + 0.00189*R - 2.09

where A is the peak WA displacement in millimetres and R is the
hypocentral distance in km. The network ML is the median of the
station MLs (robust to outliers), reported with the count and spread.

This is an INDEPENDENT estimate — it does not read the authoritative
catalog magnitude. Useful as an analyst cross-check.

Input (stdin JSON, same shape as event_fetch):
    {"lat":..,"lon":..,"depthKm":..,"timeMs":..,"nStations":6}
Output (stdout JSON):
    {"ml": 5.3, "n": 5, "spread": 0.18, "stations": [
        {"nslc":"IU.ANMO.00.BHN","distKm":..,"ampMm":..,"ml":..}, ...],
     "errors": [...]}
"""

from __future__ import annotations

import json
import math
import os
import statistics
import sys

if "SSL_CERT_FILE" not in os.environ:
    try:
        import certifi
        os.environ["SSL_CERT_FILE"] = certifi.where()
    except ImportError:
        pass

STATIONS = [
    {"nslc": "IU.ANMO.00.BHZ", "lat":  34.95, "lon": -106.46},
    {"nslc": "IU.HRV.00.BHZ",  "lat":  42.51, "lon":  -71.56},
    {"nslc": "IU.COLA.00.BHZ", "lat":  64.87, "lon": -147.86},
    {"nslc": "IU.KIP.00.BHZ",  "lat":  21.42, "lon": -158.01},
    {"nslc": "IU.KONO.00.BHZ", "lat":  59.65, "lon":    9.60},
    {"nslc": "IU.PMSA.00.BHZ", "lat": -64.77, "lon":  -64.05},
    {"nslc": "IU.RAR.00.BHZ",  "lat": -21.21, "lon": -159.77},
    {"nslc": "IU.GUMO.00.BHZ", "lat":  13.59, "lon":  144.87},
    {"nslc": "II.AAK.00.BHZ",  "lat":  42.64, "lon":   74.49},
    {"nslc": "II.BFO.00.BHZ",  "lat":  48.33, "lon":    8.33},
    {"nslc": "II.MSEY.00.BHZ", "lat":  -4.67, "lon":   55.48},
    {"nslc": "II.SUR.00.BHZ",  "lat": -32.38, "lon":   20.81},
    {"nslc": "G.SSB.00.BHZ",   "lat":  45.28, "lon":    4.54},
    {"nslc": "GE.STU.00.BHZ",  "lat":  48.77, "lon":    9.19},
]

_WA_PAZ = {"poles": [-6.283 - 4.7124j, -6.283 + 4.7124j],
           "zeros": [0j, 0j], "gain": 1.0, "sensitivity": 2080.0}


def gc_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1); dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def ml_iaspei(amp_mm: float, hypo_km: float) -> float:
    return (math.log10(amp_mm) + 1.11 * math.log10(hypo_km)
            + 0.00189 * hypo_km - 2.09)


def coda_duration_s(tr, origin):
    """Coda duration τ: seconds from origin until the smoothed signal
    envelope returns to ~2× the pre-event noise level (sustained).
    Returns None if no clear coda. Operates on a demeaned, 1–10 Hz
    band-passed copy."""
    import numpy as np
    t = tr.copy()
    t.detrend("demean")
    try:
        t.filter("bandpass", freqmin=1.0, freqmax=10.0, corners=4, zerophase=True)
    except Exception:
        pass
    sr = float(t.stats.sampling_rate)
    if sr <= 0:
        return None
    data = np.abs(np.asarray(t.data, dtype=np.float64))
    # Sliding-RMS-ish smoothing over 1 s.
    win = max(1, int(sr))
    kernel = np.ones(win) / win
    env = np.convolve(data, kernel, mode="same")
    t0 = t.stats.starttime
    o_idx = int((origin - t0) * sr)
    if o_idx < win or o_idx >= len(env) - win:
        return None
    noise = float(np.median(env[max(0, o_idx - int(25 * sr)):o_idx - int(2 * sr)]))
    if noise <= 0:
        noise = float(np.median(env[:o_idx])) or 1e-9
    thr = 2.0 * noise
    post = env[o_idx:]
    if post.max() < thr * 1.5:
        return None  # nothing clearly above noise — no event coda here
    # Coda end = last sample (after the peak) still above threshold.
    above = np.where(post > thr)[0]
    if len(above) == 0:
        return None
    tau = float(above[-1] / sr)
    return tau if tau > 1 else None


def md_coda(tau_s: float, dist_km: float) -> float:
    """Coda-duration (duration) magnitude. Lee et al. (1972)-style:
    Md = -2.60 + 2.74·log10(τ) + 0.0009·Δ."""
    return -2.60 + 2.74 * math.log10(tau_s) + 0.0009 * dist_km


def horizontals(net, sta, loc, cha):
    base = cha[:-1]
    return [f"{base}N", f"{base}E", f"{base}1", f"{base}2"]


def main():
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"error": f"bad input: {e!r}"})); return
    lat, lon = req.get("lat"), req.get("lon")
    depth = float(req.get("depthKm") or 10.0)
    time_ms = req.get("timeMs")
    n_stations = int(req.get("nStations") or 6)
    if lat is None or lon is None or time_ms is None:
        print(json.dumps({"error": "missing lat/lon/timeMs"})); return

    try:
        from obspy import UTCDateTime
        from obspy.clients.fdsn import Client as FdsnClient
    except ImportError as e:
        print(json.dumps({"error": f"obspy missing: {e!r}"})); return

    origin = UTCDateTime(time_ms / 1000.0)
    fdsn = FdsnClient("IRIS", timeout=60)
    # Local magnitude is meaningful at local/regional distance; restrict
    # to stations within ~10° (~1100 km). Beyond that ML isn't valid.
    cand = []
    for s in STATIONS:
        dk = gc_km(lat, lon, s["lat"], s["lon"])
        cand.append({**s, "distKm": dk})
    cand.sort(key=lambda s: s["distKm"])
    chosen = [s for s in cand if s["distKm"] <= 1100][:n_stations]

    out_st, errors, mls, mds = [], [], [], []
    for s in chosen:
        net, sta, loc, cha = s["nslc"].split(".")
        hypo = math.sqrt(s["distKm"] ** 2 + depth ** 2)
        peak_mm = 0.0
        got = False
        # Coda-duration Md from the vertical channel.
        md = None
        try:
            zst = fdsn.get_waveforms(network=net, station=sta, location=loc,
                                     channel=cha, starttime=origin - 30,
                                     endtime=origin + 900)
            if zst:
                tau = coda_duration_s(zst[0], origin)
                if tau:
                    md = md_coda(tau, s["distKm"])
                    mds.append(md)
        except Exception as e:
            errors.append({"nslc": f"{net}.{sta}.{loc}.{cha}", "error": repr(e)[:80]})
        for hcha in horizontals(net, sta, loc, cha):
            try:
                st = fdsn.get_waveforms(network=net, station=sta, location=loc,
                                        channel=hcha,
                                        starttime=origin - 30, endtime=origin + 600)
                if not st:
                    continue
                inv = fdsn.get_stations(network=net, station=sta, channel=hcha,
                                        starttime=origin, level="response")
                tr = st[0]
                tr.attach_response(inv)
                tr.remove_response(output="DISP",
                                   pre_filt=[0.005, 0.01,
                                             0.45 * tr.stats.sampling_rate,
                                             0.5 * tr.stats.sampling_rate],
                                   water_level=60)
                tr.simulate(paz_simulate=_WA_PAZ)
                amp_mm = float(max(abs(tr.data.max()), abs(tr.data.min())) * 1000.0)
                if amp_mm > peak_mm:
                    peak_mm = amp_mm
                got = True
            except Exception as e:
                errors.append({"nslc": f"{net}.{sta}.{loc}.{hcha}", "error": repr(e)[:80]})
        if got and peak_mm > 0:
            ml = ml_iaspei(peak_mm, hypo)
            mls.append(ml)
            out_st.append({"nslc": f"{net}.{sta}.{loc}.{cha[:2]}[NE]",
                           "distKm": round(s["distKm"], 1),
                           "ampMm": peak_mm, "ml": round(ml, 2),
                           "md": round(md, 2) if md is not None else None})
        elif md is not None:
            out_st.append({"nslc": f"{net}.{sta}.{loc}.{cha}",
                           "distKm": round(s["distKm"], 1),
                           "ampMm": None, "ml": None, "md": round(md, 2)})

    result = {"stations": out_st, "errors": errors}
    if mls:
        result["ml"] = round(statistics.median(mls), 2)
        result["n"] = len(mls)
        result["spread"] = round((max(mls) - min(mls)) / 2, 2)
    else:
        result["ml"] = None
        result["note"] = "no usable stations within 1100 km"
    if mds:
        result["md"] = round(statistics.median(mds), 2)
        result["mdN"] = len(mds)
    else:
        result["md"] = None
    print(json.dumps(result))


if __name__ == "__main__":
    main()
