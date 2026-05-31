import type { PanelDef } from './registry';
import {
  COLOR_GRID, COLOR_LABEL, Y_TICK_LABEL_RIGHT_OFFSET,
  drawFrame, drawYCaption, niceStep, plotBounds,
} from './axes';

/** Instantaneous amplitude spectrum — the live |FFT| magnitude curve of
 *  the current window. The seismic equivalent of an audio spectrum
 *  analyzer (Swarm's "spectra" view), distinct from the rolling
 *  spectrogram and the time-averaged PSD. Linear frequency axis. */

interface SpectrumFrame {
  data: number[];   // dB magnitude per frequency bin
  fMinHz: number;
  fMaxHz: number;
}

/** Light peak-hold: keep the max dB seen per bin, decaying slowly, so
 *  transient spectral peaks remain briefly visible. Per-station. */
const peakHold = new Map<string, { data: number[]; t: number }>();

export const spectrum: PanelDef = {
  id: 'spectrum',
  label: 'Spectrum (FFT)',
  category: 'live',
  serverWorker: 'panels.spectrum',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as (SpectrumFrame & { station?: string }) | null;
    if (!f?.data?.length) {
      placeholder(ctx, w, h, 'waiting for frames…');
      return;
    }

    const d = f.data;
    const station = f.station || '_';

    // Maintain a decaying peak-hold envelope.
    const now = Date.now();
    let ph = peakHold.get(station);
    if (!ph || ph.data.length !== d.length) {
      ph = { data: d.slice(), t: now };
    } else {
      const dt = (now - ph.t) / 1000;
      const decay = 12 * dt; // dB/s decay
      for (let i = 0; i < d.length; i++) {
        const decayed = ph.data[i] - decay;
        ph.data[i] = Math.max(d[i], decayed);
      }
      ph.t = now;
    }
    peakHold.set(station, ph);

    // Auto-range Y from current + peak-hold.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < d.length; i++) {
      if (d[i] < lo) lo = d[i];
      if (ph.data[i] > hi) hi = ph.data[i];
    }
    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1) { lo = -1; hi = 1; }
    const headroom = (hi - lo) * 0.08;
    const yMin = lo - headroom, yMax = hi + headroom;
    const span = yMax - yMin;

    const pb = plotBounds(w, h);
    const fMin = f.fMinHz, fMax = Math.max(f.fMinHz + 1e-3, f.fMaxHz);
    const xForF = (hz: number) => pb.left + ((hz - fMin) / (fMax - fMin)) * pb.width;
    const yForV = (v: number) => pb.top + ((yMax - v) / span) * pb.height;

    // Y grid + dB labels.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const yStep = niceStep(span, 4);
    const labelHalf = 5;
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
      const y = yForV(v);
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath(); ctx.moveTo(pb.left, y); ctx.lineTo(pb.right, y); ctx.stroke();
      ctx.fillStyle = COLOR_LABEL;
      ctx.textAlign = 'right';
      const ly = Math.max(pb.top + labelHalf, Math.min(pb.bottom - labelHalf, y));
      ctx.fillText(`${v.toFixed(0)}`, pb.left - Y_TICK_LABEL_RIGHT_OFFSET, ly);
    }
    drawYCaption(ctx, h, 'dB');

    // X grid + frequency labels (linear).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const fStep = niceStep(fMax - fMin, 6);
    for (let hz = Math.ceil(fMin / fStep) * fStep; hz <= fMax + 1e-9; hz += fStep) {
      const x = xForF(hz);
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath(); ctx.moveTo(x, pb.top); ctx.lineTo(x, pb.bottom); ctx.stroke();
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(`${hz}`, x, pb.bottom + 2);
    }
    ctx.fillStyle = COLOR_LABEL;
    ctx.textAlign = 'right';
    ctx.fillText('Hz', pb.right, pb.bottom + 2);

    drawFrame(ctx, w, h);

    // Peak-hold envelope (dim).
    ctx.strokeStyle = 'rgba(122,170,221,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < ph.data.length; i++) {
      const hz = fMin + (i / (ph.data.length - 1)) * (fMax - fMin);
      const x = xForF(hz), y = yForV(ph.data[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Live spectrum (bright).
    ctx.strokeStyle = '#ff8c1a';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const hz = fMin + (i / (d.length - 1)) * (fMax - fMin);
      const x = xForF(hz), y = yForV(d[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Caption.
    ctx.fillStyle = '#cfd2d4';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('live + peak-hold', pb.right - 4, pb.top + 2);
  },
};

function placeholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}

export function resetSpectrum(station?: string): void {
  if (station) peakHold.delete(station);
  else peakHold.clear();
}
