import type { PanelDef } from './registry';

/** PSD — power spectral density. v0.1 shows the latest Welch estimate
 *  with frequency on a log X axis and auto-ranged dB on Y. */

interface PSDFrame {
  data: number[];     // dB values
  fMinHz: number;
  fMaxHz: number;
}

const PAD = { top: 6, right: 8, bottom: 14, left: 36 };

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

    // Auto-range Y with a small headroom so the trace doesn't kiss
    // the top/bottom of the plot.
    let lo = Infinity, hi = -Infinity;
    for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(isFinite(lo) && isFinite(hi)) || hi - lo < 1) { lo = -1; hi = 1; }
    const headroom = (hi - lo) * 0.08;
    const dbMin = lo - headroom, dbMax = hi + headroom;
    const span  = dbMax - dbMin;

    const plotW = Math.max(10, w - PAD.left - PAD.right);
    const plotH = Math.max(10, h - PAD.top - PAD.bottom);

    // Frequency on a log10 X axis from fMin..fMax. Skip the 0-Hz bin
    // since log(0) is undefined.
    const fMin = Math.max(1e-3, f.fMinHz);
    const fMax = Math.max(fMin + 1e-3, f.fMaxHz);
    const logFMin = Math.log10(fMin);
    const logFMax = Math.log10(fMax);
    const logSpan = logFMax - logFMin;

    // Y-axis (dB) reference grid + labels.
    ctx.strokeStyle = '#1a2025';
    ctx.fillStyle   = '#8a8a8a';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yStep = niceStep(span, 5);
    for (let v = Math.ceil(dbMin / yStep) * yStep; v <= dbMax; v += yStep) {
      const y = PAD.top + ((dbMax - v) / span) * plotH;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${v.toFixed(0)}`, PAD.left - 4, y);
    }

    // X-axis (log f) decade ticks.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTickStart = Math.ceil(logFMin - 1e-9);
    for (let lf = xTickStart; lf <= logFMax; lf++) {
      const hz = Math.pow(10, lf);
      const x = PAD.left + ((lf - logFMin) / logSpan) * plotW;
      ctx.strokeStyle = '#1a2025';
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + plotH);
      ctx.stroke();
      ctx.fillStyle = '#8a8a8a';
      ctx.fillText(hz >= 1 ? `${hz}` : `${hz}`, x, PAD.top + plotH + 2);
    }
    // Axis captions.
    ctx.fillStyle = '#8a8a8a';
    ctx.textAlign = 'right';
    ctx.fillText('Hz', PAD.left + plotW, PAD.top + plotH + 2);
    ctx.save();
    ctx.translate(10, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('dB', 0, 0);
    ctx.restore();

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
      const x = PAD.left + lx * plotW;
      const y = PAD.top + ((dbMax - d[i]) / span) * plotH;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};

function niceStep(span: number, targetTicks: number): number {
  const raw = span / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  const nice = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  return nice * pow;
}
