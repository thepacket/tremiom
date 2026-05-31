import type { PanelDef } from './registry';

/** PSD — power spectral density. v0.1 shows the latest Welch estimate
 *  with frequency on a log X axis. v0.2 layers PPSD percentile bands. */

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
      ctx.fillText('waiting for frames…', w / 2, h / 2);
      return;
    }

    const d = f.data;
    const dbMin = -200, dbMax = -50;
    const span = dbMax - dbMin;
    const logFMin = Math.log10(Math.max(1e-3, f.fMinHz));
    const logFMax = Math.log10(Math.max(logFMin + 1e-3, f.fMaxHz));
    const logSpan = logFMax - logFMin;

    ctx.strokeStyle = '#ff8c1a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const fHz = f.fMinHz + (i / (d.length - 1)) * (f.fMaxHz - f.fMinHz);
      const lx = (Math.log10(Math.max(1e-3, fHz)) - logFMin) / logSpan;
      const x = lx * w;
      const y = h - ((d[i] - dbMin) / span) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};
