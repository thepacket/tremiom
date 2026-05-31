import type { PanelDef } from './registry';
import { drawFrame, drawTimeAxisSecondsBack, drawYAxis, plotBounds } from './axes';

/** Raw scope — rolling waveform window with axes. v0.2 will stack the
 *  3 components (Z/N/E). */
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

    const f = frame as { data?: number[]; windowS?: number } | null;
    if (!f?.data?.length) {
      ctx.fillStyle = '#8a8a8a';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('waiting for frames…', w / 2, h / 2);
      return;
    }

    const d = f.data;
    const windowS = f.windowS ?? 10;

    // Symmetric auto-range around zero so the baseline always sits in
    // the middle — easier to read polarity at a glance.
    let m = 0;
    for (const v of d) { const a = Math.abs(v); if (a > m) m = a; }
    if (!isFinite(m) || m === 0) m = 1;
    const headroom = m * 0.08;
    const yMax = m + headroom;
    const yMin = -yMax;

    drawYAxis(ctx, w, h, yMin, yMax, { unit: 'counts', ticks: 4 });
    drawTimeAxisSecondsBack(ctx, w, h, windowS, { ticks: 5 });
    drawFrame(ctx, w, h);

    const pb = plotBounds(w, h);

    // Zero baseline (subtle, in plot area).
    ctx.strokeStyle = '#22282d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pb.left, pb.top + pb.height / 2);
    ctx.lineTo(pb.left + pb.width, pb.top + pb.height / 2);
    ctx.stroke();

    // Trace.
    const span = yMax - yMin;
    ctx.strokeStyle = '#7ad';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const x = pb.left + (i / (d.length - 1)) * pb.width;
      const y = pb.top + ((yMax - d[i]) / span) * pb.height;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};
