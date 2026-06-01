#!/usr/bin/env python3
"""Tremiom event waveform exporter.

Like event_fetch.py but returns the *full-resolution* waveforms for an
event window as a MiniSEED byte stream (not decimated JSON), so users
can download real data for analysis in ObsPy / SAC / etc.

Reads a JSON request on stdin (same shape as event_fetch.py), writes
raw MiniSEED bytes to stdout. On error, writes nothing and exits non-
zero with a message on stderr.

    {"lat":..,"lon":..,"depthKm":..,"timeMs":..,"nStations":6,
     "windowSecs":[-60,600]}
"""

from __future__ import annotations

import json
import math
import os
import sys
import io

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
    {"nslc": "IU.WAKE.00.BHZ", "lat":  19.28, "lon":  166.65},
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
        sys.stderr.write(f"bad input: {e!r}\n"); sys.exit(1)
    lat, lon = req.get("lat"), req.get("lon")
    time_ms = req.get("timeMs")
    n_stations = int(req.get("nStations") or 6)
    win = req.get("windowSecs") or [-60, 600]
    if lat is None or lon is None or time_ms is None:
        sys.stderr.write("missing lat/lon/timeMs\n"); sys.exit(1)

    try:
        from obspy import UTCDateTime, Stream
        from obspy.clients.fdsn import Client as FdsnClient
    except ImportError as e:
        sys.stderr.write(f"obspy missing: {e!r}\n"); sys.exit(1)

    origin = UTCDateTime(time_ms / 1000.0)
    t0, t1 = origin + float(win[0]), origin + float(win[1])

    chosen = sorted(STATIONS, key=lambda s: gc_km(lat, lon, s["lat"], s["lon"]))[:n_stations]
    fdsn = FdsnClient("EARTHSCOPE", timeout=60)
    out = Stream()
    for s in chosen:
        net, sta, loc, cha = s["nslc"].split(".")
        try:
            st = fdsn.get_waveforms(network=net, station=sta, location=loc,
                                    channel=cha, starttime=t0, endtime=t1)
            out += st
        except Exception as e:
            sys.stderr.write(f"{s['nslc']}: {e!r}\n")
    if len(out) == 0:
        sys.stderr.write("no waveforms\n"); sys.exit(1)

    buf = io.BytesIO()
    out.write(buf, format="MSEED")
    sys.stdout.buffer.write(buf.getvalue())
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
