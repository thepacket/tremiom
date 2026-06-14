/** Shared analysis-panel strip for History + Event modes. Given a station
 *  + time window, it asks the server (`/api/waveform/panels`) to compute
 *  spectrogram / PSD / spectrum frames over that fetched window, then draws
 *  them — reusing the live dashboard panels' renderers (psd, spectrum) and
 *  a static spectrogram heatmap. This lets the dashboard panels also work
 *  on browsed-history and selected-event data, not just the live stream. */

import { psd } from '../panels/psd';
import { spectrum } from '../panels/spectrum';
import { rawScope } from '../panels/raw-scope';
import { staLta } from '../panels/sta-lta';
import { threeComp } from '../panels/three-comp';
import { particleMotion } from '../panels/particle-motion';
import { hv } from '../panels/hv';
import { viridis } from '../panels/colormap';
import { COLOR_LABEL, Y_TICK_LABEL_RIGHT_OFFSET, drawFrame, drawYCaption, niceStep, plotBounds } from '../panels/axes';
import type { FilterSpec } from '../data/filters';

type PanelFrames = Record<string, Record<string, unknown> & { columns?: number[][]; fMinHz?: number; fMaxHz?: number }>;
interface PanelsResp { nslc: string; sr: number; unit: string; frames: PanelFrames; error?: string }

export interface AnalysisUpdate {
  nslc: string;
  startMs: number;
  durS: number;
  units: string;
  filter: FilterSpec;
}

// Alphabetical (case-insensitive) by label, matching the live grid.
const PANELS: Array<{ id: string; label: string }> = [
  { id: 'spectrogram', label: 'Spectrogram' },
  { id: 'spectrum', label: 'Spectrum (FFT)' },
  { id: 'psd', label: 'PSD' },
  { id: 'raw-scope', label: 'Raw scope' },
  { id: 'sta-lta', label: 'STA/LTA' },
  { id: 'three-comp', label: '3-component' },
  { id: 'particle-motion', label: 'Particle motion' },
  { id: 'hv', label: 'H/V ratio' },
].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

export interface AnalysisPanelsHandle {
  update(opts: AnalysisUpdate): void;
  clear(): void;
}

export function mountAnalysisPanels(parent: HTMLElement): AnalysisPanelsHandle {
  const root = document.createElement('div');
  root.className = 'analysis-panels';
  const cells = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>();

  for (const p of PANELS) {
    const cell = document.createElement('div');
    cell.className = 'ap-cell';
    cell.innerHTML = `<div class="ap-head">${p.label}</div><canvas></canvas>`;
    root.appendChild(cell);
    const canvas = cell.querySelector('canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    cells.set(p.id, { canvas, ctx });
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw(p.id);
    });
    ro.observe(canvas);
  }
  parent.appendChild(root);

  let lastFrames: PanelFrames = {};
  let lastNslc = '';
  let token = 0;
  let debounce: number | null = null;

  function placeholder(id: string, msg: string) {
    const c = cells.get(id); if (!c) return;
    const w = c.canvas.clientWidth, h = c.canvas.clientHeight;
    c.ctx.fillStyle = '#0d0d0d'; c.ctx.fillRect(0, 0, w, h);
    c.ctx.fillStyle = '#8a8a8a'; c.ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    c.ctx.textAlign = 'center'; c.ctx.textBaseline = 'middle';
    c.ctx.fillText(msg, w / 2, h / 2);
  }

  function redraw(id: string) {
    const c = cells.get(id); if (!c) return;
    const fr = lastFrames[id];
    if (!fr) { placeholder(id, '—'); return; }
    const tagged = { ...fr, station: `hist:${lastNslc}` };
    switch (id) {
      case 'psd':             psd.render(c.ctx, c.canvas, fr); break;
      case 'spectrum':        spectrum.render(c.ctx, c.canvas, tagged); break;
      case 'raw-scope':       rawScope.render(c.ctx, c.canvas, fr); break;
      case 'sta-lta':         staLta.render(c.ctx, c.canvas, fr); break;
      case 'three-comp':      threeComp.render(c.ctx, c.canvas, tagged); break;
      case 'particle-motion': particleMotion.render(c.ctx, c.canvas, tagged); break;
      case 'hv':              hv.render(c.ctx, c.canvas, fr); break;
      case 'spectrogram':     drawSpectrogram(c.ctx, c.canvas, fr as { fMinHz: number; fMaxHz: number; columns: number[][] }); break;
    }
  }

  function update(opts: AnalysisUpdate): void {
    if (debounce) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void doFetch(opts), 260);
  }

  async function doFetch(opts: AnalysisUpdate): Promise<void> {
    const my = ++token;
    lastNslc = opts.nslc;
    for (const p of PANELS) placeholder(p.id, 'computing…');
    try {
      const r = await fetch('/api/waveform/panels', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nslc: opts.nslc, startMs: Math.round(opts.startMs), durS: opts.durS,
          units: opts.units, filter: opts.filter,
          panels: PANELS.map((p) => p.id),
        }),
      });
      if (my !== token) return;
      const j = await r.json() as PanelsResp;
      if (my !== token) return;
      if (!r.ok || j.error || !j.frames) {
        for (const p of PANELS) placeholder(p.id, j.error ? 'no data' : `HTTP ${r.status}`);
        return;
      }
      lastFrames = j.frames;
      for (const p of PANELS) redraw(p.id);
    } catch {
      if (my !== token) return;
      for (const p of PANELS) placeholder(p.id, 'failed');
    }
  }

  function clear(): void {
    token++;
    lastFrames = {};
    for (const p of PANELS) placeholder(p.id, '—');
  }

  return { update, clear };
}

/** Static spectrogram heatmap (oldest→newest columns left→right). Mirrors
 *  the live panel's viridis + auto-contrast, but draws all columns at once. */
function drawSpectrogram(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  fr: { fMinHz: number; fMaxHz: number; columns: number[][] } | undefined,
): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  if (!fr?.columns?.length) return;
  const cols = fr.columns.length;
  const bins = fr.columns[0].length;
  const pb = plotBounds(w, h);
  const colW = pb.width / cols;
  const rowH = pb.height / bins;

  const [dbMin, dbMax] = percentileRange(fr.columns, 0.02, 0.98);
  const span = Math.max(1e-3, dbMax - dbMin);
  for (let x = 0; x < cols; x++) {
    const col = fr.columns[x];
    const px = pb.left + x * colW;
    for (let b = 0; b < bins; b++) {
      const n = Math.max(0, Math.min(1, (col[b] - dbMin) / span));
      ctx.fillStyle = viridis(n);
      ctx.fillRect(px, pb.top + pb.height - (b + 1) * rowH, Math.ceil(colW), Math.ceil(rowH));
    }
  }

  // Frequency axis.
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = COLOR_LABEL; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const fSpan = Math.max(1e-9, fr.fMaxHz - fr.fMinHz);
  const fStep = niceStep(fSpan, 4);
  for (let v = Math.ceil(fr.fMinHz / fStep) * fStep; v <= fr.fMaxHz + 1e-9; v += fStep) {
    const yRaw = pb.top + ((fr.fMaxHz - v) / fSpan) * pb.height;
    const y = Math.max(pb.top + 5, Math.min(pb.bottom - 5, yRaw));
    ctx.fillText(`${v}`, pb.left - Y_TICK_LABEL_RIGHT_OFFSET, y);
  }
  drawYCaption(ctx, h, 'Hz');
  drawFrame(ctx, w, h);

  ctx.fillStyle = '#cfd2d4'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(`${dbMin.toFixed(0)} … ${dbMax.toFixed(0)} dB`, pb.right - 4, pb.top + 2);
  ctx.textAlign = 'left';
  ctx.fillText('time →', pb.left + 2, pb.top + 2);
}

function percentileRange(columns: number[][], pLo: number, pHi: number): [number, number] {
  const samples: number[] = [];
  const total = columns.length * (columns[0]?.length ?? 1);
  const stride = Math.max(1, Math.floor(total / 4096));
  let i = 0;
  for (const col of columns) for (const v of col) { if (i++ % stride === 0) samples.push(v); }
  if (!samples.length) return [-1, 1];
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * pLo)];
  const hi = samples[Math.floor(samples.length * pHi)];
  return hi - lo < 1 ? [lo - 0.5, hi + 0.5] : [lo, hi];
}
