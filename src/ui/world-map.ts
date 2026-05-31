/** World map showing live USGS event epicenters and curated station
 *  markers. Equirectangular projection (longitude → x, latitude → y),
 *  no pan/zoom in v0.0.x — fits the whole globe in the viewport.
 *
 *  Click handling routes through the same hooks the sidebar uses, so
 *  the map + sidebar stay in sync (selecting an event in either picks
 *  the same item).
 */

import coastlines from '../data/coastlines.json';
import { STATION_PRESETS } from '../data/stations';
import {
  type SeismicEvent, magColor,
} from '../data/events';

interface MapHandlers {
  onEventPicked(event: SeismicEvent): void;
  onStationPicked(nslc: string): void;
}

interface CoastlineFeature {
  type: 'Feature';
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] };
}

/** Hit-test target for canvas click handling. */
interface HitTarget {
  kind: 'event' | 'station';
  x: number; y: number; r: number;
  payload: SeismicEvent | string; // SeismicEvent for events, NSLC for stations
}

const COLOR_GRATICULE  = '#1a2025';
const COLOR_LAND       = '#1f2a30';
const COLOR_LAND_STROKE = '#2c3a42';
const COLOR_STATION    = '#7a8590';
const COLOR_STATION_HI = '#ff8c1a';
const COLOR_BG         = '#0d0d0d';

export interface WorldMap {
  setEvents(events: SeismicEvent[]): void;
  setActiveStation(nslc: string): void;
  setSelectedEvent(eventId: string | null): void;
}

export function mountWorldMap(
  parent: HTMLElement,
  handlers: MapHandlers,
): WorldMap {
  const el = document.createElement('div');
  el.className = 'world-map';
  const canvas = document.createElement('canvas');
  el.appendChild(canvas);
  parent.appendChild(el);

  const ctx = canvas.getContext('2d')!;

  let cssW = 1, cssH = 1, dpr = 1;
  let events: SeismicEvent[] = [];
  let activeStation: string = STATION_PRESETS[0]?.nslc ?? '';
  let selectedEventId: string | null = null;
  const hitTargets: HitTarget[] = [];

  const ro = new ResizeObserver(() => {
    dpr = window.devicePixelRatio || 1;
    cssW = canvas.clientWidth;
    cssH = canvas.clientHeight;
    canvas.width  = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  });
  ro.observe(canvas);

  // Project longitude / latitude into canvas pixel space.
  function project(lon: number, lat: number): [number, number] {
    const x = ((lon + 180) / 360) * cssW;
    const y = ((90 - lat) / 180) * cssH;
    return [x, y];
  }

  function drawGraticule() {
    ctx.strokeStyle = COLOR_GRATICULE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 30) {
      const [x] = project(lon, 0);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [, y] = project(0, lat);
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
    }
    ctx.stroke();
    // Equator stronger.
    ctx.strokeStyle = '#252e34';
    const [, eqY] = project(0, 0);
    ctx.beginPath();
    ctx.moveTo(0, eqY);
    ctx.lineTo(cssW, eqY);
    ctx.stroke();
  }

  function drawRing(ring: number[][]) {
    ctx.beginPath();
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = project(ring[i][0], ring[i][1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function drawCoastlines() {
    ctx.fillStyle = COLOR_LAND;
    ctx.strokeStyle = COLOR_LAND_STROKE;
    ctx.lineWidth = 0.6;
    const fc = coastlines as { features: CoastlineFeature[] };
    for (const f of fc.features) {
      const g = f.geometry;
      if (g.type === 'Polygon') {
        for (const ring of g.coordinates) drawRing(ring);
      } else if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates) {
          for (const ring of poly) drawRing(ring);
        }
      }
    }
  }

  function drawStations() {
    const size = 5;
    for (const s of STATION_PRESETS) {
      const [x, y] = project(s.lon, s.lat);
      const isActive = s.nslc === activeStation;
      ctx.fillStyle = isActive ? COLOR_STATION_HI : COLOR_STATION;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 0.5;
      // Upward triangle.
      ctx.beginPath();
      ctx.moveTo(x, y - size);
      ctx.lineTo(x - size, y + size * 0.7);
      ctx.lineTo(x + size, y + size * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      hitTargets.push({
        kind: 'station', x, y, r: size * 1.5, payload: s.nslc,
      });
    }
  }

  /** Event marker radius from magnitude (and a small baseline). */
  function eventRadius(m: number | null): number {
    if (m == null) return 2;
    return Math.max(2.5, Math.min(14, 2 + m * 1.4));
  }

  function drawEvents() {
    // Draw older first so newer events sit on top.
    const sorted = [...events].sort((a, b) => a.timeMs - b.timeMs);
    const now = Date.now();
    for (const e of sorted) {
      const [x, y] = project(e.lon, e.lat);
      const r = eventRadius(e.mag);
      const ageH = (now - e.timeMs) / 3_600_000;
      const alpha = Math.max(0.35, 1 - ageH / 24); // fade over 24 h
      ctx.fillStyle = magColor(e.mag);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      // Outline if selected.
      if (e.id === selectedEventId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      hitTargets.push({
        kind: 'event', x, y, r: r + 2, payload: e,
      });
    }
  }

  function draw() {
    if (cssW < 2 || cssH < 2) return;
    hitTargets.length = 0;
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, cssW, cssH);
    drawGraticule();
    drawCoastlines();
    drawStations();
    drawEvents();
  }

  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    // Events first (drawn on top, more interesting); stations second.
    let best: HitTarget | null = null;
    let bestDist = Infinity;
    for (const h of hitTargets) {
      const dx = h.x - cx, dy = h.y - cy;
      const d = Math.hypot(dx, dy);
      if (d <= h.r && d < bestDist) {
        // Prefer events over coincident station markers — events tend to be
        // the headline action, and a station can still be selected via the
        // dropdown if buried under a cluster.
        if (!best || (h.kind === 'event' && best.kind !== 'event')) {
          best = h; bestDist = d;
        }
      }
    }
    if (!best) return;
    if (best.kind === 'event') handlers.onEventPicked(best.payload as SeismicEvent);
    else handlers.onStationPicked(best.payload as string);
  });

  return {
    setEvents(next) { events = next; draw(); },
    setActiveStation(nslc) { activeStation = nslc; draw(); },
    setSelectedEvent(id) { selectedEventId = id; draw(); },
  };
}
