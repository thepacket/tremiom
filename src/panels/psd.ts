import type { PanelDef } from './registry';
import {
  AXIS_PAD, COLOR_GRID, COLOR_LABEL, Y_TICK_LABEL_RIGHT_OFFSET,
  drawFrame, drawYCaption, niceStep, plotBounds,
} from './axes';

/** PSD — power spectral density. Latest Welch estimate, log-frequency
 *  X axis, auto-ranged dB on Y. */

interface PSDFrame {
  data: number[];     // dB values
  fMinHz: number;
  fMaxHz: number;
}

export const psd: PanelDef = {
  id: 'psd',
  label: 'PSD',
  category: 'live',
  serverWorker: 'panels.psd',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as PSDFrame | null;
    if (!f?.data?.length) {
      ctx.fillStyle = '#8a8a8a';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('waiting for frames…', w / 2, h / 2);
      return;
    }

    const d = f.data;

    // Auto-range Y with small headroom.
    let lo = Infinity, hi = -Infinity;
    for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(isFinite(lo) && isFinite(hi)) || hi - lo < 1) { lo = -1; hi = 1; }
    const headroom = (hi - lo) * 0.08;
    const dbMin = lo - headroom, dbMax = hi + headroom;
    const dbSpan = dbMax - dbMin;

    const pb = plotBounds(w, h);

    // Frequency on a log10 X axis from fMin..fMax. Skip the 0-Hz bin.
    const fMin = Math.max(1e-3, f.fMinHz);
    const fMax = Math.max(fMin + 1e-3, f.fMaxHz);
    const logFMin = Math.log10(fMin);
    const logFMax = Math.log10(fMax);
    const logSpan = logFMax - logFMin;

    // Y-axis (dB) grid + labels.
    ctx.strokeStyle = COLOR_GRID;
    ctx.fillStyle   = COLOR_LABEL;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yStep = niceStep(dbSpan, 4);
    for (let v = Math.ceil(dbMin / yStep) * yStep; v <= dbMax + 1e-9; v += yStep) {
      const y = pb.top + ((dbMax - v) / dbSpan) * pb.height;
      ctx.beginPath(); ctx.moveTo(pb.left, y); ctx.lineTo(pb.right, y); ctx.stroke();
      ctx.fillText(`${v.toFixed(0)}`, pb.left - Y_TICK_LABEL_RIGHT_OFFSET, y);
    }

    // X-axis (log f) decade ticks + labels.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTickStart = Math.ceil(logFMin - 1e-9);
    for (let lf = xTickStart; lf <= logFMax; lf++) {
      const hz = Math.pow(10, lf);
      const x = pb.left + ((lf - logFMin) / logSpan) * pb.width;
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath(); ctx.moveTo(x, pb.top); ctx.lineTo(x, pb.bottom); ctx.stroke();
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(`${hz}`, x, pb.bottom + 2);
    }

    // Axis captions.
    ctx.fillStyle = COLOR_LABEL;
    ctx.textAlign = 'right';
    ctx.fillText('Hz', pb.right, pb.bottom + 2);
    drawYCaption(ctx, h, 'dB');

    drawFrame(ctx, w, h);

    // Trace.
    ctx.strokeStyle = '#ff8c1a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < d.length; i++) {
      const fHz = f.fMinHz + (i / (d.length - 1)) * (f.fMaxHz - f.fMinHz);
      if (fHz <= 0) continue;
      const lx = (Math.log10(fHz) - logFMin) / logSpan;
      if (lx < 0 || lx > 1) continue;
      const x = pb.left + lx * pb.width;
      const y = pb.top + ((dbMax - d[i]) / dbSpan) * pb.height;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};

void AXIS_PAD;
