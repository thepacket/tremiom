import type { PanelDef } from './registry';
import { AXIS_PAD, COLOR_LABEL, drawFrame } from './axes';

/** Particle motion hodogram — the trajectory of horizontal ground motion
 *  in the N–E plane. Visually distinctive in seismology: P arrivals
 *  produce nearly-linear motion along the source–receiver azimuth;
 *  S waves and surface waves produce elliptical / 2D patterns. */

interface PMFrame {
  station: string;
  t: number;
  windowS: number;
  n: number[];   // North component samples
  e: number[];   // East  component samples
  chN: string;   // channel code like "BHN"
  chE: string;
}

const COLOR_NEW = '#ff8c1a';   // most recent samples (head of the trace)
const COLOR_OLD = '#22282d';   // tail
const COLOR_GRID_LINE = '#1a2025';
const COLOR_AXIS_TEXT = '#cfd2d4';

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
  // Pick a SQUARE plot area so polarization angles read accurately
  // (a 2:1 panel would show 30° lines as 60° lines).
  const { top, bottom, left, right } = AXIS_PAD;
  const availW = Math.max(10, w - left - right);
  const availH = Math.max(10, h - top - bottom);
  const side = Math.min(availW, availH);
  const padLeft = left + (availW - side) / 2;
  const padTop  = top  + (availH - side) / 2;
  const cx = padLeft + side / 2;
  const cy = padTop  + side / 2;

  const n = f.n, e = f.e;
  const len = Math.min(n.length, e.length);

  // Auto-scale around zero. The trace's distance from origin is
  // sqrt(N² + E²) — NOT max(|N|, |E|) — so we must scale by the largest
  // vector magnitude, otherwise diagonal excursions escape the plot box.
  let m = 0;
  for (let i = 0; i < len; i++) {
    const r = Math.hypot(n[i], e[i]);
    if (r > m) m = r;
  }
  if (m === 0) m = 1;
  // 0.90 = small interior margin so the trace doesn't kiss the frame.
  const scale = (side / 2 * 0.90) / m;

  // Background: cross-hairs + circular grid rings at 0.25 / 0.5 / 0.75 / 1.0.
  ctx.strokeStyle = COLOR_GRID_LINE;
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75, 1.0]) {
    ctx.beginPath();
    ctx.arc(cx, cy, m * scale * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(padLeft, cy);
  ctx.lineTo(padLeft + side, cy);
  ctx.moveTo(cx, padTop);
  ctx.lineTo(cx, padTop + side);
  ctx.stroke();

  // Direction labels at the four cardinal edges.
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = COLOR_AXIS_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('N', cx, padTop - 2);
  ctx.textBaseline = 'bottom';
  ctx.fillText('S', cx, padTop + side + 12);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('E', padLeft + side + 2, cy);
  ctx.textAlign = 'right';
  ctx.fillText('W', padLeft - 2, cy);

  // Hodogram path: fade from old (gray) at the tail to new (orange) at
  // the head. Drawn in many short segments so the gradient is visible.
  ctx.lineWidth = 1;
  for (let i = 1; i < len; i++) {
    const t = i / (len - 1);  // 0 = oldest, 1 = newest
    // Linear blend of old/new color components.
    const r = Math.round(0x22 + (0xff - 0x22) * t);
    const g = Math.round(0x28 + (0x8c - 0x28) * t);
    const b = Math.round(0x2d + (0x1a - 0x2d) * t);
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    ctx.moveTo(cx + e[i - 1] * scale, cy - n[i - 1] * scale);
    ctx.lineTo(cx + e[i]     * scale, cy - n[i]     * scale);
    ctx.stroke();
  }

  // Most recent sample as a small filled dot — the "current" point.
  ctx.fillStyle = COLOR_NEW;
  ctx.beginPath();
  ctx.arc(cx + e[len - 1] * scale, cy - n[len - 1] * scale, 2.5, 0, Math.PI * 2);
  ctx.fill();

  drawFrame(ctx, w, h);

  // Top-right caption: window + channel codes + peak amplitude.
  ctx.fillStyle = '#cfd2d4';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(
    `${f.chN} × ${f.chE} · ${f.windowS}s · ±${fmtAmp(m)}`,
    w - 4, top - 4,
  );

  void COLOR_OLD; void COLOR_LABEL;
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
