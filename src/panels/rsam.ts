import type { PanelDef } from './registry';
import {
  COLOR_LABEL, drawFrame, drawYCaption, niceStep, plotBounds,
  Y_TICK_LABEL_RIGHT_OFFSET,
} from './axes';

/** RSAM — Real-time Seismic Amplitude Measurement. Mean |ground motion|
 *  in fixed time bins (1 min) over the past 24 h, drawn as a filled
 *  area against a UTC time axis. The volcano-monitoring community's
 *  primary tracker: a sustained baseline rise flags tremor / eruption
 *  onset that individual events on the drum can miss. */

interface RsamFrame {
  station: string;
  t: number;
  startMs: number;            // unix-ms of the first bin's start
  binS: number;               // seconds per bin (60)
  data: Array<number | null>; // mean-abs amplitude per bin; null = no data
}

const lastFrames = new Map<string, RsamFrame>();

const COLOR_FILL = 'rgba(255, 140, 26, 0.20)';
const COLOR_LINE = '#ff8c1a';

export const rsam: PanelDef = {
  id: 'rsam',
  label: 'RSAM',
  category: 'live',
  serverWorker: 'panels.rsam',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as RsamFrame | null;
    if (f?.station && f.data) lastFrames.set(f.station, f);
    const cur = f && f.data ? f
      : [...lastFrames.values()].sort((a, b) => b.t - a.t)[0];
    if (!cur) { placeholder(ctx, w, h, 'waiting for 24 h of data…'); return; }

    drawRsam(ctx, w, h, cur);
  },
};

function drawRsam(ctx: CanvasRenderingContext2D, w: number, h: number, f: RsamFrame) {
  const pb = plotBounds(w, h);
  const d = f.data;
  const n = d.length;

  // Auto-range Y from the finite values, 0-based (amplitude is ≥0).
  let hi = 0;
  let anyFinite = false;
  for (const v of d) {
    if (v != null && isFinite(v)) { anyFinite = true; if (v > hi) hi = v; }
  }
  if (!anyFinite) { placeholder(ctx, w, h, 'RSAM accumulating…'); return; }
  const yMax = hi * 1.1 || 1;
  const yMin = 0;
  const span = yMax - yMin;

  const xForI = (i: number) => pb.left + (i / Math.max(1, n - 1)) * pb.width;
  const yForV = (v: number) => pb.top + ((yMax - v) / span) * pb.height;

  // Y grid + labels (amplitude in counts).
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  const yStep = niceStep(span, 4);
  const labelHalf = 5;
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    const y = yForV(v);
    ctx.strokeStyle = '#1a2025';
    ctx.beginPath(); ctx.moveTo(pb.left, y); ctx.lineTo(pb.right, y); ctx.stroke();
    ctx.fillStyle = COLOR_LABEL;
    ctx.textAlign = 'right';
    const ly = Math.max(pb.top + labelHalf, Math.min(pb.bottom - labelHalf, y));
    ctx.fillText(fmtAmp(v), pb.left - Y_TICK_LABEL_RIGHT_OFFSET, ly);
  }
  drawYCaption(ctx, h, 'mean |amp|');

  // X axis: UTC hour ticks across the 24 h window.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const totalMs = n * f.binS * 1000;
  const hourMs = 3600_000;
  // Label every 3rd hour to avoid crowding on a narrow panel.
  const stepHours = pb.width < 500 ? 6 : 3;
  for (let hMs = 0; hMs <= totalMs; hMs += stepHours * hourMs) {
    const x = pb.left + (hMs / totalMs) * pb.width;
    ctx.strokeStyle = '#1a2025';
    ctx.beginPath(); ctx.moveTo(x, pb.top); ctx.lineTo(x, pb.bottom); ctx.stroke();
    const date = new Date(f.startMs + hMs);
    const hh = date.getUTCHours().toString().padStart(2, '0');
    ctx.fillStyle = COLOR_LABEL;
    ctx.fillText(`${hh}:00`, x, pb.bottom + 2);
  }

  drawFrame(ctx, w, h);

  // Filled area + line. Gaps (null) break the path so missing data
  // reads as a gap, not a line to zero.
  ctx.fillStyle = COLOR_FILL;
  ctx.strokeStyle = COLOR_LINE;
  ctx.lineWidth = 1;
  let runStart = -1;
  const flush = (end: number) => {
    if (runStart < 0) return;
    // Area.
    ctx.beginPath();
    ctx.moveTo(xForI(runStart), yForV(0));
    for (let i = runStart; i <= end; i++) ctx.lineTo(xForI(i), yForV(d[i] as number));
    ctx.lineTo(xForI(end), yForV(0));
    ctx.closePath();
    ctx.fill();
    // Line on top.
    ctx.beginPath();
    for (let i = runStart; i <= end; i++) {
      const x = xForI(i), y = yForV(d[i] as number);
      if (i === runStart) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  for (let i = 0; i < n; i++) {
    const v = d[i];
    if (v == null || !isFinite(v)) { if (runStart >= 0) { flush(i - 1); runStart = -1; } }
    else if (runStart < 0) runStart = i;
  }
  if (runStart >= 0) flush(n - 1);

  // Caption.
  ctx.fillStyle = '#cfd2d4';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const mins = (f.binS / 60).toFixed(0);
  ctx.fillText(`24 h · ${mins} min bins · UTC`, pb.right - 4, pb.top + 2);
}

function fmtAmp(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 10)  return `${v.toFixed(0)}`;
  if (a >= 1)   return `${v.toFixed(1)}`;
  return `${v.toFixed(2)}`;
}

function placeholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}

/** Drop cached frame for a station — call on unsubscribe / switch. */
export function resetRsam(station?: string): void {
  if (station) lastFrames.delete(station);
  else lastFrames.clear();
}
