import type { PanelDef } from './registry';

/** Raw scope — rolling 60-s window of the waveform, single trace. v0.2
 *  will stack the 3 components (Z/N/E). */
export const rawScope: PanelDef = {
  id: 'raw-scope',
  label: 'Raw scope',
  category: 'live',
  serverWorker: 'panels.raw_scope',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as { data?: number[] } | null;
    if (!f?.data?.length) {
      ctx.fillStyle = '#8a8a8a';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('waiting for frames…', w / 2, h / 2);
      return;
    }

    // Zero line.
    ctx.strokeStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const d = f.data;
    let m = 0;
    for (const v of d) { const a = Math.abs(v); if (a > m) m = a; }
    const scale = m > 0 ? (h / 2 - 4) / m : 1;

    ctx.strokeStyle = '#7ad';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const x = (i / (d.length - 1)) * w;
      const y = h / 2 - d[i] * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};
