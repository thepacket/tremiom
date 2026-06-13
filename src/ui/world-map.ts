/** World map showing live USGS event epicenters and curated station
 *  markers. Equirectangular projection (longitude → x, latitude → y).
 *  Drag to pan, wheel to zoom, double-click to reset. The world tiles
 *  east–west so horizontal panning wraps infinitely.
 *
 *  Click handling routes through the same hooks the sidebar uses, so
 *  the map + sidebar stay in sync (selecting an event in either picks
 *  the same item).
 */

import coastlines from '../data/coastlines.json';
import { STATION_PRESETS } from '../data/stations';
import {
  type SeismicEvent, magColor, intensityColor,
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
const COLOR_STATION    = '#5ec8ff';  // bright cyan — pops on dark land + ocean
const COLOR_STATION_HI = '#ff8c1a';  // active station (orange)
const COLOR_BG         = '#0d0d0d';

export interface WorldMap {
  setEvents(events: SeismicEvent[]): void;
  setActiveStation(nslc: string): void;
  setSelectedEvent(eventId: string | null): void;
  setDyfi(polys: Array<{ cdi: number; ring: number[][] }>): void;
  setShakemap(
    bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null,
    imageUrl: string | null,
  ): void;
}

export function mountWorldMap(
  parent: HTMLElement,
  handlers: MapHandlers,
): WorldMap {
  const el = document.createElement('div');
  el.className = 'world-map';
  const canvas = document.createElement('canvas');
  el.appendChild(canvas);
  const tooltip = document.createElement('div');
  tooltip.className = 'map-tooltip';
  el.appendChild(tooltip);
  parent.appendChild(el);

  const ctx = canvas.getContext('2d')!;

  let cssW = 1, cssH = 1, dpr = 1;
  let events: SeismicEvent[] = [];
  let activeStation: string = STATION_PRESETS[0]?.nslc ?? '';
  let selectedEventId: string | null = null;
  const hitTargets: HitTarget[] = [];

  // View transform: zoom about the canvas centre + pixel pan offset.
  let zoom = 1, panX = 0, panY = 0;
  // Horizontal offset for the current world copy while tiling the map
  // east–west for seamless infinite panning (see draw()).
  let wrapOffset = 0;

  // DYFI felt-report polygons (event mode): [{cdi, ring:[[lon,lat]...]}].
  let dyfiPolys: Array<{ cdi: number; ring: number[][] }> = [];

  // ShakeMap modeled-intensity raster overlay (event mode).
  let shakemapImg: HTMLImageElement | null = null;
  let shakemapBbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null = null;

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

  // Default vertical framing: a populated latitude band rather than the
  // full −90…90. The map header is wide and short, so spending half its
  // height on the empty Arctic ocean and Antarctic interior squished the
  // inhabited band (where stations + most events are) and pushed the
  // northern hemisphere hard against the top edge. Framing to
  // LAT_MAX…LAT_MIN gives the northern hemisphere proper room at the
  // default view; pan/zoom still reaches the poles. LAT_MIN is kept south
  // of the southernmost curated station (PMSA, −64.8°) so all markers show.
  const LAT_MAX = 84;
  const LAT_MIN = -72;
  function project(lon: number, lat: number): [number, number] {
    const x0 = ((lon + 180) / 360) * cssW;
    const y0 = ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * cssH;
    return [
      (x0 - cssW / 2) * zoom + cssW / 2 + panX + wrapOffset,
      (y0 - cssH / 2) * zoom + cssH / 2 + panY,
    ];
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
    for (const s of STATION_PRESETS) {
      const [x, y] = project(s.lon, s.lat);
      const isActive = s.nslc === activeStation;
      const size = isActive ? 8 : 6;
      // Dark halo first so the marker reads against both dark land and
      // ocean, then the bright fill, then a white edge for extra pop.
      const tri = () => {
        ctx.beginPath();
        ctx.moveTo(x, y - size);
        ctx.lineTo(x - size, y + size * 0.75);
        ctx.lineTo(x + size, y + size * 0.75);
        ctx.closePath();
      };
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3;
      tri(); ctx.stroke();
      ctx.fillStyle = isActive ? COLOR_STATION_HI : COLOR_STATION;
      tri(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      tri(); ctx.stroke();
      hitTargets.push({
        kind: 'station', x, y, r: size * 1.6, payload: s.nslc,
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
    // Tile the world east–west so panning wraps seamlessly: draw every copy
    // whose horizontal span overlaps the viewport. One world is cssW*zoom px
    // wide; `base` is the screen-x of copy 0's left edge.
    const worldW = cssW * zoom;
    const base = cssW * (1 - zoom) / 2 + panX;
    const mStart = Math.floor((-base) / worldW) - 1;
    const mEnd   = Math.ceil((cssW - base) / worldW) + 1;
    for (let m = mStart; m <= mEnd; m++) {
      wrapOffset = m * worldW;
      drawGraticule();
      drawCoastlines();
      drawShakemap();
      drawDyfi();
      drawStations();
      drawEvents();
    }
    wrapOffset = 0;
  }

  function drawShakemap() {
    if (!shakemapImg || !shakemapBbox || !shakemapImg.complete || !shakemapImg.naturalWidth) return;
    // Equirectangular projection is separable, so the bbox maps to an
    // axis-aligned rectangle: project the NW and SE corners.
    const [x0, y0] = project(shakemapBbox.minLon, shakemapBbox.maxLat); // top-left
    const [x1, y1] = project(shakemapBbox.maxLon, shakemapBbox.minLat); // bottom-right
    ctx.globalAlpha = 0.55;
    ctx.imageSmoothingEnabled = true;
    try { ctx.drawImage(shakemapImg, x0, y0, x1 - x0, y1 - y0); } catch { /* taint/decoding */ }
    ctx.globalAlpha = 1;
  }

  function drawDyfi() {
    if (!dyfiPolys.length) return;
    for (const p of dyfiPolys) {
      ctx.beginPath();
      for (let i = 0; i < p.ring.length; i++) {
        const [x, y] = project(p.ring[i][0], p.ring[i][1]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = intensityColor(p.cdi);
      ctx.globalAlpha = 0.45;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = intensityColor(p.cdi);
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function hitAt(cx: number, cy: number): HitTarget | null {
    let best: HitTarget | null = null;
    let bestDist = Infinity;
    for (const h of hitTargets) {
      const dx = h.x - cx, dy = h.y - cy;
      const d = Math.hypot(dx, dy);
      if (d <= h.r && d < bestDist) {
        if (!best || (h.kind === 'event' && best.kind !== 'event')) {
          best = h; bestDist = d;
        }
      }
    }
    return best;
  }

  // ── Pan / zoom ──────────────────────────────────────────────────────
  // The map is fixed vertically: only horizontal panning (which wraps) and
  // zoom are allowed. panY stays 0 throughout.
  let dragging = false, dragMoved = false, dragX = 0, dragY = 0;
  let panX0 = 0;

  canvas.addEventListener('mousedown', (ev) => {
    dragging = true; dragMoved = false;
    dragX = ev.clientX; dragY = ev.clientY;
    panX0 = panX;
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - dragX, dy = ev.clientY - dragY;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
    panX = panX0 + dx; // horizontal only — vertical position is fixed
    canvas.style.cursor = 'grabbing';
    tooltip.style.display = 'none';
    draw();
  });
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; canvas.style.cursor = 'crosshair'; }
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const factor = ev.deltaY > 0 ? 1 / 1.2 : 1.2;
    const newZoom = Math.max(1, Math.min(10, zoom * factor));
    // Keep the geographic point under the cursor horizontally fixed; the
    // map zooms about its vertical centre (panY stays 0).
    const k = newZoom / zoom;
    panX = cx - k * (cx - panX);
    zoom = newZoom;
    draw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    zoom = 1; panX = 0; panY = 0; draw();
  });

  canvas.addEventListener('mousemove', (ev) => {
    if (dragging) return; // panning, no tooltip
    const rect = canvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const h = hitAt(cx, cy);
    if (!h) { tooltip.style.display = 'none'; canvas.style.cursor = 'crosshair'; return; }
    canvas.style.cursor = 'pointer';
    if (h.kind === 'event') {
      const e = h.payload as SeismicEvent;
      const m = e.mag == null ? '—' : `M${e.mag.toFixed(1)}`;
      tooltip.innerHTML = `<b>${m}</b> · ${escapeHtml(e.place)}<br><span class="muted">${e.depthKm.toFixed(0)} km depth</span>`;
    } else {
      tooltip.textContent = h.payload as string;
    }
    tooltip.style.display = 'block';
    // Position near the cursor, clamped to map bounds.
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let tx = cx + 12, ty = cy + 12;
    if (tx + tw > cssW) tx = cx - tw - 12;
    if (ty + th > cssH) ty = cy - th - 12;
    tooltip.style.left = `${tx}px`;
    tooltip.style.top  = `${ty}px`;
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    canvas.style.cursor = 'crosshair';
  });

  canvas.addEventListener('click', (ev) => {
    if (dragMoved) { dragMoved = false; return; } // it was a pan, not a click
    const rect = canvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const best = hitAt(cx, cy);
    if (!best) return;
    if (best.kind === 'event') handlers.onEventPicked(best.payload as SeismicEvent);
    else handlers.onStationPicked(best.payload as string);
  });

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    } as Record<string, string>)[ch]);
  }

  return {
    setEvents(next) { events = next; draw(); },
    setActiveStation(nslc) { activeStation = nslc; draw(); },
    setSelectedEvent(id) { selectedEventId = id; draw(); },
    setDyfi(polys: Array<{ cdi: number; ring: number[][] }>) { dyfiPolys = polys; draw(); },
    setShakemap(bbox, imageUrl) {
      shakemapBbox = bbox;
      if (!bbox || !imageUrl) { shakemapImg = null; draw(); return; }
      const img = new Image();
      img.onload = () => { if (shakemapImg === img) draw(); };
      img.src = imageUrl;
      shakemapImg = img;
      draw();
    },
  };
}
