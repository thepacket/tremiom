import type { PanelDef } from './registry';
import {
  AXIS_PAD, COLOR_GRID, COLOR_LABEL, Y_TICK_LABEL_RIGHT_OFFSET,
  drawFrame, drawYCaption, niceStep, plotBounds,
} from './axes';

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
  nlnm?: { periods: number[]; db: number[] };
  nhnm?: { periods: number[]; db: number[] };
}

const COLOR_NOISE_MODEL = '#666';

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
    const dbLo = dbCenters[0];
    const dbHi = dbCenters[dbCenters.length - 1];

    // Crop the visible dB range to the rows that actually have counts
    // (otherwise we waste plot area on bins that nobody hit).
    let rowLo = dbCenters.length, rowHi = -1;
    let maxCount = 0;
    for (let i = 0; i < f.hist.length; i++) {
      const col = f.hist[i];
      for (let j = 0; j < col.length; j++) {
        if (col[j] > 0) {
          if (j < rowLo) rowLo = j;
          if (j > rowHi) rowHi = j;
          if (col[j] > maxCount) maxCount = col[j];
        }
      }
    }
    if (rowHi < 0) {
      placeholder(ctx, w, h, 'PPSD accumulating…');
      return;
    }
    // Add a little visual padding so extremes don't kiss the frame.
    rowLo = Math.max(0, rowLo - 2);
    rowHi = Math.min(dbCenters.length - 1, rowHi + 2);
    const dbViewLo = dbCenters[rowLo];
    const dbViewHi = dbCenters[rowHi];
    const dbViewSpan = dbViewHi - dbViewLo;
    void dbLo; void dbHi;  // suppress unused

    // Draw heatmap.
    const cols = fHz.length;
    const visibleRows = rowHi - rowLo + 1;
    const cellW = pb.width  / cols;
    const cellH = pb.height / visibleRows;
    for (let i = 0; i < cols; i++) {
      const lx = (Math.log10(fHz[i]) - logFLo) / logSpan;
      const x = pb.left + lx * pb.width;
      for (let j = rowLo; j <= rowHi; j++) {
        const c = f.hist[i][j];
        if (c === 0) continue;
        const n = c / maxCount;        // 0..1
        ctx.fillStyle = colormap(n);
        const y = pb.top + ((dbViewHi - dbCenters[j]) / dbViewSpan) * pb.height;
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

    // NLNM / NHNM overlays — Peterson 1993 reference noise models.
    // The server sends them in (period, dB) pairs; convert period to Hz
    // and plot in the same coordinate space.
    function drawNoiseModel(model?: { periods: number[]; db: number[] }) {
      if (!model || !model.periods.length) return;
      ctx.strokeStyle = COLOR_NOISE_MODEL;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < model.periods.length; i++) {
        const hz = 1 / model.periods[i];
        if (hz < fLo || hz > fHi) continue;
        const lx = (Math.log10(hz) - logFLo) / logSpan;
        if (lx < 0 || lx > 1) continue;
        const x = pb.left + lx * pb.width;
        const dbVal = model.db[i];
        if (dbVal < dbViewLo || dbVal > dbViewHi) { started = false; continue; }
        const y = pb.top + ((dbViewHi - dbVal) / dbViewSpan) * pb.height;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    drawNoiseModel(f.nlnm);
    drawNoiseModel(f.nhnm);

    drawFrame(ctx, w, h);

    // Top-right caption: segment count + range.
    ctx.fillStyle = '#cfd2d4';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${f.nSegments} segments · NLNM/NHNM overlay`,
                 pb.right - 4, pb.top + 2);
  },
};

/** Black-body-ish colormap, 0..1 -> rgb. Same as spectrogram for
 *  visual consistency. */
function colormap(n: number): string {
  const r = Math.round(255 * Math.min(1, n * 3));
  const g = Math.round(255 * Math.min(1, Math.max(0, n * 3 - 1)));
  const b = Math.round(255 * Math.min(1, Math.max(0, n * 3 - 2)));
  return `rgb(${r},${g},${b})`;
}

function placeholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}

void AXIS_PAD;
