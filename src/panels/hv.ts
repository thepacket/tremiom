import type { PanelDef } from './registry';
import {
  COLOR_GRID, COLOR_LABEL, Y_TICK_LABEL_RIGHT_OFFSET,
  drawFrame, drawYCaption, niceStep, plotBounds,
} from './axes';

/** H/V spectral ratio (Nakamura) — horizontal-to-vertical ambient-noise
 *  spectral ratio. The peak frequency marks the site's fundamental
 *  resonance (soft soil → low-frequency peak); the standard quick
 *  site-response characterization. Log-frequency X, ratio Y. */

interface HvFrame {
  data: number[];
  fMinHz: number;
  fMaxHz: number;
  peakHz: number | null;
  chN: string;
  chE: string;
}

export const hv: PanelDef = {
  id: 'hv',
  label: 'H/V ratio',
  category: 'live',
  serverWorker: 'panels.hv',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as HvFrame | null;
    if (!f?.data?.length) {
      placeholder(ctx, w, h, 'waiting for Z + horizontals (60 s)…');
      return;
    }

    const d = f.data;
    const pb = plotBounds(w, h);
    const fMin = Math.max(0.05, f.fMinHz);
    const fMax = Math.max(fMin + 1e-3, f.fMaxHz);
    const lfMin = Math.log10(fMin), lfMax = Math.log10(fMax);
    const lfSpan = lfMax - lfMin;

    // Y: ratio, 0-based, auto-ranged to peak.
    let hi = 1;
    for (const v of d) if (isFinite(v) && v > hi) hi = v;
    const yMax = hi * 1.1, yMin = 0, span = yMax - yMin;
    const xForF = (hz: number) => pb.left + ((Math.log10(hz) - lfMin) / lfSpan) * pb.width;
    const yForV = (v: number) => pb.top + ((yMax - v) / span) * pb.height;

    // Y grid + labels.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const yStep = niceStep(span, 4);
    for (let v = 0; v <= yMax + 1e-9; v += yStep) {
      const y = yForV(v);
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath(); ctx.moveTo(pb.left, y); ctx.lineTo(pb.right, y); ctx.stroke();
      ctx.fillStyle = COLOR_LABEL; ctx.textAlign = 'right';
      const ly = Math.max(pb.top + 5, Math.min(pb.bottom - 5, y));
      ctx.fillText(v.toFixed(1), pb.left - Y_TICK_LABEL_RIGHT_OFFSET, ly);
    }
    drawYCaption(ctx, h, 'H/V');

    // "ratio = 1" reference line (no amplification).
    const y1 = yForV(1);
    ctx.strokeStyle = '#3a4248';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pb.left, y1); ctx.lineTo(pb.right, y1); ctx.stroke();
    ctx.setLineDash([]);

    // X decade ticks.
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let lf = Math.ceil(lfMin - 1e-9); lf <= lfMax; lf++) {
      const hz = Math.pow(10, lf);
      const x = xForF(hz);
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath(); ctx.moveTo(x, pb.top); ctx.lineTo(x, pb.bottom); ctx.stroke();
      ctx.fillStyle = COLOR_LABEL; ctx.fillText(`${hz}`, x, pb.bottom + 2);
    }
    ctx.fillStyle = COLOR_LABEL; ctx.textAlign = 'right';
    ctx.fillText('Hz', pb.right, pb.bottom + 2);

    drawFrame(ctx, w, h);

    // Curve.
    ctx.strokeStyle = '#ff8c1a';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < d.length; i++) {
      const hz = f.fMinHz + (i / (d.length - 1)) * (f.fMaxHz - f.fMinHz);
      if (hz < fMin) continue;
      const x = xForF(hz), y = yForV(d[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Peak marker.
    if (f.peakHz) {
      const x = xForF(f.peakHz);
      ctx.strokeStyle = '#ffd54f';
      ctx.beginPath(); ctx.moveTo(x, pb.top); ctx.lineTo(x, pb.bottom); ctx.stroke();
      ctx.fillStyle = '#ffd54f'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`f₀ ${f.peakHz.toFixed(2)} Hz`, x + 3, pb.top + 2);
    }

    // Caption.
    ctx.fillStyle = '#cfd2d4'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(`${f.chN}+${f.chE} / Z`, pb.right - 4, pb.top + 2);
  },
};

function placeholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}
