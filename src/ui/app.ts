import { panelRegistry } from '../panels/registry';
import { resetSpectrogram } from '../panels/spectrogram';
import { TremiomClient } from '../transport/ws';
import { DEFAULT_STATION } from '../data/stations';
import { mountStationPicker } from './station-picker';
import { mountEventList } from './event-list';

const INITIAL_PANELS = ['helicorder', 'spectrogram', 'raw-scope', 'psd'];

export function mountApp(root: HTMLElement, version: string): void {
  root.innerHTML = '';

  // ── Topbar ──────────────────────────────────────────────────────────
  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  topbar.innerHTML = `
    <span class="brand">tremiom</span>
    <span class="muted">v${version}</span>
    <span class="muted">station:</span>
    <span id="picker-mount"></span>
    <span class="muted" id="conn">connecting…</span>
  `;
  root.appendChild(topbar);

  // ── Body (sidebar + grid) ───────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'body';
  root.appendChild(body);

  // Sidebar (event list) mounts here.
  const sidebarHost = document.createElement('div');
  sidebarHost.className = 'sidebar-host';
  body.appendChild(sidebarHost);
  mountEventList(sidebarHost, (event) => {
    // v0.0.5: clicking an event just logs it. v0.1 will trigger an
    // event-panels workflow (record section, travel-time, beachball)
    // against the N nearest stations.
    console.log('[event picked]', event);
  });

  const grid = document.createElement('div');
  grid.className = 'grid';
  body.appendChild(grid);

  const renderers = new Map<string, ReturnType<typeof mountPanel>>();
  for (const id of INITIAL_PANELS) {
    const panel = panelRegistry[id];
    if (!panel) continue;
    renderers.set(id, mountPanel(grid, panel.label, panel));
  }

  // ── State + transport ───────────────────────────────────────────────
  let currentStation = DEFAULT_STATION;

  const client = new TremiomClient({
    onStatus(s) {
      const el = document.getElementById('conn');
      if (el) el.textContent = s;
    },
    onPanelFrame(panelId, frame) {
      // Drop frames from stations we're no longer subscribed to.
      // (The server already filters by subscription, but a brief
      //  window of in-flight frames may arrive after unsubscribe.)
      if ((frame as { station?: string }).station !== currentStation) return;
      renderers.get(panelId)?.draw(frame);
    },
  });

  // ── Picker ──────────────────────────────────────────────────────────
  const pickerMount = document.getElementById('picker-mount')!;
  mountStationPicker(pickerMount, currentStation, (next) => {
    if (next === currentStation) return;
    client.unsubscribe(currentStation);
    resetSpectrogram();         // clear stale columns
    for (const r of renderers.values()) r.clear();
    currentStation = next;
    client.subscribe(currentStation, INITIAL_PANELS);
  });

  // Initial subscription.
  client.subscribe(currentStation, INITIAL_PANELS);
}

function mountPanel(
  parent: HTMLElement,
  label: string,
  panel: (typeof import('../panels/registry').panelRegistry)[string]
) {
  const el = document.createElement('div');
  el.className = 'panel';
  el.innerHTML = `<header>${label}</header>`;
  const canvas = document.createElement('canvas');
  el.appendChild(canvas);
  parent.appendChild(el);

  const ctx = canvas.getContext('2d')!;
  const ro = new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  });
  ro.observe(canvas);

  return {
    draw(frame: unknown) {
      panel.render(ctx, canvas, frame);
    },
    clear() {
      // Re-render with no frame -> panels fall back to "waiting…" placeholder.
      panel.render(ctx, canvas, null);
    },
  };
}
