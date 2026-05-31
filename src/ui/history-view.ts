/** History (waveform-browser) mode — arbitrary-time navigation for a
 *  single channel: fetch any time window from FDSN, then zoom (wheel),
 *  pan (drag), step (prev/next), and jump (Now) freely. This is the
 *  everyday capability that separates a real seismic viewer (Swarm,
 *  Snuffler, Wilber 3) from a live-only one.
 *
 *  Renders the min/max envelope returned by the server so transient
 *  spikes aren't aliased away when zoomed out across hours.
 */

import { AXIS_PAD, COLOR_LABEL, drawFrame, niceStep, plotBounds } from '../panels/axes';
import type { FilterSpec } from '../data/filters';

interface WaveformResp {
  nslc: string;
  t0Ms: number;
  sr: number;
  durS: number;
  binMs: number;
  unit: string;
  min: Array<number | null>;
  max: Array<number | null>;
  error?: string;
}

interface HistoryDeps {
  station: () => string;
  units: () => string;
  filter: () => FilterSpec;
}

export interface HistoryHandle {
  show(): void;
  hide(): void;
  /** Re-fetch (e.g. station/units/filter changed while visible). */
  refresh(): void;
}

export function mountHistoryView(parent: HTMLElement, deps: HistoryDeps): HistoryHandle {
  const root = document.createElement('div');
  root.className = 'history-view hidden';
  root.innerHTML = `
    <header>
      <span class="title">history</span>
      <span class="muted hv-info"></span>
      <span class="hv-controls">
        <button class="hv-btn" data-act="prev"  title="Previous window">◀</button>
        <button class="hv-btn" data-act="next"  title="Next window">▶</button>
        <button class="hv-btn" data-act="zoomout" title="Zoom out">−</button>
        <button class="hv-btn" data-act="zoomin"  title="Zoom in">+</button>
        <select class="hv-dur" title="Window length">
          <option value="600">10 min</option>
          <option value="1800">30 min</option>
          <option value="3600" selected>1 hour</option>
          <option value="10800">3 hours</option>
          <option value="21600">6 hours</option>
          <option value="86400">24 hours</option>
        </select>
        <button class="hv-btn" data-act="now" title="Jump to most recent">Now</button>
      </span>
    </header>
    <div class="hv-body">
      <canvas></canvas>
      <div class="hv-status muted">…</div>
    </div>
  `;
  parent.appendChild(root);

  const canvas = root.querySelector('canvas') as HTMLCanvasElement;
  const info   = root.querySelector('.hv-info') as HTMLElement;
  const status = root.querySelector('.hv-status') as HTMLElement;
  const durSel = root.querySelector('.hv-dur') as HTMLSelectElement;
  const ctx = canvas.getContext('2d')!;

  let startMs = Date.now() - 3600_000;
  let durS = 3600;
  let resp: WaveformResp | null = null;
  let fetchToken = 0;
  let visible = false;

  const ro = new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  });
  ro.observe(canvas);

  function setStatus(msg: string | null, err = false) {
    status.style.display = msg ? 'block' : 'none';
    if (msg) status.textContent = msg;
    status.classList.toggle('error', err);
  }

  let debounce: number | null = null;
  function scheduleFetch() {
    if (debounce) window.clearTimeout(debounce);
    debounce = window.setTimeout(doFetch, 220);
  }

  async function doFetch() {
    const nslc = deps.station();
    const myToken = ++fetchToken;
    setStatus('fetching…');
    info.textContent = `${nslc}  ·  ${fmtUTC(startMs)} +${fmtDur(durS)}`;
    try {
      const maxPoints = Math.max(600, Math.floor(canvas.clientWidth || 1200));
      const r = await fetch('/api/waveform', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nslc, startMs: Math.round(startMs), durS,
          maxPoints, units: deps.units(), filter: deps.filter(),
        }),
      });
      if (myToken !== fetchToken) return;
      const j = await r.json() as WaveformResp;
      if (myToken !== fetchToken) return;
      if (!r.ok || j.error) {
        resp = null;
        setStatus(j.error ? `no data: ${j.error}` : `HTTP ${r.status}`, true);
        draw();
        return;
      }
      resp = j;
      setStatus(null);
      info.textContent = `${nslc}  ·  ${fmtUTC(startMs)} +${fmtDur(durS)}  ·  ${j.sr} Hz`;
      draw();
    } catch (e) {
      if (myToken !== fetchToken) return;
      setStatus(`fetch failed: ${(e as Error).message}`, true);
    }
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);
    if (!resp) return;
    const pb = plotBounds(w, h);
    const mins = resp.min, maxs = resp.max;
    const n = mins.length;

    // Auto-range amplitude over finite bins.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = mins[i], b = maxs[i];
      if (a != null && a < lo) lo = a;
      if (b != null && b > hi) hi = b;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-9) { lo = -1; hi = 1; }
    const pad = (hi - lo) * 0.08;
    const yMin = lo - pad, yMax = hi + pad, span = yMax - yMin;
    const yForV = (v: number) => pb.top + ((yMax - v) / span) * pb.height;

    // Y grid + labels.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const yStep = niceStep(span, 4);
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
      const y = yForV(v);
      ctx.strokeStyle = '#1a2025';
      ctx.beginPath(); ctx.moveTo(pb.left, y); ctx.lineTo(pb.right, y); ctx.stroke();
      ctx.fillStyle = COLOR_LABEL; ctx.textAlign = 'right';
      const ly = Math.max(pb.top + 5, Math.min(pb.bottom - 5, y));
      ctx.fillText(fmtAmp(v), pb.left - 6, ly);
    }
    // Y caption (units).
    ctx.save();
    ctx.translate(8, pb.top + pb.height / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = COLOR_LABEL; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(resp.unit, 0, 0);
    ctx.restore();

    // X grid + absolute UTC time labels.
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const endMs = startMs + durS * 1000;
    const tStep = niceTimeStep(durS);
    const firstTick = Math.ceil(startMs / 1000 / tStep) * tStep * 1000;
    for (let tMs = firstTick; tMs <= endMs; tMs += tStep * 1000) {
      const x = pb.left + ((tMs - startMs) / (durS * 1000)) * pb.width;
      ctx.strokeStyle = '#1a2025';
      ctx.beginPath(); ctx.moveTo(x, pb.top); ctx.lineTo(x, pb.bottom); ctx.stroke();
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(fmtTick(tMs, durS), x, pb.bottom + 2);
    }
    ctx.fillStyle = COLOR_LABEL; ctx.textAlign = 'right';
    ctx.fillText('UTC', pb.right, pb.bottom + 2);

    drawFrame(ctx, w, h);

    // Envelope: vertical min→max bar per bin (filled), gaps left blank.
    ctx.strokeStyle = '#7ad';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = mins[i], b = maxs[i];
      if (a == null || b == null) continue;
      const x = pb.left + ((i + 0.5) / n) * pb.width;
      ctx.moveTo(x, yForV(a));
      ctx.lineTo(x, yForV(b));
    }
    ctx.stroke();

    // Caption.
    ctx.fillStyle = '#cfd2d4'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('drag = pan · wheel = zoom', pb.right - 4, pb.top + 2);
  }

  // ── Interactions ───────────────────────────────────────────────────
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pb = plotBounds(canvas.clientWidth, canvas.clientHeight);
    const frac = Math.max(0, Math.min(1, (e.offsetX - pb.left) / pb.width));
    const cursorMs = startMs + frac * durS * 1000;
    const factor = e.deltaY > 0 ? 1.3 : 1 / 1.3; // out / in
    const newDur = Math.max(10, Math.min(86400 * 7, durS * factor));
    // Keep the time under the cursor fixed.
    startMs = cursorMs - frac * newDur * 1000;
    durS = newDur;
    syncDurSelect();
    scheduleFetch();
  }, { passive: false });

  let panning = false, panStartX = 0, panStartMs = 0;
  canvas.addEventListener('mousedown', (e) => {
    panning = true; panStartX = e.offsetX; panStartMs = startMs;
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    const pb = plotBounds(canvas.clientWidth, canvas.clientHeight);
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - rect.left) - panStartX;
    const dtMs = -(dx / pb.width) * durS * 1000;
    startMs = panStartMs + dtMs;
    draw(); // live shift of the cached envelope; refetch on release
  });
  window.addEventListener('mouseup', () => {
    if (!panning) return;
    panning = false; canvas.style.cursor = 'grab';
    scheduleFetch();
  });

  root.querySelectorAll('.hv-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const act = (b as HTMLElement).dataset.act!;
      if (act === 'prev') startMs -= durS * 1000;
      else if (act === 'next') startMs += durS * 1000;
      else if (act === 'zoomin') durS = Math.max(10, durS / 2);
      else if (act === 'zoomout') durS = Math.min(86400 * 7, durS * 2);
      else if (act === 'now') startMs = Date.now() - durS * 1000 - 60_000;
      syncDurSelect();
      scheduleFetch();
    }));
  durSel.addEventListener('change', () => {
    const newDur = parseInt(durSel.value, 10);
    const endMs = startMs + durS * 1000;
    durS = newDur;
    startMs = endMs - durS * 1000; // keep the right edge fixed
    scheduleFetch();
  });
  function syncDurSelect() {
    const opt = [...durSel.options].find((o) => +o.value === Math.round(durS));
    durSel.value = opt ? opt.value : durSel.value;
  }

  return {
    show() {
      visible = true;
      root.classList.remove('hidden');
      // Default to the most recent `durS` of the active station.
      startMs = Date.now() - durS * 1000 - 60_000;
      scheduleFetch();
    },
    hide() { visible = false; root.classList.add('hidden'); },
    refresh() { if (visible) scheduleFetch(); },
  };
}

// ── formatting helpers ─────────────────────────────────────────────────
function fmtAmp(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 1)   return `${v.toFixed(0)}`;
  return v.toExponential(1);
}
function fmtDur(s: number): string {
  if (s >= 86400) return `${(s / 86400).toFixed(0)}d`;
  if (s >= 3600) return `${(s / 3600).toFixed(0)}h`;
  if (s >= 60) return `${(s / 60).toFixed(0)}m`;
  return `${s}s`;
}
function fmtUTC(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
function niceTimeStep(durS: number): number {
  // Return a tick step in seconds that gives ~6-8 ticks.
  const target = durS / 7;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
                 3600, 7200, 10800, 21600, 43200, 86400];
  for (const s of steps) if (s >= target) return s;
  return 86400;
}
function fmtTick(ms: number, durS: number): string {
  const d = new Date(ms);
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  if (durS <= 600) return `${hh}:${mm}:${ss}`;
  if (durS <= 86400) return `${hh}:${mm}`;
  return `${(d.getUTCMonth() + 1)}/${d.getUTCDate()} ${hh}h`;
}

void AXIS_PAD;
