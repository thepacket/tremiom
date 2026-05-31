/** Multi-dashboard manager built on gridstack.js.
 *
 *  - Many named dashboards; one displayed at a time. CRUD via the
 *    topbar dashboard bar.
 *  - Each dashboard is a set of widgets. A widget is either a streaming
 *    panel (canvas, type === a panelRegistry id, one instance) or a
 *    markdown notes panel (type "markdown", 0..many instances, each with
 *    its own editable content).
 *  - Layout + content + the dashboard list persist to localStorage
 *    (tremiom-dashboards-v2), migrating the old single-layout key.
 *  - The whole displayed dashboard can be printed to PDF.
 */

import 'gridstack/dist/gridstack.min.css';
import { GridStack } from 'gridstack';
import { panelRegistry, type PanelDef } from '../panels/registry';
import { renderMarkdown } from '../util/markdown';
import { openHelp } from './help';

const STORE_KEY = 'tremiom-dashboards-v2';
const OLD_KEY = 'tremiom-dashboard-v1';
export const MARKDOWN_TYPE = 'markdown';

interface Widget {
  id: string;   // unique instance id
  type: string; // panelRegistry id, or "markdown"
  x: number; y: number; w: number; h: number;
  content?: string; // markdown text (markdown widgets only)
}
interface Dashboard { id: string; name: string; widgets: Widget[]; }
interface Store { current: string; order: string[]; dashboards: Record<string, Dashboard>; }

interface Mounted {
  widget: Widget;
  el: HTMLElement;
  // canvas panels:
  def?: PanelDef;
  canvas?: HTMLCanvasElement;
  ctx?: CanvasRenderingContext2D;
  ro?: ResizeObserver;
  // markdown panels:
  renderedEl?: HTMLElement;
  textarea?: HTMLTextAreaElement;
}

export interface DashboardHandle {
  setFrame(panelType: string, frame: unknown): void;
  clear(panelType?: string): void;
  addPanel(panelType: string): void;
  removePanel(instanceId: string): void;
  activePanels(): string[];           // streaming panel types to subscribe
  resetLayout(): void;
  // multi-dashboard:
  listDashboards(): Array<{ id: string; name: string }>;
  currentId(): string;
  selectDashboard(id: string): void;
  createDashboard(name: string): string;
  renameDashboard(id: string, name: string): void;
  deleteDashboard(id: string): void;
  printPdf(): void;
  exportDashboard(): void;            // download current dashboard as JSON
  importDashboard(text: string): boolean; // add dashboard from JSON; returns ok
  /** Called whenever the displayed dashboard's streaming-panel set changes
   *  (panel add/remove, dashboard switch) so the caller can re-subscribe. */
}

// Default dashboard: the helicorder drum across a full row, then every
// live panel that populates for a single station within a few minutes,
// two per row. Excluded by design — clipboard (empty until you pin),
// network (needs a station group), QC (operator metrics), and the
// markdown notes panel; all available via "+ Panel".
const DEFAULT_WIDGETS: Widget[] = [
  { id: 'drum',            type: 'drum',            x: 0, y: 0,  w: 12, h: 10 },
  { id: 'spectrogram',     type: 'spectrogram',     x: 0, y: 10, w: 6,  h: 9 },
  { id: 'spectrum',        type: 'spectrum',        x: 6, y: 10, w: 6,  h: 9 },
  { id: 'psd',             type: 'psd',             x: 0, y: 19, w: 6,  h: 9 },
  { id: 'ppsd',            type: 'ppsd',            x: 6, y: 19, w: 6,  h: 9 },
  { id: 'sta-lta',         type: 'sta-lta',         x: 0, y: 28, w: 6,  h: 9 },
  { id: 'rsam',            type: 'rsam',            x: 6, y: 28, w: 6,  h: 9 },
  { id: 'raw-scope',       type: 'raw-scope',       x: 0, y: 37, w: 6,  h: 9 },
  { id: 'three-comp',      type: 'three-comp',      x: 6, y: 37, w: 6,  h: 9 },
  { id: 'particle-motion', type: 'particle-motion', x: 0, y: 46, w: 6,  h: 9 },
  { id: 'hv',              type: 'hv',              x: 6, y: 46, w: 6,  h: 9 },
];

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Old layouts used a 24-column grid (drum w24, pairs w12). The grid is
 *  now 12 columns, so scale any dashboard whose widgets exceed 12 columns
 *  down by half. Idempotent: once scaled, x+w ≤ 12 and it won't re-trigger. */
function migrate24to12(s: Store): Store {
  for (const d of Object.values(s.dashboards || {})) {
    const looks24 = (d.widgets || []).some((w) => w.x + w.w > 12);
    if (!looks24) continue;
    for (const w of d.widgets) {
      w.x = Math.round(w.x / 2);
      w.w = Math.max(1, Math.round(w.w / 2));
    }
  }
  return s;
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Store;
      if (s?.dashboards && s.current && s.dashboards[s.current]) return migrate24to12(s);
    }
  } catch { /* fall through */ }
  // Migrate the old single-layout key, if present.
  let widgets = DEFAULT_WIDGETS.slice();
  try {
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const arr = JSON.parse(old) as Array<{ id: string; x: number; y: number; w: number; h: number }>;
      const mig = (arr || []).filter((w) => w?.id && panelRegistry[w.id])
        .map((w) => ({ id: w.id, type: w.id, x: w.x, y: w.y, w: w.w, h: w.h }));
      if (mig.length) widgets = mig;
    }
  } catch { /* ignore */ }
  const id = uid('dash');
  return { current: id, order: [id], dashboards: { [id]: { id, name: 'Default', widgets } } };
}

export function mountDashboard(
  parent: HTMLElement,
  opts: { onActiveChanged(panels: string[]): void; stationName?: () => string },
): DashboardHandle {
  const root = document.createElement('div');
  root.className = 'grid-stack';
  parent.appendChild(root);

  // 12-column grid (gridstack ships CSS only for ≤12 columns; 24 needs an
  // extra stylesheet and silently fell back to 12). Default panels are
  // w:6 → two per row; the drum is w:12 → full row. Collapses to a single
  // stacked column on phones.
  const gs = GridStack.init({
    cellHeight: 30, margin: 6,
    handle: '.panel-header',
    draggable: { handle: '.panel-header', appendTo: 'body' },
    resizable: { handles: 'all' },
    float: false, animate: false,
    columnOpts: {
      breakpointForWindow: true,
      breakpoints: [{ w: 720, c: 1 }],
    },
  }, root);

  let store = loadStore();
  const mounted = new Map<string, Mounted>();
  let isLoading = false;

  const cur = () => store.dashboards[store.current];

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* non-fatal */ }
  }

  // Snapshot gridstack geometry back into the current dashboard's widgets.
  function captureGeometry() {
    if (isLoading) return;
    const nodes = gs.save(false) as Array<{ id?: string; x?: number; y?: number; w?: number; h?: number }>;
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    for (const w of cur().widgets) {
      const n = byId.get(w.id);
      if (n) { w.x = n.x ?? w.x; w.y = n.y ?? w.y; w.w = n.w ?? w.w; w.h = n.h ?? w.h; }
    }
    persist();
  }
  gs.on('change', captureGeometry);
  gs.on('resizestop', captureGeometry);
  gs.on('dragstop', captureGeometry);

  // ── Panel element construction ──────────────────────────────────────
  function buildCanvasPanel(def: PanelDef, m: Mounted): HTMLElement {
    const item = document.createElement('div');
    item.className = 'grid-stack-item';
    item.setAttribute('gs-id', m.widget.id);
    const content = document.createElement('div');
    content.className = 'grid-stack-item-content';
    const panelEl = document.createElement('div');
    panelEl.className = 'panel';
    panelEl.innerHTML = `
      <header class="panel-header">
        <span class="panel-title">${escapeHtml(def.label)}</span>
        <button class="panel-help" title="What is this panel?">?</button>
        <button class="panel-png" title="Save panel as PNG">⤓</button>
        <button class="panel-remove" title="Remove panel">×</button>
      </header>`;
    const canvas = document.createElement('canvas');
    panelEl.appendChild(canvas);
    content.appendChild(panelEl);
    item.appendChild(content);
    m.canvas = canvas;
    panelEl.querySelector('.panel-help')!.addEventListener('click', (e) => {
      e.stopPropagation(); openHelp(m.widget.type);
    });
    panelEl.querySelector('.panel-png')!.addEventListener('click', (e) => {
      e.stopPropagation(); savePanelPng(m);
    });
    panelEl.querySelector('.panel-remove')!.addEventListener('click', (e) => {
      e.stopPropagation(); removePanel(m.widget.id);
    });
    return item;
  }

  function buildMarkdownPanel(m: Mounted): HTMLElement {
    const item = document.createElement('div');
    item.className = 'grid-stack-item';
    item.setAttribute('gs-id', m.widget.id);
    const content = document.createElement('div');
    content.className = 'grid-stack-item-content';
    const panelEl = document.createElement('div');
    panelEl.className = 'panel panel-markdown';
    panelEl.innerHTML = `
      <header class="panel-header">
        <span class="panel-title">Notes</span>
        <button class="panel-help" title="What is this panel?">?</button>
        <button class="panel-edit" title="Edit / view">✎</button>
        <button class="panel-remove" title="Remove panel">×</button>
      </header>
      <div class="md-body">
        <div class="md-rendered"></div>
        <textarea class="md-edit" spellcheck="true" placeholder="# Notes&#10;Write **markdown** here…"></textarea>
      </div>`;
    content.appendChild(panelEl);
    item.appendChild(content);
    const rendered = panelEl.querySelector('.md-rendered') as HTMLElement;
    const ta = panelEl.querySelector('.md-edit') as HTMLTextAreaElement;
    m.renderedEl = rendered;
    m.textarea = ta;
    ta.value = m.widget.content ?? '';
    rendered.innerHTML = renderMarkdown(m.widget.content ?? '*(empty note — click ✎ to edit)*');

    const setEditing = (on: boolean) => {
      panelEl.classList.toggle('editing', on);
      if (on) { ta.focus(); }
      else {
        m.widget.content = ta.value;
        rendered.innerHTML = renderMarkdown(ta.value || '*(empty note — click ✎ to edit)*');
        persist();
      }
    };
    panelEl.querySelector('.panel-edit')!.addEventListener('click', (e) => {
      e.stopPropagation();
      setEditing(!panelEl.classList.contains('editing'));
    });
    // Persist on the fly (debounced) while typing.
    let t: number | null = null;
    ta.addEventListener('input', () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => { m.widget.content = ta.value; persist(); }, 400);
    });
    panelEl.querySelector('.panel-help')!.addEventListener('click', (e) => {
      e.stopPropagation(); openHelp('markdown');
    });
    panelEl.querySelector('.panel-remove')!.addEventListener('click', (e) => {
      e.stopPropagation(); removePanel(m.widget.id);
    });
    return item;
  }

  function mountWidget(w: Widget) {
    const m: Mounted = { widget: w, el: null as unknown as HTMLElement };
    let item: HTMLElement;
    if (w.type === MARKDOWN_TYPE) {
      item = buildMarkdownPanel(m);
    } else {
      const def = panelRegistry[w.type];
      if (!def) return; // unknown panel type (e.g. removed) — skip
      m.def = def;
      item = buildCanvasPanel(def, m);
    }
    m.el = item;
    root.appendChild(item);
    gs.makeWidget(item, { x: w.x, y: w.y, w: w.w, h: w.h, id: w.id });

    if (m.canvas && m.def) {
      const canvas = m.canvas, def = m.def;
      const ctx = canvas.getContext('2d')!;
      m.ctx = ctx;
      const ro = new ResizeObserver(() => {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        def.render(ctx, canvas, null);
      });
      ro.observe(canvas);
      m.ro = ro;
    }
    mounted.set(w.id, m);
  }

  function unmountAll() {
    for (const m of mounted.values()) {
      m.ro?.disconnect();
      try { gs.removeWidget(m.el, true); } catch { /* ignore */ }
    }
    mounted.clear();
  }

  function renderCurrent() {
    isLoading = true;
    unmountAll();
    for (const w of cur().widgets) mountWidget(w);
    isLoading = false;
    opts.onActiveChanged(activePanels());
  }

  function activePanels(): string[] {
    const set = new Set<string>();
    for (const m of mounted.values()) if (m.def) set.add(m.widget.type);
    return [...set];
  }

  function savePanelPng(m: Mounted) {
    if (!m.canvas) return;
    m.canvas.toBlob((blob) => {
      if (!blob) return;
      const station = (opts.stationName?.() || 'station').replace(/[^A-Za-z0-9._-]/g, '_');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tremiom_${station}_${m.widget.type}_${stamp}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }

  function removePanel(instanceId: string) {
    const m = mounted.get(instanceId);
    if (!m) return;
    m.ro?.disconnect();
    try { gs.removeWidget(m.el, true); } catch { /* ignore */ }
    mounted.delete(instanceId);
    cur().widgets = cur().widgets.filter((w) => w.id !== instanceId);
    persist();
    opts.onActiveChanged(activePanels());
  }

  function addPanel(panelType: string) {
    if (panelType !== MARKDOWN_TYPE && !panelRegistry[panelType]) return;
    // Streaming panels are single-instance per dashboard; markdown is multi.
    if (panelType !== MARKDOWN_TYPE && cur().widgets.some((w) => w.type === panelType)) return;
    const id = panelType === MARKDOWN_TYPE ? uid('md') : panelType;
    const w: Widget = {
      id, type: panelType, x: 0, y: 1000, // gridstack drops it at the bottom
      w: 6,  // half of the 12-column grid
      h: panelType === MARKDOWN_TYPE ? 6 : 9,
      ...(panelType === MARKDOWN_TYPE ? { content: '' } : {}),
    };
    cur().widgets.push(w);
    mountWidget(w);
    captureGeometry();
    opts.onActiveChanged(activePanels());
  }

  // ── Multi-dashboard ops ─────────────────────────────────────────────
  function selectDashboard(id: string) {
    if (!store.dashboards[id] || id === store.current) return;
    captureGeometry();
    store.current = id;
    persist();
    renderCurrent();
  }
  function createDashboard(name: string): string {
    captureGeometry();
    const id = uid('dash');
    store.dashboards[id] = { id, name: name || 'Untitled', widgets: DEFAULT_WIDGETS.slice() };
    store.order.push(id);
    store.current = id;
    persist();
    renderCurrent();
    return id;
  }
  function renameDashboard(id: string, name: string) {
    if (store.dashboards[id]) { store.dashboards[id].name = name || store.dashboards[id].name; persist(); }
  }
  function deleteDashboard(id: string) {
    if (!store.dashboards[id]) return;
    if (store.order.length <= 1) return; // keep at least one
    delete store.dashboards[id];
    store.order = store.order.filter((x) => x !== id);
    if (store.current === id) store.current = store.order[0];
    persist();
    renderCurrent();
  }

  // Initial render (deferred onActiveChanged like before to avoid TDZ).
  isLoading = true;
  for (const w of cur().widgets) mountWidget(w);
  isLoading = false;

  return {
    setFrame(panelType, frame) {
      for (const m of mounted.values()) {
        if (m.def && m.widget.type === panelType && m.ctx && m.canvas) {
          try { m.def.render(m.ctx, m.canvas, frame); }
          catch (e) { console.warn(`[panel ${panelType}] render failed:`, e); }
        }
      }
    },
    clear(panelType) {
      for (const m of mounted.values()) {
        if (!m.def || !m.ctx || !m.canvas) continue;
        if (!panelType || m.widget.type === panelType) m.def.render(m.ctx, m.canvas, null);
      }
    },
    addPanel,
    removePanel,
    activePanels,
    resetLayout() {
      cur().widgets = DEFAULT_WIDGETS.slice();
      persist();
      renderCurrent();
    },
    listDashboards: () => store.order.map((id) => ({ id, name: store.dashboards[id].name })),
    currentId: () => store.current,
    selectDashboard,
    createDashboard,
    renameDashboard,
    deleteDashboard,
    exportDashboard() {
      captureGeometry();
      const d = cur();
      const doc = {
        tremiom: 'dashboard', version: 1,
        name: d.name, widgets: d.widgets,
        exportedAt: new Date().toISOString(),
      };
      const safe = d.name.replace(/[^A-Za-z0-9._-]/g, '_') || 'dashboard';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
      a.download = `tremiom_dashboard_${safe}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    importDashboard(text) {
      let doc: { name?: string; widgets?: unknown };
      try { doc = JSON.parse(text); } catch { return false; }
      // Accept the wrapped export, a bare {name,widgets}, or a raw array.
      const rawWidgets = Array.isArray(doc) ? doc
        : Array.isArray((doc as { widgets?: unknown }).widgets) ? (doc as { widgets: unknown[] }).widgets
        : null;
      if (!rawWidgets) return false;
      // Validate + sanitize widgets; keep only known panel types + markdown.
      const widgets: Widget[] = [];
      for (const w of rawWidgets as Array<Record<string, unknown>>) {
        const type = String(w.type ?? w.id ?? '');
        if (type !== MARKDOWN_TYPE && !panelRegistry[type]) continue;
        const id = type === MARKDOWN_TYPE ? uid('md') : type;
        widgets.push({
          id, type,
          x: num(w.x, 0), y: num(w.y, 1000), w: num(w.w, 6), h: num(w.h, 9),
          ...(type === MARKDOWN_TYPE ? { content: typeof w.content === 'string' ? w.content : '' } : {}),
        });
      }
      if (!widgets.length) return false;
      captureGeometry();
      const id = uid('dash');
      const name = (typeof (doc as { name?: unknown }).name === 'string'
        ? (doc as { name: string }).name : 'Imported') || 'Imported';
      store.dashboards[id] = { id, name, widgets };
      store.order.push(id);
      store.current = id;
      persist();
      renderCurrent();
      return true;
    },
    printPdf() {
      captureGeometry();
      document.body.classList.add('printing-dashboard');
      const cleanup = () => {
        document.body.classList.remove('printing-dashboard');
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      window.print();
      // Fallback cleanup if afterprint doesn't fire.
      setTimeout(cleanup, 1500);
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}
