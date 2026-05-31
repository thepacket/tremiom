import { panelRegistry } from '../panels/registry';
import { TremiomClient } from '../transport/ws';

/** Default station to subscribe to on boot. IU.ANMO.00.BHZ is the
 *  Albuquerque, NM IRIS reference station — always-on, broadband Z. */
const DEFAULT_STATION = 'IU.ANMO.00.BHZ';

export function mountApp(root: HTMLElement, version: string): void {
  root.innerHTML = '';

  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  topbar.innerHTML = `
    <span class="brand">tremiom</span>
    <span class="muted">v${version}</span>
    <span class="muted">station:</span>
    <span id="station">${DEFAULT_STATION}</span>
    <span class="muted" id="conn">connecting…</span>
  `;
  root.appendChild(topbar);

  const grid = document.createElement('div');
  grid.className = 'grid';
  root.appendChild(grid);

  // v0.1 default panel layout — 4 live panels.
  const initialPanels = ['helicorder', 'spectrogram', 'raw-scope', 'psd'];

  const renderers = new Map<string, ReturnType<typeof mountPanel>>();
  for (const id of initialPanels) {
    const panel = panelRegistry[id];
    if (!panel) continue;
    renderers.set(id, mountPanel(grid, panel.label, panel));
  }

  const client = new TremiomClient({
    onStatus(s) {
      const el = document.getElementById('conn')!;
      el.textContent = s;
    },
    onPanelFrame(panelId, frame) {
      renderers.get(panelId)?.draw(frame);
    },
  });

  client.subscribe(DEFAULT_STATION, initialPanels);
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
  };
}
