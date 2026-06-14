import type { PanelDef } from './registry';
import {
  AXIS_PAD, COLOR_LABEL, Y_TICK_LABEL_RIGHT_OFFSET,
  drawFrame, drawYCaption, niceStep, plotBounds,
} from './axes';
import { viridis } from './colormap';
import { equalizeColumns } from './contrast';

/** Spectrogram — sliding STFT columns. Server sends one column per frame
 *  with dB values and a frequency axis. v0.1 keeps the last N columns in
 *  a ring buffer and redraws on each new column. */

interface SpectrogramFrame {
  station: string;
  data: number[];      // dB values, one per frequency bin
  fMinHz: number;
  fMaxHz: number;
  t: number;           // unix seconds
}

const HISTORY = 600; // ~10 min at 1 Hz column rate
/** Per-station ring so switching stations doesn't bleed columns. */
const rings = new Map<string, SpectrogramFrame[]>();

/** Drop history for a station — call when unsubscribing / switching. */
export function resetSpectrogram(station?: string): void {
  if (station) rings.delete(station);
  else rings.clear();
}

export const spectrogram: PanelDef = {
  id: 'spectrogram',
  label: 'Spectrogram',
  category: 'live',
  serverWorker: 'panels.spectrogram',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as SpectrogramFrame | null;
    if (f?.data?.length && f.station) {
      let ring = rings.get(f.station);
      if (!ring) { ring = []; rings.set(f.station, ring); }
      ring.push(f);
      while (ring.length > HISTORY) ring.shift();
    }
    // Use the latest station's ring for display. v0.2 will pass the
    // active station explicitly to the renderer instead of inferring.
    const ring = [...rings.values()].at(-1) ?? [];
    if (!ring.length) {
      drawPlaceholder(ctx, w, h, 'waiting for frames…');
      return;
    }

    const cols = ring.length;
    const bins = ring[ring.length - 1].data.length;
    const fMin = ring[ring.length - 1].fMinHz;
    const fMax = ring[ring.length - 1].fMaxHz;
    const pb = plotBounds(w, h);
    const colW = pb.width / cols;
    const rowH = pb.height / bins;

    // Auto-range from the accumulated ring via histogram equalization.
    // Raw IRIS counts give PSD values in the tens of dB (positive), so a
    // fixed range can't work across instrument-response-free streams; and
    // a plain linear stretch wastes the colormap on the lopsided seismic
    // PSD histogram (dense noise floor + sparse energetic bins). The
    // equalizer maps values through the CDF so contrast follows where the
    // data actually lives. dbMin/dbMax are the trimmed range it covers.
    const eq = equalizeColumns(ring.map((r) => r.data));
    const dbMin = eq.lo, dbMax = eq.hi;

    // Render the heat-map columns inside the plot area.
    for (let x = 0; x < cols; x++) {
      const col = ring[x].data;
      const px = pb.left + x * colW;
      for (let b = 0; b < bins; b++) {
        const db = col[b];
        const n = eq.norm(db);
        ctx.fillStyle = viridis(n);
        const py = pb.top + pb.height - (b + 1) * rowH;
        ctx.fillRect(px, py, Math.ceil(colW), Math.ceil(rowH));
      }
    }

    // Frequency Y-axis (linear from fMin to fMax). textBaseline 'middle'
    // means a label at the very top/bottom of the plot extends past the
    // frame; clamp the y-coordinate so labels always render inside the
    // panel area.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = COLOR_LABEL;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const fSpan = Math.max(1e-9, fMax - fMin);
    const fStep = niceStep(fSpan, 4);
    const labelHalfHeight = 5;
    for (let v = Math.ceil(fMin / fStep) * fStep; v <= fMax + 1e-9; v += fStep) {
      const yRaw = pb.top + ((fMax - v) / fSpan) * pb.height;
      const y = Math.max(pb.top + labelHalfHeight,
                Math.min(pb.bottom - labelHalfHeight, yRaw));
      ctx.fillText(`${v}`, pb.left - Y_TICK_LABEL_RIGHT_OFFSET, y);
    }
    drawYCaption(ctx, h, 'Hz');

    // Time X-axis (seconds back; column rate is 1 Hz so cols ≈ seconds).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const totalSec = cols; // 1 Hz column rate
    const tStep = niceStep(totalSec, 5);
    for (let sBack = 0; sBack <= totalSec + 1e-9; sBack += tStep) {
      const x = pb.left + pb.width - (sBack / Math.max(1, totalSec)) * pb.width;
      ctx.fillStyle = COLOR_LABEL;
      const label = sBack === 0 ? 'now' : `-${sBack.toFixed(0)}s`;
      ctx.fillText(label, x, pb.top + pb.height + 2);
    }

    drawFrame(ctx, w, h);

    // dB range readout (top-right corner inside the plot area).
    ctx.fillStyle = '#cfd2d4';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${dbMin.toFixed(0)} … ${dbMax.toFixed(0)} dB`, pb.right - 4, pb.top + 2);
  },
};

// Keep the unused-import linter satisfied.
void AXIS_PAD;

function drawPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}
