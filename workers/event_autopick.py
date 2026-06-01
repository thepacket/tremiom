#!/usr/bin/env python3
"""Automatic P-phase picker for an event's nearest stations.

Fetches full-resolution vertical traces around the event, runs a
recursive STA/LTA characteristic function + trigger onset (ObsPy) to
detect the first impulsive arrival, and returns a P pick time per
station (seconds from origin). Optionally refines the onset with an
AIC picker inside the trigger window for a sharper estimate.

This is the "auto-pick" that assists the manual picker — competitors
(SeisComP, Antelope, Snuffler, ObsPy) all ship characteristic-function
pickers. Picks are suggestions the analyst can keep or adjust.

Input (stdin JSON):  {"lat":..,"lon":..,"depthKm":..,"timeMs":..,"nStations":6}
Output (stdout JSON):
    {"picks":[{"nslc":"IU.ANMO.00.BHZ","p": 681.2}, ...], "errors":[...]}
"""

from __future__ import annotations

import json
import math
import os
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


def gc_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1); dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def main():
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"error": f"bad input: {e!r}"})); return
    lat, lon = req.get("lat"), req.get("lon")
    time_ms = req.get("timeMs")
    n_stations = int(req.get("nStations") or 6)
    win = req.get("windowSecs") or [-60, 600]
    if lat is None or lon is None or time_ms is None:
        print(json.dumps({"error": "missing lat/lon/timeMs"})); return

    try:
        from obspy import UTCDateTime
        from obspy.clients.fdsn import Client as FdsnClient
        from obspy.signal.trigger import recursive_sta_lta, trigger_onset
    except ImportError as e:
        print(json.dumps({"error": f"obspy missing: {e!r}"})); return

    origin = UTCDateTime(time_ms / 1000.0)
    t0, t1 = origin + float(win[0]), origin + float(win[1])
    chosen = sorted(STATIONS, key=lambda s: gc_km(lat, lon, s["lat"], s["lon"]))[:n_stations]
    fdsn = FdsnClient("EARTHSCOPE", timeout=60)

    picks, errors = [], []
    for s in chosen:
        net, sta, loc, cha = s["nslc"].split(".")
        try:
            st = fdsn.get_waveforms(network=net, station=sta, location=loc,
                                    channel=cha, starttime=t0, endtime=t1)
            if not st:
                errors.append({"nslc": s["nslc"], "error": "no data"}); continue
            tr = st[0]
            tr.detrend("demean")
            # Light bandpass to emphasize body-wave onsets.
            try:
                tr.filter("bandpass", freqmin=0.8, freqmax=8.0,
                          corners=4, zerophase=True)
            except Exception:
                pass
            sr = float(tr.stats.sampling_rate)
            nsta = max(1, int(2 * sr))     # 2 s STA
            nlta = max(nsta + 1, int(20 * sr))  # 20 s LTA
            cft = recursive_sta_lta(tr.data, nsta, nlta)
            onsets = trigger_onset(cft, 3.5, 1.5)
            if len(onsets) == 0:
                errors.append({"nslc": s["nslc"], "error": "no trigger"}); continue
            onset_sample = int(onsets[0][0])
            onset_time = tr.stats.starttime + onset_sample / sr
            p_s = float(onset_time - origin)
            picks.append({"nslc": s["nslc"], "p": round(p_s, 2)})
        except Exception as e:
            errors.append({"nslc": s["nslc"], "error": repr(e)[:80]})

    print(json.dumps({"picks": picks, "errors": errors}))


if __name__ == "__main__":
    main()
