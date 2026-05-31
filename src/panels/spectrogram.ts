import type { PanelDef } from './registry';

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
    const colW = w / cols;
    const bins = ring[ring.length - 1].data.length;
    const rowH = h / bins;

    // Auto-range from the accumulated ring. Raw IRIS counts give PSD
    // values in the tens of dB (positive), so a fixed range can't work
    // across instrument-response-free streams. Trim 2% from each tail
    // to keep outliers from washing out contrast.
    const [dbMin, dbMax] = percentileRange(ring, 0.02, 0.98);
    const span = Math.max(1e-3, dbMax - dbMin);

    for (let x = 0; x < cols; x++) {
      const col = ring[x].data;
      const px = x * colW;
      for (let b = 0; b < bins; b++) {
        const db = col[b];
        const n = Math.max(0, Math.min(1, (db - dbMin) / span));
        ctx.fillStyle = colormap(n);
        const py = h - (b + 1) * rowH;
        ctx.fillRect(px, py, Math.ceil(colW), Math.ceil(rowH));
      }
    }

    // dB range readout (bottom-right).
    ctx.fillStyle = '#cfd2d4';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${dbMin.toFixed(0)} … ${dbMax.toFixed(0)} dB`, w - 4, h - 2);
  },
};

/** Approximate p-percentile range over the dB values in the ring. */
function percentileRange(ring: SpectrogramFrame[], pLo: number, pHi: number): [number, number] {
  // Sub-sample to keep the sort affordable when the ring is full.
  const samples: number[] = [];
  const stride = Math.max(1, Math.floor((ring.length * (ring[0]?.data.length ?? 1)) / 4096));
  let i = 0;
  for (const c of ring) {
    for (const v of c.data) {
      if (i++ % stride === 0) samples.push(v);
    }
  }
  if (!samples.length) return [-1, 1];
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * pLo)];
  const hi = samples[Math.floor(samples.length * pHi)];
  if (hi - lo < 1) return [lo - 0.5, hi + 0.5];
  return [lo, hi];
}

/** Black-body-ish colormap, 0..1 -> rgb. Fast, no LUT. */
function colormap(n: number): string {
  const r = Math.round(255 * Math.min(1, n * 3));
  const g = Math.round(255 * Math.min(1, Math.max(0, n * 3 - 1)));
  const b = Math.round(255 * Math.min(1, Math.max(0, n * 3 - 2)));
  return `rgb(${r},${g},${b})`;
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}
