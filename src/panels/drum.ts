import type { PanelDef } from './registry';
import { AXIS_PAD, COLOR_LABEL, drawFrame, plotBounds } from './axes';
import { magColor, type SeismicEvent } from '../data/events';

/** Helicorder drum — the iconic 24-h seismograph view. Each row covers
 *  1 hour; columns within a row are 6-second envelope buckets (min/max).
 *  Server emits a fully-shaped {rows, cols, min[], max[]} frame at ~1 Hz;
 *  the frontend just paints whatever it got. Bucket whose data is null
 *  (no samples ever, or older than 24 h ago) renders as a gap. */

interface DrumFrame {
  station: string;
  startMs: number;     // unix-ms of the OLDEST bucket's start
  endMs:   number;     // unix-ms past the NEWEST bucket's start
  rows:    number;
  cols:    number;
  bucketS: number;     // 6
  min:     Array<number | null>;
  max:     Array<number | null>;
  t:       number;     // server timestamp at frame creation
}

/** Keep the most recent frame per-station so the panel keeps showing the
 *  drum even when the panel timer skips an emit (e.g. all-NaN guard). */
const lastFrames = new Map<string, DrumFrame>();

/** Overlay state — set by the app whenever the events list refreshes
 *  or the station changes. The drum renderer reads this at draw time
 *  to mark predicted P-arrival times on the recorder. */
interface DrumOverlays {
  events: SeismicEvent[];
  stationLat: number | null;
  stationLon: number | null;
}
let overlays: DrumOverlays = { events: [], stationLat: null, stationLon: null };

export function setDrumOverlays(
  events: SeismicEvent[],
  stationLat: number | null,
  stationLon: number | null,
): void {
  overlays = { events, stationLat, stationLon };
}

export const drum: PanelDef = {
  id: 'drum',
  label: 'Helicorder',
  category: 'live',
  serverWorker: 'panels.drum',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = (frame as DrumFrame | null);
    if (f?.station && f.min && f.max) lastFrames.set(f.station, f);

    // Use the latest cached frame (handles the case where the server
    // emitted a frame for station A then briefly nothing on a re-sub).
    const cur = f && f.min ? f
      : [...lastFrames.values()].sort((a, b) => b.t - a.t)[0];
    if (!cur) {
      placeholder(ctx, w, h, 'waiting for 24 h of data…');
      return;
    }

    drawDrum(ctx, w, h, cur);
  },
};

function drawDrum(ctx: CanvasRenderingContext2D, w: number, h: number, f: DrumFrame) {
  const pb = plotBounds(w, h);
  const { rows, cols, min, max, startMs, bucketS } = f;
  const colW = pb.width  / cols;
  const rowH = pb.height / rows;

  // Per-row auto-scale — like a real drum, each line is normalized to
  // its own peak. Otherwise a single loud event would compress 23 rows
  // of quiet data into invisibility.
  for (let r = 0; r < rows; r++) {
    let rowMax = 0;
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      const lo = min[k], hi = max[k];
      if (lo != null && hi != null) {
        const a = Math.max(Math.abs(lo), Math.abs(hi));
        if (a > rowMax) rowMax = a;
      }
    }
    if (rowMax === 0) continue;
    const yMid = pb.top + rowH * (r + 0.5);
    const ampScale = (rowH * 0.42) / rowMax;

    // Trace: draw min-to-max as a tight envelope line per column.
    ctx.strokeStyle = '#7ad';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      const lo = min[k], hi = max[k];
      if (lo == null || hi == null) { started = false; continue; }
      const x = pb.left + (c + 0.5) * colW;
      const yLo = yMid - lo * ampScale;
      const yHi = yMid - hi * ampScale;
      if (!started) {
        ctx.moveTo(x, yLo);
        started = true;
      } else {
        ctx.lineTo(x, yLo);
      }
      ctx.lineTo(x, yHi);
    }
    ctx.stroke();
  }

  // Faint row separators.
  ctx.strokeStyle = '#15191c';
  ctx.lineWidth = 1;
  for (let r = 1; r < rows; r++) {
    const y = pb.top + rowH * r;
    ctx.beginPath();
    ctx.moveTo(pb.left, y);
    ctx.lineTo(pb.right, y);
    ctx.stroke();
  }

  // Y-axis: time of day for each row (UTC start of row).
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = COLOR_LABEL;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const rowSpanS = cols * bucketS; // 3600 s for a 24-row × 600-col drum
  const labelEvery = Math.max(1, Math.floor(rows / 12));
  for (let r = 0; r < rows; r++) {
    if (r % labelEvery !== 0) continue;
    const t = new Date(startMs + r * rowSpanS * 1000);
    const hh = t.getUTCHours().toString().padStart(2, '0');
    const mm = t.getUTCMinutes().toString().padStart(2, '0');
    const y = pb.top + rowH * (r + 0.5);
    ctx.fillText(`${hh}:${mm}`, pb.left - 4, y);
  }

  // Y-caption: "UTC"
  ctx.save();
  ctx.translate(8, pb.top + pb.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = COLOR_LABEL;
  ctx.fillText('UTC', 0, 0);
  ctx.restore();

  // X-axis: minutes within a row (each row is 60 min).
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const rowMinutes = rowSpanS / 60;
  const xStep = rowMinutes >= 60 ? 10 : Math.max(1, Math.floor(rowMinutes / 4));
  for (let m = 0; m <= rowMinutes; m += xStep) {
    const x = pb.left + (m / rowMinutes) * pb.width;
    ctx.fillText(`${m}m`, x, pb.bottom + 2);
  }

  // Event arrival markers (predicted P arrival from each USGS event).
  // Skipped silently if we don't know the station's lat/lon.
  if (overlays.stationLat != null && overlays.stationLon != null) {
    drawArrivalMarkers(ctx, pb, f, overlays);
  }

  drawFrame(ctx, w, h);

  // Span label (top-right): "24 h · 6 s/col"
  ctx.fillStyle = '#cfd2d4';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const hours = (rows * rowSpanS) / 3600;
  ctx.fillText(`${hours.toFixed(0)} h · ${bucketS} s/col`, pb.right - 4, pb.top + 2);
}

/** Crude single-velocity P-wave time of flight in seconds. Good enough
 *  for plotting "approximate arrival" markers on a row that's already
 *  3600 s wide. The Event-mode record section uses TauP for precise
 *  arrivals. */
const P_VELOCITY_KM_S = 8.0;

function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function drawArrivalMarkers(
  ctx: CanvasRenderingContext2D,
  pb: { left: number; right: number; top: number; bottom: number; width: number; height: number },
  f: DrumFrame,
  ov: DrumOverlays,
) {
  const { rows, cols, bucketS, startMs } = f;
  const rowSpanS = cols * bucketS;
  const rowH = pb.height / rows;
  const endMs = startMs + rows * rowSpanS * 1000;
  const stLat = ov.stationLat!;
  const stLon = ov.stationLon!;
  for (const e of ov.events) {
    if (e.mag == null) continue;
    const distKm = greatCircleKm(stLat, stLon, e.lat, e.lon);
    const arrivalMs = e.timeMs + (distKm / P_VELOCITY_KM_S) * 1000;
    if (arrivalMs < startMs || arrivalMs >= endMs) continue;
    const offsetMs = arrivalMs - startMs;
    const row = Math.floor(offsetMs / (rowSpanS * 1000));
    const colT = (offsetMs - row * rowSpanS * 1000) / 1000; // s within row
    const x = pb.left + (colT / rowSpanS) * pb.width;
    const yMid = pb.top + rowH * (row + 0.5);
    const r = Math.max(2.5, Math.min(7, 2 + e.mag * 0.9));
    ctx.fillStyle = magColor(e.mag);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(x, yMid, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // Thin vertical tick down through the row so the marker reads as
    // "an arrival happened at this clock time".
    ctx.strokeStyle = magColor(e.mag);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, pb.top + rowH * row + 2);
    ctx.lineTo(x, pb.top + rowH * (row + 1) - 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function placeholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}

/** Clear cached frames for a station — call when unsubscribing/switching. */
export function resetDrum(station?: string): void {
  if (station) lastFrames.delete(station);
  else lastFrames.clear();
}

void AXIS_PAD;
