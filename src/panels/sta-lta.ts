import type { PanelDef } from './registry';
import {
  AXIS_PAD, COLOR_LABEL, drawFrame, drawTimeAxisSecondsBack, drawYAxis, plotBounds,
} from './axes';

/** STA/LTA — classic event-detection trigger ratio. Plots the ratio of
 *  short-term-average |signal| over long-term-average |signal| against
 *  time, with a horizontal threshold line. Periods above the threshold
 *  are shaded — that's the "something is happening" indicator.
 */

interface StaLtaFrame {
  data: number[];
  windowS: number;
  staWinS: number;
  ltaWinS: number;
  threshold: number;
  sr: number;
  t: number;
}

const COLOR_TRACE     = '#ffd54f';
const COLOR_THRESHOLD = '#c0392b';
const COLOR_FILL      = 'rgba(231, 76, 60, 0.18)';

export const staLta: PanelDef = {
  id: 'sta-lta',
  label: 'STA/LTA',
  category: 'live',
  serverWorker: 'panels.sta_lta',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as StaLtaFrame | null;
    if (!f?.data?.length) {
      // STA/LTA needs LTA_WIN_S (10s) of samples before it can emit, so
      // there's a real warm-up gap after subscribe. Name it.
      placeholder(ctx, w, h, 'STA/LTA warming up (needs 10 s of data)…');
      return;
    }

    const d = f.data;
    // Y range: 0 to max(threshold + headroom, peak + headroom). Always
    // include the threshold line in the visible area even if no trace
    // value comes close to it.
    let peak = 0;
    for (const v of d) if (v > peak) peak = v;
    const yMax = Math.max(peak, f.threshold) * 1.15;
    const yMin = 0;

    drawYAxis(ctx, w, h, yMin, yMax, { unit: 'STA/LTA', ticks: 4 });
    drawTimeAxisSecondsBack(ctx, w, h, f.windowS, { ticks: 5 });
    drawFrame(ctx, w, h);

    const pb = plotBounds(w, h);
    const span = yMax - yMin;
    const xForI = (i: number) => pb.left + (i / Math.max(1, d.length - 1)) * pb.width;
    const yForV = (v: number) => pb.top + ((yMax - v) / span) * pb.height;

    // Fill polygon for above-threshold regions (red wash).
    ctx.fillStyle = COLOR_FILL;
    let inRegion = false;
    let path: [number, number][] = [];
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v >= f.threshold && !inRegion) {
        inRegion = true;
        path = [[xForI(i), yForV(f.threshold)], [xForI(i), yForV(v)]];
      } else if (v >= f.threshold) {
        path.push([xForI(i), yForV(v)]);
      } else if (inRegion) {
        path.push([xForI(i - 1), yForV(f.threshold)]);
        ctx.beginPath();
        ctx.moveTo(path[0][0], path[0][1]);
        for (const p of path.slice(1)) ctx.lineTo(p[0], p[1]);
        ctx.closePath();
        ctx.fill();
        inRegion = false;
      }
    }
    if (inRegion) {
      path.push([xForI(d.length - 1), yForV(f.threshold)]);
      ctx.beginPath();
      ctx.moveTo(path[0][0], path[0][1]);
      for (const p of path.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.closePath();
      ctx.fill();
    }

    // Threshold line.
    ctx.strokeStyle = COLOR_THRESHOLD;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    const yT = yForV(f.threshold);
    ctx.beginPath();
    ctx.moveTo(pb.left, yT);
    ctx.lineTo(pb.right, yT);
    ctx.stroke();
    ctx.setLineDash([]);

    // Trace itself — slightly thicker line so it reads against the
    // dashed threshold and dark background.
    ctx.strokeStyle = COLOR_TRACE;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const x = xForI(i);
      const y = yForV(d[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Top-right caption: current peak + threshold.
    ctx.fillStyle = '#cfd2d4';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const curPeak = Math.max(...d).toFixed(2);
    ctx.fillText(
      `peak ${curPeak}  ·  thr ${f.threshold.toFixed(1)}  ·  ${f.staWinS}s/${f.ltaWinS}s`,
      pb.right - 4, pb.top + 2,
    );

    // Mute the COLOR_LABEL reference (unused warning when no caption).
    void COLOR_LABEL;
  },
};

function placeholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}

void AXIS_PAD;
