import type { PanelDef } from './registry';
import {
  COLOR_LABEL, drawTimeAxisSecondsBack, niceStep, plotBounds, AXIS_PAD,
} from './axes';

/** 3-component scope — Z, N(/1), E(/2) traces stacked vertically over a
 *  shared time window. The standard view for reading wave type: the
 *  same arrival appears on all three, and how its energy splits between
 *  vertical and horizontal tells P from S from surface waves. Each lane
 *  auto-scales independently so a quiet component is still legible next
 *  to a loud one. */

interface Comp { label: string; data: number[]; }
interface ThreeCompFrame {
  station: string;
  t: number;
  windowS: number;
  unit?: string;
  components: Comp[];
}

const TRACE_COLORS = ['#ff8c1a', '#7ad', '#7c5']; // Z, N/1, E/2

export const threeComp: PanelDef = {
  id: 'three-comp',
  label: '3-component (Z/N/E)',
  category: 'live',
  serverWorker: 'panels.three_comp',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as ThreeCompFrame | null;
    if (!f?.components?.length) {
      placeholder(ctx, w, h, 'waiting for Z / N / E components…');
      return;
    }

    const pb = plotBounds(w, h);
    const comps = f.components;
    const laneH = pb.height / comps.length;

    // X axis (shared, seconds back) drawn once at the bottom.
    drawTimeAxisSecondsBack(ctx, w, h, f.windowS, { ticks: 5 });

    comps.forEach((c, li) => {
      const laneTop = pb.top + li * laneH;
      const laneMid = laneTop + laneH / 2;
      const d = c.data;

      // Per-lane symmetric auto-scale around zero.
      let m = 0;
      for (const v of d) { const a = Math.abs(v); if (a > m) m = a; }
      if (m === 0) m = 1;
      const ampScale = (laneH * 0.42) / m;

      // Lane separator.
      if (li > 0) {
        ctx.strokeStyle = '#22282d';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pb.left, laneTop);
        ctx.lineTo(pb.right, laneTop);
        ctx.stroke();
      }

      // Zero baseline.
      ctx.strokeStyle = '#161b1e';
      ctx.beginPath();
      ctx.moveTo(pb.left, laneMid);
      ctx.lineTo(pb.right, laneMid);
      ctx.stroke();

      // Trace.
      ctx.strokeStyle = TRACE_COLORS[li % TRACE_COLORS.length];
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < d.length; i++) {
        const x = pb.left + (i / Math.max(1, d.length - 1)) * pb.width;
        const y = laneMid - d[i] * ampScale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Lane label (channel code) + peak amplitude, top-left of lane.
      ctx.fillStyle = TRACE_COLORS[li % TRACE_COLORS.length];
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(c.label, pb.left + 4, laneTop + 3);
      ctx.fillStyle = COLOR_LABEL;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      const unit = f.unit && f.unit !== 'counts' ? ` ${f.unit}` : '';
      ctx.fillText(`±${fmtAmp(m)}${unit}`, pb.right - 4, laneTop + 3);
    });

    // Outer frame.
    ctx.strokeStyle = '#3a4248';
    ctx.lineWidth = 1;
    ctx.strokeRect(pb.left, pb.top, pb.width, pb.height);
  },
};

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

void niceStep; void AXIS_PAD;
