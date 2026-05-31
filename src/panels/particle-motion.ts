import type { PanelDef } from './registry';

/** Particle motion hodogram — the trajectory of horizontal ground motion
 *  in the N–E (or 1–2) plane. The plot frame is a COMPLETE CIRCLE — its
 *  radius is the largest one that fits inside the panel after reserving
 *  space for the N/S/E/W cardinal labels. The trace is clipped to that
 *  circle, so a sample at the auto-scaled peak lands exactly on the
 *  outer ring and nothing ever escapes.
 *
 *  P arrivals produce nearly-linear motion along the source-receiver
 *  azimuth; S waves + surface waves produce elliptical / 2D patterns.
 */

interface PMFrame {
  station: string;
  t: number;
  windowS: number;
  n: number[];   // North component samples
  e: number[];   // East  component samples
  chN: string;   // channel code like "BHN" or "BH1"
  chE: string;
}

const COLOR_HEAD       = '#ff8c1a';   // most recent sample dot
const COLOR_OLD        = 0x22282d;    // tail color (packed RGB)
const COLOR_NEW        = 0xff8c1a;    // head color (packed RGB)
const COLOR_FRAME      = '#3a4248';
const COLOR_GRID_INNER = '#1a2025';
const COLOR_AXIS_TEXT  = '#cfd2d4';
const COLOR_CAPTION    = '#cfd2d4';

// Reserved space (px) for the cardinal labels OUTSIDE the circle.
const LABEL_BAND = 14;
// Gap between the circle and a label.
const LABEL_GAP  = 4;
// A tiny inner edge inset so the outer stroke isn't cropped by the box.
const EDGE_INSET = 2;

export const particleMotion: PanelDef = {
  id: 'particle-motion',
  label: 'Particle motion (N / E)',
  category: 'live',
  serverWorker: 'panels.particle_motion',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as PMFrame | null;
    if (!f?.n?.length || !f?.e?.length) {
      placeholder(ctx, w, h, 'waiting for N + E components…');
      return;
    }
    drawHodogram(ctx, w, h, f);
  },
};

function drawHodogram(ctx: CanvasRenderingContext2D, w: number, h: number, f: PMFrame) {
  // Largest circle that fits inside the panel after reserving label band
  // + an inset, on every side. min(W, H) governs — the circle is
  // perfectly round, never an oval.
  const reserve = LABEL_BAND + LABEL_GAP + EDGE_INSET;
  const outerR = Math.max(8, (Math.min(w, h) - 2 * reserve) / 2);
  const cx = w / 2;
  const cy = h / 2;

  // Auto-scale: the trace's peak vector magnitude maps to the outer
  // circle exactly — so every sample fits, and a sample at the peak
  // exactly touches the frame.
  const n = f.n, e = f.e;
  const len = Math.min(n.length, e.length);
  let m = 0;
  for (let i = 0; i < len; i++) {
    const r = Math.hypot(n[i], e[i]);
    if (r > m) m = r;
  }
  if (m === 0) m = 1;
  const scale = outerR / m;

  // ── Inner grid rings at 0.25, 0.5, 0.75 of peak.
  ctx.strokeStyle = COLOR_GRID_INNER;
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.arc(cx, cy, outerR * frac, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ── Cross-hairs (only inside the outer circle).
  ctx.beginPath();
  ctx.moveTo(cx - outerR, cy); ctx.lineTo(cx + outerR, cy);
  ctx.moveTo(cx, cy - outerR); ctx.lineTo(cx, cy + outerR);
  ctx.stroke();

  // ── Outer circle = the plot frame. Drawn at 1.5 px so it reads as a
  // boundary, not "just another grid ring".
  ctx.strokeStyle = COLOR_FRAME;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.stroke();

  // ── Cardinal labels just outside the outer circle.
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = COLOR_AXIS_TEXT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('N', cx, cy - outerR - LABEL_GAP);
  ctx.textBaseline = 'top';
  ctx.fillText('S', cx, cy + outerR + LABEL_GAP);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('E', cx + outerR + LABEL_GAP, cy);
  ctx.textAlign = 'right';
  ctx.fillText('W', cx - outerR - LABEL_GAP, cy);

  // ── Trace, clipped to the circle (belt-and-braces: scale already
  // keeps every sample inside, but clipping protects against any future
  // bug in the scale math).
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.clip();

  // Gradient from gray (oldest) → orange (newest), 24-bit packed
  // interpolation so we don't allocate strings repeatedly.
  ctx.lineWidth = 1;
  const oldR = (COLOR_OLD >> 16) & 0xff, oldG = (COLOR_OLD >> 8) & 0xff, oldB = COLOR_OLD & 0xff;
  const newR = (COLOR_NEW >> 16) & 0xff, newG = (COLOR_NEW >> 8) & 0xff, newB = COLOR_NEW & 0xff;
  for (let i = 1; i < len; i++) {
    const t = i / (len - 1);
    const rC = Math.round(oldR + (newR - oldR) * t);
    const gC = Math.round(oldG + (newG - oldG) * t);
    const bC = Math.round(oldB + (newB - oldB) * t);
    ctx.strokeStyle = `rgb(${rC},${gC},${bC})`;
    ctx.beginPath();
    ctx.moveTo(cx + e[i - 1] * scale, cy - n[i - 1] * scale);
    ctx.lineTo(cx + e[i]     * scale, cy - n[i]     * scale);
    ctx.stroke();
  }

  // Most recent sample dot.
  ctx.fillStyle = COLOR_HEAD;
  ctx.beginPath();
  ctx.arc(cx + e[len - 1] * scale, cy - n[len - 1] * scale, 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // ── Caption at the very top-right corner of the canvas.
  ctx.fillStyle = COLOR_CAPTION;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(
    `${f.chN} × ${f.chE} · ${f.windowS}s · ±${fmtAmp(m)}`,
    w - 4, 4,
  );
}

function fmtAmp(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 10)  return `${v.toFixed(0)}`;
  return `${v.toFixed(1)}`;
}

function placeholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}
