#!/usr/bin/env python3
"""Tremiom single-event grid-search locator.

Given a set of manual P picks (each: station lat/lon + absolute pick
time in unix ms), estimates the hypocenter by a two-stage lat/lon/depth
grid search that minimises the RMS of P travel-time residuals against
the iasp91 model.

Speed trick: TauP travel time depends only on epicentral distance and
source depth, not absolute position. So for each trial depth we build a
P time-vs-distance lookup once (0.1° resolution) and interpolate during
the grid search — no per-grid-point TauP calls. The whole search is a
few vectorised numpy passes.

Input (stdin JSON):
    {"picks": [{"lat":.., "lon":.., "tMs":..}, ...],   # P picks only
     "priorLat":.., "priorLon":..}                     # search center
Output (stdout JSON):
    {"ok": true, "lat":.., "lon":.., "depthKm":..,
     "originTimeMs":.., "rmsSec":.., "n":..}
  or {"ok": false, "error": ".."}
"""

from __future__ import annotations

import json
import math
import sys

import numpy as np


def gc_deg(lat1, lon1, lat2, lon2):
    """Great-circle distance in degrees (vectorised over the grid)."""
    p1 = np.radians(lat1); p2 = math.radians(lat2)
    dp = np.radians(lat2 - lat1); dl = np.radians(lon2 - lon1)
    a = np.sin(dp/2)**2 + np.cos(p1)*math.cos(p2)*np.sin(dl/2)**2
    return np.degrees(2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a)))


def main():
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad input: {e!r}"})); return
    picks = req.get("picks") or []
    if len(picks) < 4:
        print(json.dumps({"ok": False, "error": "need >= 4 P picks"})); return
    try:
        from obspy.taup import TauPyModel
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"obspy missing: {e!r}"})); return

    st_lat = np.array([p["lat"] for p in picks], dtype=float)
    st_lon = np.array([p["lon"] for p in picks], dtype=float)
    t_obs  = np.array([p["tMs"] for p in picks], dtype=float) / 1000.0  # sec

    prior_lat = float(req.get("priorLat", float(np.mean(st_lat))))
    prior_lon = float(req.get("priorLon", float(np.mean(st_lon))))

    model = TauPyModel(model="iasp91")
    depths = [10.0, 35.0, 70.0, 150.0, 300.0, 500.0]

    # P time-vs-distance lookup per depth (0 .. 180°, 0.5° steps).
    dist_axis = np.arange(0.0, 180.01, 0.5)
    tt_tables = {}
    for dep in depths:
        times = np.full(dist_axis.shape, np.nan)
        for i, dd in enumerate(dist_axis):
            try:
                arr = model.get_travel_times(source_depth_in_km=dep,
                                             distance_in_degree=float(dd),
                                             phase_list=["P", "p", "Pdiff"])
                if arr:
                    times[i] = min(a.time for a in arr)
            except Exception:
                pass
        tt_tables[dep] = times

    def score(lat, lon, dep):
        """Return (rms, origin_time) for one hypocenter candidate."""
        d = gc_deg(st_lat, st_lon, lat, lon)
        tt = np.interp(d, dist_axis, tt_tables[dep], left=np.nan, right=np.nan)
        if np.any(np.isnan(tt)):
            return np.inf, 0.0
        # Best origin time = mean of (observed - predicted-tt); residuals
        # are then observed - (origin + tt).
        ot = float(np.mean(t_obs - tt))
        resid = t_obs - (ot + tt)
        return float(np.sqrt(np.mean(resid**2))), ot

    def search(clat, clon, half, step):
        best = (np.inf, clat, clon, depths[0], 0.0)
        lats = np.arange(clat - half, clat + half + 1e-9, step)
        lons = np.arange(clon - half, clon + half + 1e-9, step)
        for dep in depths:
            for la in lats:
                for lo in lons:
                    rms, ot = score(la, lo, dep)
                    if rms < best[0]:
                        best = (rms, float(la), float(lo), dep, ot)
        return best

    # Coarse search ±20° at 2°, then refine ±2° at 0.25° around the best.
    coarse = search(prior_lat, prior_lon, 20.0, 2.0)
    fine = search(coarse[1], coarse[2], 2.0, 0.25)
    rms, lat, lon, dep, ot = fine if fine[0] < coarse[0] else coarse

    if not math.isfinite(rms):
        print(json.dumps({"ok": False, "error": "no valid solution (picks may span a TauP shadow zone)"})); return

    print(json.dumps({
        "ok": True,
        "lat": round(lat, 3), "lon": round(((lon + 180) % 360) - 180, 3),
        "depthKm": dep, "originTimeMs": int(ot * 1000),
        "rmsSec": round(rms, 2), "n": len(picks),
    }))


if __name__ == "__main__":
    main()
