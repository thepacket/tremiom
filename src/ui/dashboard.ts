/** Panel grid. Every registered panel is shown, in alphabetical order,
 *  filling N panels per row (N set from the topbar "Per row" field). No
 *  custom layout, drag/resize, or multiple dashboards — a simple
 *  auto-filling grid. Each panel has a help (?) and save-PNG (⤓) button. */

import { panelRegistry, type PanelDef } from '../panels/registry';
import { openHelp } from './help';

export interface DashboardHandle {
  /** Render a freshly computed frame into its panel. */
  setFrame(panelType: string, frame: unknown): void;
  /** Blank one panel (or all) — render with a null frame. */
  clear(panelType?: string): void;
  /** All displayed panel ids (the caller subscribes to these). */
  activePanels(): string[];
  /** Set how many panels appear per row. */
  setPerRow(n: number): void;
  /** Set the height (px) of each panel row. */
  setHeight(px: number): void;
  /** Re-measure + redraw every panel with its latest frame. */
  refresh(): void;
}

interface Mounted {
  def: PanelDef;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  lastFrame?: unknown;
}

const MIN_PER_ROW = 1;
const MAX_PER_ROW = 6;
export function clampPerRow(n: number): number {
  return Math.max(MIN_PER_ROW, Math.min(MAX_PER_ROW, Math.round(n) || MIN_PER_ROW));
}

export function mountDashboard(
  parent: HTMLElement,
  opts: {
    onActiveChanged(panels: string[]): void;
    stationName?: () => string;
    perRow?: number;
    height?: number;
  },
): DashboardHandle {
  const grid = document.createElement('div');
  grid.className = 'panel-grid';
  // Layout vars live on :root so the History/Event analysis strips inherit
  // the same panels-per-row + height as the live grid.
  document.documentElement.style.setProperty('--per-row', String(clampPerRow(opts.perRow ?? 2)));
  document.documentElement.style.setProperty('--panel-h', `${opts.height ?? 200}px`);
  parent.appendChild(grid);

  // The 24-hour Helicorder (drum) leads: full-width + double height. The
  // rest follow alphabetically (case-insensitive) by label, ties by id.
  const FEATURED = 'drum';
  const rest = Object.keys(panelRegistry)
    .filter((id) => id !== FEATURED)
    .sort((a, b) => {
      const byLabel = panelRegistry[a].label.localeCompare(
        panelRegistry[b].label, undefined, { sensitivity: 'base' });
      return byLabel !== 0 ? byLabel : a.localeCompare(b);
    });
  const ids = panelRegistry[FEATURED] ? [FEATURED, ...rest] : rest;

  const mounted = new Map<string, Mounted>();

  for (const id of ids) {
    const def = panelRegistry[id];
    const panelEl = document.createElement('div');
    panelEl.className = id === FEATURED ? 'panel panel-wide' : 'panel';
    panelEl.innerHTML = `
      <header class="panel-header">
        <span class="panel-title">${escapeHtml(def.label)}</span>
        <button class="panel-help" title="What is this panel?">?</button>
        <button class="panel-png" title="Save panel as PNG">⤓</button>
      </header>`;
    const canvas = document.createElement('canvas');
    panelEl.appendChild(canvas);
    grid.appendChild(panelEl);

    panelEl.dataset.panelId = id;
    const ctx = canvas.getContext('2d')!;
    const m: Mounted = { def, el: panelEl, canvas, ctx };
    mounted.set(id, m);

    panelEl.querySelector('.panel-help')!.addEventListener('click', () => openHelp(id));
    panelEl.querySelector('.panel-png')!.addEventListener('click', () => savePng(m, id));

    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      def.render(ctx, canvas, m.lastFrame ?? null);
    });
    ro.observe(canvas);
  }

  function savePng(m: Mounted, id: string) {
    m.canvas.toBlob((blob) => {
      if (!blob) return;
      const station = (opts.stationName?.() || 'station').replace(/[^A-Za-z0-9._-]/g, '_');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tremiom_${station}_${id}_${stamp}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }

  // Only the panels actually on-screen are "active" (subscribed). With every
  // panel always in the grid, computing all of them — especially the Network
  // panel's 6-station 24-h backfill fan-out — would swamp the server. An
  // IntersectionObserver tracks which panels are visible and the caller
  // re-subscribes to just those (panels hidden in Event/History mode, or
  // scrolled off-screen, drop out). `rootMargin` preloads slightly early.
  const visible = new Set<string>();
  let notifyTimer: number | undefined;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset.panelId;
      if (!id) continue;
      if (e.isIntersecting) visible.add(id); else visible.delete(id);
    }
    clearTimeout(notifyTimer);
    notifyTimer = window.setTimeout(() => opts.onActiveChanged([...visible]), 200);
  }, { root: null, rootMargin: '200px 0px' });
  for (const m of mounted.values()) io.observe(m.el);

  return {
    setFrame(panelType, frame) {
      const m = mounted.get(panelType);
      if (!m) return;
      m.lastFrame = frame;
      try { m.def.render(m.ctx, m.canvas, frame); }
      catch (e) { console.warn(`[panel ${panelType}] render failed:`, e); }
    },
    clear(panelType) {
      for (const [id, m] of mounted) {
        if (!panelType || id === panelType) { m.lastFrame = null; m.def.render(m.ctx, m.canvas, null); }
      }
    },
    activePanels: () => [...visible],
    setPerRow(n) { document.documentElement.style.setProperty('--per-row', String(clampPerRow(n))); },
    setHeight(px) { document.documentElement.style.setProperty('--panel-h', `${px}px`); },
    refresh() {
      for (const m of mounted.values()) {
        const dpr = window.devicePixelRatio || 1;
        m.canvas.width = Math.max(1, Math.floor(m.canvas.clientWidth * dpr));
        m.canvas.height = Math.max(1, Math.floor(m.canvas.clientHeight * dpr));
        m.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        try { m.def.render(m.ctx, m.canvas, m.lastFrame ?? null); }
        catch (e) { console.warn(`[panel] refresh render failed:`, e); }
      }
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}
