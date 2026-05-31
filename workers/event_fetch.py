#!/usr/bin/env python3
"""Tremiom event-fetch worker.

Reads a JSON request on stdin describing an earthquake (lat, lon,
depth, origin time, optional id) and writes a JSON response on stdout
containing the nearest curated stations' waveforms around the event,
along with TauP-predicted P and S arrival times.

This is invoked as a one-shot subprocess from server.mjs; it is not
the long-running streaming worker (workers/worker.py).

Input  (NDJSON, single line):
    {"eventId": "us7000abcd",
     "lat": 35.6, "lon": 140.0, "depthKm": 30.0,
     "timeMs": 1748736000000,
     "nStations": 6,
     "windowSecs": [-60, 600]}

Output (single JSON object):
    {"eventId": "...",
     "originTimeMs": 1748736000000,
     "stations": [
        {"nslc": "IU.ANMO.00.BHZ",
         "distKm": 8235.4, "distDeg": 74.1,
         "lat": 34.95, "lon": -106.46,
         "pArrivalS": 681.3, "sArrivalS": 1220.7,
         "t0Ms": 1748735940000, "sr": 40.0,
         "data": [...float...],
         "decimateBy": 4}
        , ...
     ],
     "errors": [{"nslc": "...", "error": "..."}]
    }

All input + output uses unix milliseconds for times; arrival times are
in seconds *from origin* so the frontend can do its own alignment.

Errors fetching one station's data don't fail the whole request — they
appear in the `errors` array so the frontend can show partial results.
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any

# macOS framework Python ships without a usable CA bundle, so urllib
# (which ObsPy uses internally for FDSN discovery + dataselect) fails
# every HTTPS request. Point it at certifi's bundle if SSL_CERT_FILE
# isn't already set by the environment.
if "SSL_CERT_FILE" not in os.environ:
    try:
        import certifi
        os.environ["SSL_CERT_FILE"] = certifi.where()
    except ImportError:
        pass

# Lazy-imported below; fail with a clear JSON error if missing so the
# Node side can report a sensible message to the browser.

# Same curated list the frontend uses. Kept in sync manually for now.
# When we add FDSN station-service search this becomes dynamic.
STATIONS: list[dict[str, Any]] = [
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


def gc_distance_km(lat1, lon1, lat2, lon2) -> float:
    """Great-circle distance in km via the haversine formula."""
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def km_to_degrees(km: float) -> float:
    return km / 111.195


def fail(msg: str, **extra) -> None:
    out = {"error": msg, **extra}
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()
    sys.exit(0)


def main() -> None:
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        fail(f"bad input: {e!r}")

    event_id = req.get("eventId", "")
    lat = req.get("lat")
    lon = req.get("lon")
    depth_km = float(req.get("depthKm") or 10.0)
    time_ms = req.get("timeMs")
    n_stations = int(req.get("nStations") or 6)
    win = req.get("windowSecs") or [-60, 600]
    component = (req.get("component") or "Z").upper()  # Z | R | T
    if lat is None or lon is None or time_ms is None:
        fail("missing lat/lon/timeMs")

    try:
        from obspy import UTCDateTime
        from obspy.clients.fdsn import Client as FdsnClient
        from obspy.taup import TauPyModel
    except ImportError as e:
        fail(f"obspy not installed in this venv: {e!r}")

    origin_t = UTCDateTime(time_ms / 1000.0)
    pre, post = float(win[0]), float(win[1])
    win_start = origin_t + pre
    win_end   = origin_t + post

    # Pick N nearest stations by great-circle distance.
    enriched = []
    for s in STATIONS:
        d_km = gc_distance_km(lat, lon, s["lat"], s["lon"])
        enriched.append({**s, "distKm": d_km, "distDeg": km_to_degrees(d_km)})
    enriched.sort(key=lambda s: s["distKm"])
    chosen = enriched[:n_stations]

    # TauP travel times (iasp91 — standard 1-D Earth model).
    try:
        taup = TauPyModel(model="iasp91")
    except Exception as e:
        taup = None
        taup_err = repr(e)
    else:
        taup_err = None

    fdsn = FdsnClient("IRIS", timeout=30)

    out_stations = []
    errors = []
    for s in chosen:
        nslc = s["nslc"]
        net, sta, loc, cha = nslc.split(".")
        # FDSN dataselect; restitute later if needed.
        try:
            if component in ("R", "T"):
                # Rotate horizontals to radial/transverse. Fetch the two
                # horizontals (N/E or 1/2), rotate by the station→event
                # back-azimuth, and take the requested component.
                from obspy.geodetics import gps2dist_azimuth
                base = cha[:-1]
                horiz = None
                st = None
                for a, b in (("N", "E"), ("1", "2")):
                    try:
                        cand = fdsn.get_waveforms(network=net, station=sta, location=loc,
                                                  channel=f"{base}{a},{base}{b}",
                                                  starttime=win_start, endtime=win_end)
                    except Exception:
                        cand = None
                    if cand and len(cand) >= 2:
                        st = cand; horiz = (a, b); break
                if horiz is None or st is None or len(st) < 2:
                    errors.append({"nslc": nslc, "error": "no horizontal pair"})
                    continue
                # back-azimuth: azimuth from station to event (deg from N).
                _, baz, _ = gps2dist_azimuth(s["lat"], s["lon"], lat, lon)
                st.merge(method=0, fill_value="interpolate")
                # rotate() needs channels labelled N/E. Relabel 1/2 → N/E
                # first (approximate: most GSN 1/2 are within a few degrees
                # of N/E; exact rotation would use the azimuth metadata).
                for tr0 in st:
                    ch0 = tr0.stats.channel
                    if ch0.endswith("1"):
                        tr0.stats.channel = ch0[:-1] + "N"
                    elif ch0.endswith("2"):
                        tr0.stats.channel = ch0[:-1] + "E"
                st.rotate("NE->RT", back_azimuth=baz)
                want = "R" if component == "R" else "T"
                sel = st.select(component=want)
                if not sel:
                    errors.append({"nslc": nslc, "error": f"no {want} after rotate"})
                    continue
                tr = sel[0]
            else:
                st = fdsn.get_waveforms(
                    network=net, station=sta, location=loc, channel=cha,
                    starttime=win_start, endtime=win_end,
                )
                if not st:
                    errors.append({"nslc": nslc, "error": "empty stream"})
                    continue
                tr = st[0]
        except Exception as e:
            errors.append({"nslc": nslc, "error": repr(e)})
            continue

        # Decimate to ~2000 points max for transport.
        target = 2000
        n = len(tr.data)
        decimate_by = max(1, n // target)
        data = tr.data[::decimate_by].tolist()
        sr = float(tr.stats.sampling_rate) / decimate_by
        t0_ms = int(tr.stats.starttime.timestamp * 1000)

        # P / S arrivals from TauP for this distance and depth.
        p_s = s_s = None
        if taup is not None:
            try:
                arrivals = taup.get_travel_times(
                    source_depth_in_km=depth_km,
                    distance_in_degree=s["distDeg"],
                    phase_list=["P", "p", "S", "s"],
                )
                for a in arrivals:
                    name = a.name.upper()
                    if name == "P" and p_s is None:
                        p_s = float(a.time)
                    elif name == "S" and s_s is None:
                        s_s = float(a.time)
            except Exception:
                pass

        out_stations.append({
            "nslc": nslc,
            "lat": s["lat"], "lon": s["lon"],
            "distKm": s["distKm"], "distDeg": s["distDeg"],
            "pArrivalS": p_s, "sArrivalS": s_s,
            "t0Ms": t0_ms, "sr": sr,
            "decimateBy": decimate_by,
            "data": data,
        })

    out = {
        "eventId": event_id,
        "originTimeMs": int(time_ms),
        "depthKm": depth_km,
        "lat": lat, "lon": lon,
        "windowSecs": [pre, post],
        "component": component,
        "stations": out_stations,
        "errors": errors,
    }
    if taup_err:
        out["taupError"] = taup_err
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
