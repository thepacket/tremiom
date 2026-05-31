/** Grafana-style configurable dashboard built on gridstack.js.
 *
 *  Each panel is a gridstack widget the user can drag (by its header)
 *  and resize (from any corner / edge). Layout persists to
 *  localStorage on every change; first load uses DEFAULT_LAYOUT.
 *
 *  The dashboard owns the canvas + render plumbing per panel; app.ts
 *  pushes frames into setFrame() and asks for state changes through
 *  addPanel / removePanel.
 */

import 'gridstack/dist/gridstack.min.css';
import { GridStack, type GridStackWidget } from 'gridstack';
import { panelRegistry, type PanelDef } from '../panels/registry';

const STORAGE_KEY = 'tremiom-dashboard-v1';

interface MountedPanel {
  id: string;
  panel: PanelDef;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  ro: ResizeObserver;
}

export interface DashboardHandle {
  setFrame(panelId: string, frame: unknown): void;
  clear(panelId?: string): void;
  addPanel(panelId: string): void;
  removePanel(panelId: string): void;
  activePanels(): string[];
  resetLayout(): void;
}

/** Sensible default placement on a 24-column grid (cellHeight = 30 px). */
const DEFAULT_LAYOUT: GridStackWidget[] = [
  // Top: drum spans the full width (the iconic display).
  { id: 'drum',            x:  0, y:  0, w: 24, h: 10 },
  // RSAM full-width strip directly under the drum — both are 24-h
  // timelines, so stacking them lets the eye correlate amplitude
  // trend against the drum's individual traces.
  { id: 'rsam',            x:  0, y: 10, w: 24, h:  7 },
  // Spectrogram + STA/LTA side by side.
  { id: 'spectrogram',     x:  0, y: 17, w: 12, h:  9 },
  { id: 'sta-lta',         x: 12, y: 17, w: 12, h:  9 },
  // Particle motion (square, narrower) + PPSD (wide).
  { id: 'particle-motion', x:  0, y: 26, w:  8, h: 11 },
  { id: 'ppsd',            x:  8, y: 26, w: 16, h: 11 },
];

export function mountDashboard(
  parent: HTMLElement,
  opts: { onActiveChanged(panels: string[]): void },
): DashboardHandle {
  const root = document.createElement('div');
  root.className = 'grid-stack';
  parent.appendChild(root);

  const gs = GridStack.init({
    column: 24,
    cellHeight: 30,
    margin: 6,
    handle: '.panel-header',
    draggable: { handle: '.panel-header', appendTo: 'body' },
    resizable: { handles: 'all' },
    float: false,
    animate: false,
  }, root);

  const mounted = new Map<string, MountedPanel>();
  let isLoading = true; // suppress persistence during initial layout build

  function buildPanelEl(def: PanelDef): { item: HTMLElement; canvas: HTMLCanvasElement } {
    const item = document.createElement('div');
    item.className = 'grid-stack-item';
    item.setAttribute('gs-id', def.id);
    const content = document.createElement('div');
    content.className = 'grid-stack-item-content';
    const panelEl = document.createElement('div');
    panelEl.className = 'panel';
    panelEl.innerHTML = `
      <header class="panel-header">
        <span class="panel-title">${escapeHtml(def.label)}</span>
        <button class="panel-remove" title="Remove panel" aria-label="Remove">×</button>
      </header>
    `;
    const canvas = document.createElement('canvas');
    panelEl.appendChild(canvas);
    content.appendChild(panelEl);
    item.appendChild(content);
    return { item, canvas };
  }

  function ensurePanel(id: string, placement?: GridStackWidget): void {
    if (mounted.has(id)) return;
    const def = panelRegistry[id];
    if (!def) return;
    const { item, canvas } = buildPanelEl(def);

    // gridstack 12: attach the pre-built element to the grid root,
    // then register it with makeWidget(el, opts).
    root.appendChild(item);
    if (placement) {
      gs.makeWidget(item, {
        x: placement.x, y: placement.y,
        w: placement.w, h: placement.h, id,
      });
    } else {
      gs.makeWidget(item, { autoPosition: true, w: 12, h: 8, id });
    }

    const ctx = canvas.getContext('2d')!;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width  = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Re-render last frame placeholder after a resize.
      def.render(ctx, canvas, null);
    });
    ro.observe(canvas);

    item.querySelector('.panel-remove')!.addEventListener('click', (e) => {
      e.stopPropagation();
      removePanel(id);
    });

    mounted.set(id, { id, panel: def, el: item, canvas, ctx, ro });
  }

  function removePanel(id: string): void {
    const m = mounted.get(id);
    if (!m) return;
    gs.removeWidget(m.el);
    m.ro.disconnect();
    mounted.delete(id);
    persistLayout();
    opts.onActiveChanged([...mounted.keys()]);
  }

  function addPanel(id: string): void {
    if (mounted.has(id)) return;
    if (!panelRegistry[id]) return;
    ensurePanel(id);
    persistLayout();
    opts.onActiveChanged([...mounted.keys()]);
  }

  function persistLayout(): void {
    if (isLoading) return;
    try {
      const serial = gs.save(false); // don't include rendered content
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serial));
    } catch { /* localStorage full / disabled — non-fatal */ }
  }

  gs.on('change', persistLayout);
  gs.on('resizestop', persistLayout);
  gs.on('dragstop',   persistLayout);

  // First-time layout: saved (if any) or default.
  let initial: GridStackWidget[];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    initial = raw ? JSON.parse(raw) : DEFAULT_LAYOUT.slice();
  } catch {
    initial = DEFAULT_LAYOUT.slice();
  }
  // Drop any saved panel ids that no longer exist in the registry.
  initial = (initial || []).filter((w) => w?.id && panelRegistry[w.id as string]);
  if (!initial.length) initial = DEFAULT_LAYOUT.slice();
  for (const w of initial) {
    ensurePanel(w.id as string, w);
  }
  isLoading = false;

  // Note: we deliberately don't fire opts.onActiveChanged() during
  // construction — the caller can read activePanels() once everything
  // else (WebSocket client, etc.) is wired up. Firing here would call
  // the handler synchronously and hit any `const` declared further
  // down in app.ts (TDZ ReferenceError), which silently halts the
  // rest of mountApp().

  return {
    setFrame(panelId, frame) {
      const m = mounted.get(panelId);
      if (!m) return;
      try {
        m.panel.render(m.ctx, m.canvas, frame);
      } catch (e) {
        console.warn(`[panel ${panelId}] render failed:`, e);
      }
    },
    clear(panelId) {
      const targets = panelId
        ? (mounted.has(panelId) ? [mounted.get(panelId)!] : [])
        : [...mounted.values()];
      for (const m of targets) m.panel.render(m.ctx, m.canvas, null);
    },
    addPanel,
    removePanel,
    activePanels: () => [...mounted.keys()],
    resetLayout() {
      // Remove every panel, then rebuild from DEFAULT_LAYOUT. Persist
      // the new layout immediately.
      for (const id of [...mounted.keys()]) {
        const m = mounted.get(id)!;
        gs.removeWidget(m.el);
        m.ro.disconnect();
      }
      mounted.clear();
      for (const w of DEFAULT_LAYOUT) ensurePanel(w.id as string, w);
      persistLayout();
      opts.onActiveChanged([...mounted.keys()]);
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}
