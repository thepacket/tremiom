import type { PanelDef } from './registry';
import {
  AXIS_PAD, drawFrame, drawTimeAxisSecondsBack, drawYAxis, plotBounds,
} from './axes';

/** Helicorder — for v0.1 a single-trace 60 s rolling window with axes.
 *  The classic 24-h drum display lands in a later version. */
export const helicorder: PanelDef = {
  id: 'helicorder',
  label: 'Helicorder',
  category: 'live',
  serverWorker: 'panels.helicorder',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as { data?: number[]; windowS?: number } | null;
    if (!f?.data?.length) {
      drawPlaceholder(ctx, w, h, 'waiting for frames…');
      return;
    }

    const data = f.data;
    const windowS = f.windowS ?? 60;

    // Auto-range with small headroom so the trace doesn't touch the frame.
    let lo = Infinity, hi = -Infinity;
    for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(isFinite(lo) && isFinite(hi)) || hi - lo < 1) { lo = -1; hi = 1; }
    const headroom = (hi - lo) * 0.08;
    const yMin = lo - headroom, yMax = hi + headroom;

    drawYAxis(ctx, w, h, yMin, yMax, { unit: 'counts', ticks: 4 });
    drawTimeAxisSecondsBack(ctx, w, h, windowS, { ticks: 5 });
    drawFrame(ctx, w, h);

    // Trace.
    const pb = plotBounds(w, h);
    const span = Math.max(1e-9, yMax - yMin);
    ctx.strokeStyle = '#ff8c1a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = pb.left + (i / (data.length - 1)) * pb.width;
      const y = pb.top + ((yMax - data[i]) / span) * pb.height;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};

function drawPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}

// Re-export so unused-imports lint doesn't complain in some builds.
void AXIS_PAD;
