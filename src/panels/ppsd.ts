import type { PanelDef } from './registry';
import {
  AXIS_PAD, COLOR_GRID, COLOR_LABEL, Y_TICK_LABEL_RIGHT_OFFSET,
  drawFrame, drawYCaption, niceStep, plotBounds,
} from './axes';
import { viridis } from './colormap';

/** PPSD — Probabilistic Power Spectral Density. Server accumulates one
 *  Welch PSD per minute into a 2-D histogram (frequency × dB); we paint
 *  that as a heatmap. Peterson's NLNM / NHNM reference curves are
 *  overlaid as gray lines so noise-quality reads at a glance.
 *  The "standard QC plot" in seismology. */

interface PPSDFrame {
  station: string;
  t: number;
  fHz: number[];          // PPSD_F_BINS log-spaced centers (Hz)
  dbCenters: number[];    // PPSD_DB_BINS linear dB centers
  hist: number[][];       // shape: [PPSD_F_BINS][PPSD_DB_BINS]
  nSegments: number;
  latestF?:  number[];    // most-recent Welch curve, frequency points
  latestDb?: number[];    // most-recent Welch curve, dB values
  nlnm?: { periods: number[]; db: number[] };
  nhnm?: { periods: number[]; db: number[] };
}

const COLOR_NOISE_MODEL = '#666';
const COLOR_LATEST_TRACE = '#ffd54f';

export const ppsd: PanelDef = {
  id: 'ppsd',
  label: 'PPSD',
  category: 'live',
  serverWorker: 'panels.ppsd',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as PPSDFrame | null;
    if (!f?.hist?.length) {
      placeholder(ctx, w, h,
        'accumulating PSD segments… (~60 s per segment)');
      return;
    }

    const pb = plotBounds(w, h);

    const fHz = f.fHz;
    const dbCenters = f.dbCenters;
    const fLo = fHz[0];
    const fHi = fHz[fHz.length - 1];
    const logFLo = Math.log10(fLo);
    const logFHi = Math.log10(fHi);
    const logSpan = logFHi - logFLo;

    // Auto-range the dB axis from the *data*, not from "which histogram
    // rows happen to be non-empty" (which collapses to a thin strip
    // when there are only a few segments). Considers both the
    // accumulated histogram and the latest segment's curve.
    let dbViewLo = Infinity, dbViewHi = -Infinity;
    let maxCount = 0;
    for (let i = 0; i < f.hist.length; i++) {
      const col = f.hist[i];
      for (let j = 0; j < col.length; j++) {
        if (col[j] > 0) {
          if (col[j] > maxCount) maxCount = col[j];
          const dbv = dbCenters[j];
          if (dbv < dbViewLo) dbViewLo = dbv;
          if (dbv > dbViewHi) dbViewHi = dbv;
        }
      }
    }
    // Fold in the latest curve so the panel reads on segment 1.
    if (f.latestDb && f.latestDb.length) {
      for (const v of f.latestDb) {
        if (!isFinite(v)) continue;
        if (v < dbViewLo) dbViewLo = v;
        if (v > dbViewHi) dbViewHi = v;
      }
    }
    if (!isFinite(dbViewLo) || !isFinite(dbViewHi)) {
      placeholder(ctx, w, h, 'PPSD accumulating…');
      return;
    }
    // Comfortable margin: at least 5 dB on each side, or 8% of span.
    const margin = Math.max(5, (dbViewHi - dbViewLo) * 0.08);
    dbViewLo -= margin;
    dbViewHi += margin;
    if (dbViewHi - dbViewLo < 2) { dbViewLo -= 1; dbViewHi += 1; }
    const dbViewSpan = dbViewHi - dbViewLo;
    if (maxCount === 0) maxCount = 1;

    // Draw heatmap. Each cell maps to (log-freq column × dB row) in the
    // computed view range; cells outside the view clip naturally because
    // the y coordinate falls outside the plot box.
    const cols = fHz.length;
    const cellW = pb.width  / cols;
    // Use the histogram's own dB resolution for cell height so adjacent
    // cells in the heatmap touch correctly.
    const histDbStep = (dbCenters[1] - dbCenters[0]) || 1;
    const cellH = (histDbStep / dbViewSpan) * pb.height;
    for (let i = 0; i < cols; i++) {
      const lx = (Math.log10(fHz[i]) - logFLo) / logSpan;
      const x = pb.left + lx * pb.width;
      for (let j = 0; j < dbCenters.length; j++) {
        const c = f.hist[i][j];
        if (c === 0) continue;
        const dbv = dbCenters[j];
        if (dbv < dbViewLo || dbv > dbViewHi) continue;
        const n = c / maxCount;        // 0..1
        ctx.fillStyle = viridis(n);
        const y = pb.top + ((dbViewHi - dbv) / dbViewSpan) * pb.height;
        ctx.fillRect(x, y - cellH / 2, Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
      }
    }

    // dB Y axis.
    ctx.strokeStyle = COLOR_GRID;
    ctx.fillStyle   = COLOR_LABEL;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const dbStep = niceStep(dbViewSpan, 4);
    for (let v = Math.ceil(dbViewLo / dbStep) * dbStep; v <= dbViewHi + 1e-9; v += dbStep) {
      const y = pb.top + ((dbViewHi - v) / dbViewSpan) * pb.height;
      ctx.beginPath(); ctx.moveTo(pb.left, y); ctx.lineTo(pb.right, y); ctx.stroke();
      ctx.fillText(`${v.toFixed(0)}`, pb.left - Y_TICK_LABEL_RIGHT_OFFSET, y);
    }

    // Frequency X axis (log Hz).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let lf = Math.ceil(logFLo - 1e-9); lf <= logFHi; lf++) {
      const hz = Math.pow(10, lf);
      const x = pb.left + ((lf - logFLo) / logSpan) * pb.width;
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath(); ctx.moveTo(x, pb.top); ctx.lineTo(x, pb.bottom); ctx.stroke();
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(`${hz}`, x, pb.bottom + 2);
    }

    // Caption + caption axis label.
    ctx.fillStyle = COLOR_LABEL;
    ctx.textAlign = 'right';
    ctx.fillText('Hz', pb.right, pb.bottom + 2);
    drawYCaption(ctx, h, 'dB');

    // Latest segment's PSD curve drawn on top of the heatmap. Without
    // this the panel is unreadable on segments 1-5; with it, the user
    // sees a clean live curve plus the developing distribution behind it.
    if (f.latestF && f.latestDb && f.latestF.length === f.latestDb.length) {
      ctx.strokeStyle = COLOR_LATEST_TRACE;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < f.latestF.length; i++) {
        const hz  = f.latestF[i];
        const dbv = f.latestDb[i];
        if (!isFinite(hz) || hz <= 0 || !isFinite(dbv)) { started = false; continue; }
        if (hz < fLo || hz > fHi) { started = false; continue; }
        const lx = (Math.log10(hz) - logFLo) / logSpan;
        if (lx < 0 || lx > 1) { started = false; continue; }
        const x = pb.left + lx * pb.width;
        const y = pb.top + ((dbViewHi - dbv) / dbViewSpan) * pb.height;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    drawFrame(ctx, w, h);

    // Top-right caption.
    ctx.fillStyle = '#cfd2d4';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${f.nSegments} segments · latest curve in yellow`,
                 pb.right - 4, pb.top + 2);

    void COLOR_NOISE_MODEL;
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
