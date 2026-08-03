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
import { equalizeColumns } from '../panels/contrast';
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
  snapshotFrames(): Record<string, unknown>;
}

export function mountAnalysisPanels(parent: HTMLElement): AnalysisPanelsHandle {
  const root = document.createElement('div');
  root.className = 'analysis-panels';
  const cells = new Map<string, { el: HTMLElement; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>();

  for (const p of PANELS) {
    const cell = document.createElement('div');
    cell.className = 'ap-cell';
    cell.innerHTML = `<div class="ap-head">${p.label}</div><canvas></canvas>`;
    root.appendChild(cell);
    const canvas = cell.querySelector('canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    cells.set(p.id, { el: cell, canvas, ctx });
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
  let lastOpts: AnalysisUpdate | null = null;
  let token = 0;
  let debounce: number | null = null;

  /** Panel ids whose cell is within the strip's scroll viewport (+margin) —
   *  so we only compute the panels the user can actually see. */
  function visiblePanelIds(): string[] {
    const rr = root.getBoundingClientRect();
    const ids: string[] = [];
    for (const p of PANELS) {
      const c = cells.get(p.id); if (!c) continue;
      const r = c.el.getBoundingClientRect();
      if (r.bottom > rr.top - 120 && r.top < rr.bottom + 120) ids.push(p.id);
    }
    return ids.length ? ids : PANELS.map((p) => p.id);
  }

  function scheduleFetch(): void {
    if (debounce) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void doFetch(), 300);
  }
  // Fetch newly-revealed panels as the strip is scrolled.
  root.addEventListener('scroll', scheduleFetch, { passive: true });

  // Match a canvas's backing store to its displayed size. The ResizeObserver
  // misses the hidden→shown transition for the Event/History strips (they
  // start hidden at load), so size on render too, or the canvas stays at its
  // default 300×150 and line panels draw outside it.
  function ensureSize(c: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(c.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(c.canvas.clientHeight * dpr));
    if (c.canvas.width !== w || c.canvas.height !== h) {
      c.canvas.width = w; c.canvas.height = h;
      c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function placeholder(id: string, msg: string) {
    const c = cells.get(id); if (!c) return;
    ensureSize(c);
    const w = c.canvas.clientWidth, h = c.canvas.clientHeight;
    c.ctx.fillStyle = '#0d0d0d'; c.ctx.fillRect(0, 0, w, h);
    c.ctx.fillStyle = '#8a8a8a'; c.ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    c.ctx.textAlign = 'center'; c.ctx.textBaseline = 'middle';
    c.ctx.fillText(msg, w / 2, h / 2);
  }

  function redraw(id: string) {
    const c = cells.get(id); if (!c) return;
    ensureSize(c);
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
      case 'spectrogram':     drawSpectrogram(c.ctx, c.canvas, fr as { fMinHz: number; fMaxHz: number; columns: number[][] },
                                lastOpts ? { startMs: lastOpts.startMs, durS: lastOpts.durS } : null); break;
    }
  }

  window.addEventListener('tremiom:plots-resized', () => {
    requestAnimationFrame(() => {
      if (!root.getClientRects().length) return;
      for (const panel of PANELS) redraw(panel.id);
    });
  });

  function update(opts: AnalysisUpdate): void {
    token++;                       // invalidate any in-flight fetch (window changed)
    lastOpts = opts;
    lastNslc = opts.nslc;
    lastFrames = {};               // new window — drop stale frames
    for (const p of PANELS) placeholder(p.id, '—');
    scheduleFetch();
  }

  async function doFetch(): Promise<void> {
    if (!lastOpts) return;
    const opts = lastOpts;
    // Only the visible panels not already computed for this window.
    const wanted = visiblePanelIds().filter((id) => !(id in lastFrames));
    if (!wanted.length) return;
    const my = ++token;
    for (const id of wanted) placeholder(id, 'computing…');
    try {
      const r = await fetch('/api/waveform/panels', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nslc: opts.nslc, startMs: Math.round(opts.startMs), durS: opts.durS,
          units: opts.units, filter: opts.filter, panels: wanted,
        }),
      });
      if (my !== token) return;
      const j = await r.json() as PanelsResp;
      if (my !== token) return;
      if (!r.ok || j.error || !j.frames) {
        for (const id of wanted) placeholder(id, j.error ? 'no data' : `HTTP ${r.status}`);
        return;
      }
      lastFrames = { ...lastFrames, ...j.frames };
      for (const id of Object.keys(j.frames)) redraw(id);
    } catch {
      if (my !== token) return;
      for (const id of wanted) placeholder(id, 'failed');
    }
  }

  function clear(): void {
    token++;
    lastOpts = null;
    lastFrames = {};
    for (const p of PANELS) placeholder(p.id, '—');
  }

  return {
    update,
    clear,
    snapshotFrames: () => Object.fromEntries(
      Object.entries(lastFrames).map(([id, frame]) => [id, { ...frame, station: lastNslc }]),
    ),
  };
}

/** Tick steps for an absolute UTC time axis, in seconds. */
const TIME_STEPS_S = [
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800, 21600, 43200, 86400,
];

/** Smallest ladder step that keeps the axis at or under `target` ticks. */
function timeStepS(totalS: number, target: number): number {
  for (const s of TIME_STEPS_S) if (totalS / s <= target) return s;
  return TIME_STEPS_S[TIME_STEPS_S.length - 1];
}

function fmtUtcTick(ms: number, stepS: number): string {
  const d = new Date(ms);
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  if (stepS < 60) return `${hh}:${mm}:${d.getUTCSeconds().toString().padStart(2, '0')}`;
  if (stepS < 86400) return `${hh}:${mm}`;
  return `${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d.getUTCDate().toString().padStart(2, '0')}`;
}

/** Static spectrogram heatmap (oldest→newest columns left→right). Mirrors
 *  the live panel's viridis + auto-contrast, but draws all columns at once.
 *  Columns span the fetched window uniformly (the worker max-bins them to a
 *  fixed count), so `win` maps column position → absolute UTC for the x-axis. */
function drawSpectrogram(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  fr: { fMinHz: number; fMaxHz: number; columns: number[][] } | undefined,
  win: { startMs: number; durS: number } | null,
): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  if (!fr?.columns?.length) return;
  const cols = fr.columns.length;
  const bins = fr.columns[0].length;
  const pb = plotBounds(w, h);
  const colW = pb.width / cols;
  const rowH = pb.height / bins;

  // Histogram-equalize the dB distribution so contrast follows where the
  // data actually lives (dense noise floor + sparse energetic bins),
  // instead of a linear stretch that washes most of it out. dbMin/dbMax
  // are the trimmed range the equalizer covers (shown in the readout).
  const eq = equalizeColumns(fr.columns);
  const dbMin = eq.lo, dbMax = eq.hi;
  for (let x = 0; x < cols; x++) {
    const col = fr.columns[x];
    const px = pb.left + x * colW;
    for (let b = 0; b < bins; b++) {
      const n = eq.norm(col[b]);
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

  // X axis: absolute UTC ticks across the fetched window. Ticks land on round
  // UTC boundaries (multiples of the step from the epoch), not on startMs.
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  if (win && win.durS > 0) {
    const stepS = timeStepS(win.durS, pb.width < 400 ? 5 : 7);
    const stepMs = stepS * 1000;
    const endMs = win.startMs + win.durS * 1000;
    for (let t = Math.ceil(win.startMs / stepMs) * stepMs; t <= endMs + 1e-6; t += stepMs) {
      const x = pb.left + ((t - win.startMs) / (win.durS * 1000)) * pb.width;
      // Labels only, no gridlines — matching the live spectrogram panel, and
      // gridlines would wash out the heatmap they cross.
      const label = fmtUtcTick(t, stepS);
      // Skip labels that would run off the canvas rather than shifting them
      // off their tick.
      const half = ctx.measureText(label).width / 2;
      if (x - half < 0 || x + half > w) continue;
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(label, x, pb.bottom + 2);
    }
  } else {
    ctx.textAlign = 'left';
    ctx.fillStyle = COLOR_LABEL;
    ctx.fillText('time →', pb.left + 2, pb.bottom + 2);
  }

  drawFrame(ctx, w, h);

  ctx.fillStyle = '#cfd2d4'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(`${dbMin.toFixed(0)} … ${dbMax.toFixed(0)} dB`, pb.right - 4, pb.top + 2);
}
