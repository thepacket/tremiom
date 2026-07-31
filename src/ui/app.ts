import { resetSpectrogram } from '../panels/spectrogram';
import { resetDrum, setDrumOverlays } from '../panels/drum';
import { resetRsam } from '../panels/rsam';
import { resetSpectrum } from '../panels/spectrum';
import { TremiomClient } from '../transport/ws';
import { DEFAULT_STATION, STATION_PRESETS } from '../data/stations';
import { mountStationPicker } from './station-picker';
import { mountFilterPicker } from './filter-picker';
import { DEFAULT_FILTER, FILTER_PRESETS, type FilterSpec } from '../data/filters';
import { mountUnitsPicker, DEFAULT_UNITS, UNIT_OPTIONS } from './units-picker';
import { mountEventList } from './event-list';
import { mountWorldMap } from './world-map';
import { mountRecordSection } from './record-section';
import { mountHistoryView } from './history-view';
import { openSettings } from './settings';
import { openHelp } from './help';
import { openAbout } from './about';
import { initTooltips } from './tooltip';
import { mountDashboard, type DashboardHandle } from './dashboard';
import { mountAlertPicker } from './alert-picker';
import { alerts } from './alerts';
import { feedNetwork, resetNetwork, networkGroup } from '../panels/network';
import type { SeismicEvent } from '../data/events';
import { mountAiTerminal, type AiInstruction } from './ai-terminal';

export function mountApp(root: HTMLElement, version: string): void {
  root.innerHTML = '';

  // ── Topbar ──────────────────────────────────────────────────────────
  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  topbar.innerHTML = `
    <div class="topbar-row">
      <span class="brand">Tremiom</span>
      <span class="muted">v${version}</span>
      <span class="topbar-label">Station</span>
      <span id="picker-mount"></span>
      <span class="topbar-label">Filter</span>
      <span id="filter-mount"></span>
      <span class="topbar-label">Units</span>
      <span id="units-mount"></span>
      <span class="topbar-spacer"></span>
      <button class="settings-btn" id="help-btn" title="Help" aria-label="Help">?</button>
      <button class="settings-btn" id="about-btn" title="About" aria-label="About">ⓘ</button>
      <button class="settings-btn" id="settings-btn" title="Settings" aria-label="Settings">⚙</button>
    </div>
    <div class="topbar-row">
      <span class="topbar-label">Alerts</span>
      <span id="alert-picker-mount"></span>
      <span class="topbar-label">Mode</span>
      <select class="mode-select" id="mode-select" title="Current mode — switch between Live and History">
        <option value="live">Live</option>
        <option value="history">History</option>
      </select>
      <span class="utc-clock-box">
        <span class="topbar-label">UTC</span>
        <span class="topbar-clock" id="utc-clock" title="Current UTC time"></span>
      </span>
      <span class="topbar-spacer"></span>
      <span class="plot-toolbar">
        <span id="plot-mode-controls" class="plot-mode-controls"></span>
        <span class="topbar-label secondary">Height</span>
        <select id="panel-height" class="per-row-input" title="Plot height (px)">
          <option>100</option><option>150</option><option>200</option><option>250</option>
          <option>300</option><option>350</option><option>400</option><option>450</option>
        </select>
        <button class="refresh-btn" id="refresh-btn" title="Redraw all plots with the current settings">Refresh</button>
      </span>
    </div>
  `;
  root.appendChild(topbar);

  // ── Workbench: events | map | resizable one-column plots ───────────
  const workspace = document.createElement('div');
  workspace.className = 'workspace';
  root.appendChild(workspace);

  const eventsPane = document.createElement('div');
  eventsPane.className = 'events-pane';
  workspace.appendChild(eventsPane);

  const sidebarHost = document.createElement('div');
  sidebarHost.className = 'sidebar-host';
  eventsPane.appendChild(sidebarHost);
  const sidebarToggle = document.createElement('button');
  sidebarToggle.className = 'sidebar-toggle';
  eventsPane.appendChild(sidebarToggle);

  const centerPane = document.createElement('main');
  centerPane.className = 'center-pane';
  workspace.appendChild(centerPane);

  const mapHost = document.createElement('div');
  mapHost.className = 'map-host';
  centerPane.appendChild(mapHost);

  const plotSplitter = document.createElement('div');
  plotSplitter.className = 'plot-width-splitter';
  plotSplitter.title = 'Drag to give the plots more or less space';
  plotSplitter.tabIndex = 0;
  plotSplitter.setAttribute('role', 'separator');
  plotSplitter.setAttribute('aria-label', 'Resize plots');
  plotSplitter.setAttribute('aria-orientation', 'vertical');
  workspace.appendChild(plotSplitter);

  const plotsPane = document.createElement('aside');
  plotsPane.className = 'plots-pane';
  workspace.appendChild(plotsPane);

  mountSidebarCollapse(eventsPane, sidebarToggle);
  mountPlotWidthSplitter(plotSplitter, plotsPane);

  // ── Independently scrollable plot inspector ─────────────────────────
  const plotScrollShell = document.createElement('div');
  plotScrollShell.className = 'plot-scroll-shell';
  plotsPane.appendChild(plotScrollShell);
  const body = document.createElement('div');
  body.className = 'body';
  body.id = 'plot-viewport';
  plotScrollShell.appendChild(body);
  const plotScrollRail = document.createElement('div');
  plotScrollRail.className = 'plot-scroll-rail';
  plotScrollRail.tabIndex = 0;
  plotScrollRail.setAttribute('role', 'scrollbar');
  plotScrollRail.setAttribute('aria-label', 'Scroll plots');
  plotScrollRail.setAttribute('aria-controls', body.id);
  plotScrollRail.setAttribute('aria-orientation', 'vertical');
  plotScrollRail.setAttribute('aria-valuemin', '0');
  plotScrollRail.setAttribute('aria-valuemax', '100');
  plotScrollRail.innerHTML = '<div class="plot-scroll-thumb"></div>';
  plotScrollShell.appendChild(plotScrollRail);
  mountPlotScrollbar(body, plotScrollRail);

  // ── Status bar (fixed at the bottom; connection status centered) ────
  const statusBar = document.createElement('div');
  statusBar.className = 'status-bar';
  statusBar.innerHTML = `<span class="muted" id="conn">connecting…</span>`;
  root.appendChild(statusBar);

  // ── State ───────────────────────────────────────────────────────────
  let currentStation = DEFAULT_STATION;
  let currentEventId: string | null = null;
  let firstFrameAt: number | null = null;
  const subscribedAt = Date.now();
  let currentFilter: FilterSpec = DEFAULT_FILTER;
  let currentUnits: string = DEFAULT_UNITS;
  let currentMode: 'live' | 'event' | 'history' = 'live';

  // Drum overlay state — events + station coords for predicted-arrival markers.
  let currentEvents: SeismicEvent[] = [];
  const stationCoords = new Map<string, { lat: number; lon: number }>();
  for (const s of STATION_PRESETS) stationCoords.set(s.nslc, { lat: s.lat, lon: s.lon });
  function refreshDrumOverlays() {
    const c = stationCoords.get(currentStation);
    setDrumOverlays(currentEvents, c?.lat ?? null, c?.lon ?? null);
  }
  async function ensureStationCoords(nslc: string) {
    if (stationCoords.has(nslc)) return;
    try {
      const r = await fetch(`/api/stations/lookup?nslc=${encodeURIComponent(nslc)}`);
      if (!r.ok) return;
      const j = await r.json() as { found?: boolean; station?: { lat: number; lon: number } };
      if (!j.found || !j.station) return;
      stationCoords.set(nslc, { lat: j.station.lat, lon: j.station.lon });
      if (nslc === currentStation) refreshDrumOverlays();
    } catch { /* network blip — leave coords unknown */ }
  }
  window.addEventListener('tremiom:station-coords', (ev: Event) => {
    const d = (ev as CustomEvent).detail as { nslc: string; lat: number; lon: number };
    if (d?.nslc && Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
      stationCoords.set(d.nslc, { lat: d.lat, lon: d.lon });
      if (d.nslc === currentStation) refreshDrumOverlays();
    }
  });

  // ── Main area: dashboard (live mode) ⇄ record-section (event mode) ─
  const mainArea = document.createElement('div');
  mainArea.className = 'main-area';
  body.appendChild(mainArea);

  // Live mode container — the panel grid mounts inside.
  const dashHost = document.createElement('div');
  dashHost.className = 'dash-host';
  mainArea.appendChild(dashHost);

  // Event mode container.
  const eventHost = document.createElement('div');
  eventHost.className = 'event-host hidden';
  mainArea.appendChild(eventHost);
  const recordSection = mountRecordSection(eventHost, {
    units: () => currentUnits,
    filter: () => currentFilter,
  });

  // History (waveform-browser) mode container.
  const historyHost = document.createElement('div');
  historyHost.className = 'history-host hidden';
  mainArea.appendChild(historyHost);
  const historyView = mountHistoryView(historyHost, {
    station: () => currentStation,
    units: () => currentUnits,
    filter: () => currentFilter,
  });
  const plotModeControls = document.getElementById('plot-mode-controls') as HTMLElement;
  const recordRoot = eventHost.querySelector('.record-section') as HTMLElement;
  const recordToolbar = recordRoot.querySelector('.record-toolbar') as HTMLElement;
  const historyRoot = historyHost.querySelector('.history-view') as HTMLElement;
  const historyToolbar = historyRoot.querySelector('.history-toolbar') as HTMLElement;

  function syncPlotModeControls(mode: 'live' | 'event' | 'history'): void {
    if (recordToolbar.parentElement !== recordRoot) recordRoot.prepend(recordToolbar);
    if (historyToolbar.parentElement !== historyRoot) historyRoot.prepend(historyToolbar);
    recordRoot.classList.remove('toolbar-detached');
    historyRoot.classList.remove('toolbar-detached');
    plotModeControls.replaceChildren();
    if (mode === 'event') {
      plotModeControls.appendChild(recordToolbar);
      recordRoot.classList.add('toolbar-detached');
    } else if (mode === 'history') {
      plotModeControls.appendChild(historyToolbar);
      historyRoot.classList.add('toolbar-detached');
    }
  }

  // The dashboard ⇄ subscription bridge: the dashboard tells us which
  // panels are mounted; we re-subscribe with that list so the worker
  // only computes what's visible. `client` is declared below — until
  // it exists, onActiveChanged is a no-op (mountDashboard purposely
  // doesn't fire it during construction).
  let activePanels: string[] = [];
  // Panels we actually subscribe to = visible dashboard panels, plus
  // sta-lta when alerts are on (so triggers fire even if that panel
  // isn't displayed).
  function subscribedPanels(): string[] {
    // The 'network' panel is a client-side multi-station aggregator; it
    // has no server-side per-currentStation computation, so exclude it
    // from the main station's subscription (its data comes from the
    // separate per-group-station rsam subscriptions below).
    const set = new Set(activePanels.filter((p) => p !== 'network'));
    if (alerts.isEnabled()) set.add('sta-lta');
    return [...set];
  }
  function resubscribe() {
    if (!clientReady) return;
    client.subscribe(currentStation, subscribedPanels());
    // Network panel: subscribe every group station for rsam so the
    // multi-station overview fills (each kicks its own 24-h backfill
    // server-side). Skipped entirely when the panel isn't mounted.
    if (activePanels.includes('network')) {
      for (const gs of networkGroup()) {
        if (gs !== currentStation) client.subscribe(gs, ['rsam']);
      }
    }
  }
  function onActiveChanged(ids: string[]) {
    activePanels = ids;
    resubscribe();
  }
  let clientReady = false;
  const HEIGHT_KEY = 'tremiom-panel-height';
  const HEIGHT_OPTIONS = [100, 150, 200, 250, 300, 350, 400, 450];
  const initialPerRow = 1;
  const initialHeight = HEIGHT_OPTIONS.includes(Number(localStorage.getItem(HEIGHT_KEY)))
    ? Number(localStorage.getItem(HEIGHT_KEY)) : 200;
  const dashboard: DashboardHandle = mountDashboard(dashHost, {
    onActiveChanged,
    stationName: () => currentStation,
    perRow: initialPerRow,
    height: initialHeight,
  });
  activePanels = dashboard.activePanels();

  // "Height" controls the pixel height of each panel row.
  const heightInput = document.getElementById('panel-height') as HTMLSelectElement;
  heightInput.value = String(initialHeight);
  heightInput.addEventListener('change', () => {
    const px = Number(heightInput.value);
    dashboard.setHeight(px);
    localStorage.setItem(HEIGHT_KEY, String(px));
  });

  document.getElementById('refresh-btn')?.addEventListener('click', () => dashboard.refresh());

  // ── Transport ───────────────────────────────────────────────────────
  const client = new TremiomClient({
    onStatus(s) {
      const el = document.getElementById('conn');
      if (!el) return;
      if (firstFrameAt === null && s === 'connected') {
        const elapsed = ((Date.now() - subscribedAt) / 1000).toFixed(0);
        el.textContent = `connected · waiting for first sample (${elapsed}s)`;
      } else {
        el.textContent = s;
      }
    },
    onPanelFrame(panelId, frame) {
      const fstation = (frame as { station?: string }).station;
      // Network panel: route rsam frames for ANY group station to the
      // multi-station aggregator (independent of the global selection).
      if (panelId === 'rsam' && activePanels.includes('network') &&
          fstation && networkGroup().includes(fstation)) {
        feedNetwork(fstation, frame as { startMs: number; binS: number; data: Array<number | null> });
        dashboard.setFrame('network', frame); // trigger a redraw
      }
      if (fstation !== currentStation) return;
      if (firstFrameAt === null) {
        firstFrameAt = Date.now();
        const el = document.getElementById('conn');
        if (el) {
          const latency = ((firstFrameAt - subscribedAt) / 1000).toFixed(1);
          el.textContent = `live · first frame at +${latency}s`;
        }
      }
      dashboard.setFrame(panelId, frame);
      // Feed STA/LTA peaks to the alert evaluator (works even if the
      // sta-lta panel isn't on the dashboard).
      if (panelId === 'sta-lta') {
        const fr = frame as { station: string; data?: number[] };
        if (fr.data?.length) {
          let peak = 0;
          for (const v of fr.data) if (v > peak) peak = v;
          alerts.feed(fr.station, peak);
        }
      }
    },
  });

  // First-frame countdown ticker.
  const connTicker = window.setInterval(() => {
    if (firstFrameAt !== null) return;
    const el = document.getElementById('conn');
    if (el && el.textContent?.startsWith('connected · waiting')) {
      const elapsed = ((Date.now() - subscribedAt) / 1000).toFixed(0);
      el.textContent = `connected · waiting for first sample (${elapsed}s)`;
    }
  }, 1000);
  window.setTimeout(() => {
    if (firstFrameAt !== null) window.clearInterval(connTicker);
  }, 60_000);

  // ── Live / Event / History mode switch ──────────────────────────────
  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
  // Reflect the active mode in the dropdown. "Event" is only an option while
  // an event record-section is open, so the selector never shows a stale mode.
  function setModeSelect(mode: 'live' | 'event' | 'history') {
    const eventOpt = modeSelect.querySelector('option[value="event"]');
    if (mode === 'event' && !eventOpt) {
      const o = document.createElement('option');
      o.value = 'event'; o.textContent = 'Event';
      modeSelect.insertBefore(o, modeSelect.firstChild);
    } else if (mode !== 'event' && eventOpt) {
      eventOpt.remove();
    }
    modeSelect.value = mode;
  }
  function showLive() {
    dashHost.classList.remove('hidden');
    eventHost.classList.add('hidden');
    historyHost.classList.add('hidden');
    historyView.hide();
    currentMode = 'live';
    syncPlotModeControls('live');
    setModeSelect('live');
  }
  function showEvent() {
    dashHost.classList.add('hidden');
    eventHost.classList.remove('hidden');
    historyHost.classList.add('hidden');
    historyView.hide();
    currentMode = 'event';
    syncPlotModeControls('event');
    setModeSelect('event');
  }
  function showHistory() {
    dashHost.classList.add('hidden');
    eventHost.classList.add('hidden');
    historyHost.classList.remove('hidden');
    historyView.show();
    currentMode = 'history';
    syncPlotModeControls('history');
    setModeSelect('history');
  }

  // ── Map + sidebar + station/event coordination ──────────────────────
  function pickEvent(e: SeismicEvent | null) {
    currentEventId = e?.id ?? null;
    worldMap.setSelectedEvent(currentEventId);
    eventList.setSelectedEvent(currentEventId);
    worldMap.setDyfi([]);            // clear previous event's felt polygons
    worldMap.setShakemap(null, null); // clear previous ShakeMap overlay
    if (e) {
      showEvent();
      void recordSection.setEvent(e);
      // Overlay the event's DYFI felt-report polygons on the map (if any).
      void (async () => {
        try {
          const r = await fetch(`/api/event/dyfi?id=${encodeURIComponent(e.id)}`);
          if (!r.ok) return;
          const d = await r.json() as { polygons?: Array<{ cdi: number; ring: number[][] }> };
          if (currentEventId === e.id && d.polygons?.length) worldMap.setDyfi(d.polygons);
        } catch { /* no felt data — fine */ }
      })();
      // Overlay the modeled ShakeMap intensity raster (if available).
      void (async () => {
        try {
          const r = await fetch(`/api/event/shakemap?id=${encodeURIComponent(e.id)}`);
          if (!r.ok) return;
          const d = await r.json() as {
            hasShakemap?: boolean;
            bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
          };
          if (currentEventId === e.id && d.hasShakemap && d.bbox) {
            worldMap.setShakemap(d.bbox, `/api/event/shakemap-image?id=${encodeURIComponent(e.id)}`);
          }
        } catch { /* no shakemap — fine */ }
      })();
    } else {
      showLive();
      void recordSection.setEvent(null);
    }
  }

  function switchStation(next: string) {
    if (next === currentStation) return;
    client.unsubscribe(currentStation);
    resetSpectrogram();
    resetDrum();
    resetRsam();
    resetSpectrum();
    resetNetwork();
    dashboard.clear();
    currentStation = next;
    firstFrameAt = null;
    const subAt = Date.now();
    const el = document.getElementById('conn');
    if (el) el.textContent = `connected · waiting for first sample (0s)`;
    worldMap.setActiveStation(next);
    picker.setStation(next);
    refreshDrumOverlays();
    void ensureStationCoords(currentStation);
    client.subscribe(currentStation, subscribedPanels());
    if (currentFilter.kind !== 'none') {
      client.setFilter(currentStation, {
        kind: currentFilter.kind,
        low:  currentFilter.low,
        high: currentFilter.high,
      });
    }
    if (currentUnits !== 'counts') client.setUnits(currentStation, currentUnits);
    const subTimer = window.setInterval(() => {
      if (firstFrameAt !== null) { window.clearInterval(subTimer); return; }
      const conn = document.getElementById('conn');
      if (conn) {
        const elapsed = ((Date.now() - subAt) / 1000).toFixed(0);
        conn.textContent = `connected · waiting for first sample (${elapsed}s)`;
      }
    }, 1000);
    window.setTimeout(() => window.clearInterval(subTimer), 60_000);
    historyView.refresh(); // if History mode is open, re-fetch new station
  }

  const worldMap = mountWorldMap(mapHost, {
    onEventPicked(e) { pickEvent(e); },
    onStationPicked(nslc) { switchStation(nslc); },
  });
  worldMap.setActiveStation(currentStation);

  const eventList = mountEventList(sidebarHost, {
    onPick(e) { pickEvent(e); },
    onEvents(events) {
      currentEvents = events;
      worldMap.setEvents(events);
      refreshDrumOverlays();
    },
  });

  // ── Topbar controls ─────────────────────────────────────────────────
  const pickerMount = document.getElementById('picker-mount')!;
  const picker = mountStationPicker(pickerMount, currentStation, switchStation);

  const filterMount = document.getElementById('filter-mount')!;
  function applyFilter(spec: FilterSpec): void {
    currentFilter = spec;
    client.setFilter(currentStation, {
      kind: spec.kind,
      low:  spec.low,
      high: spec.high,
    });
    historyView.refresh();
    if (currentMode === 'event') recordSection.refreshFilter();
  }
  const filterPicker = mountFilterPicker(filterMount, currentFilter, applyFilter);

  const unitsMount = document.getElementById('units-mount')!;
  function applyUnits(units: string): void {
    currentUnits = units;
    client.setUnits(currentStation, units);
    historyView.refresh();
    if (currentMode === 'event') recordSection.refreshAnalysis();
  }
  const unitsPicker = mountUnitsPicker(unitsMount, currentUnits, applyUnits);

  const alertMount = document.getElementById('alert-picker-mount')!;
  mountAlertPicker(alertMount, () => resubscribe());

  modeSelect.addEventListener('change', () => {
    if (modeSelect.value === 'history') showHistory();
    else if (modeSelect.value === 'live') { historyView.hide(); pickEvent(null); }
    // 'event' is only selectable while already in event mode — no-op.
  });
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);
  document.getElementById('help-btn')?.addEventListener('click', () => openHelp());
  document.getElementById('about-btn')?.addEventListener('click', openAbout);

  initTooltips();

  // Live UTC clock in the topbar.
  const clockEl = document.getElementById('utc-clock');
  if (clockEl) {
    const p = (n: number) => String(n).padStart(2, '0');
    const tick = () => {
      const d = new Date();
      clockEl.textContent =
        `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
        `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    };
    tick();
    setInterval(tick, 1000);
  }

  // ── Session-scoped AI terminal ─────────────────────────────────────
  const FILTER_IDS = [
    'raw', 'dc-removed', 'local-quake', 'regional', 'teleseismic-body',
    'microseism', 'surface-waves', 'slow-signal',
  ] as const;
  function applyAiInstruction(instruction: AiInstruction): string {
    const value = instruction.value || '';
    if (instruction.type === 'select-station') {
      const available = new Set([...STATION_PRESETS.map((station) => station.nslc), currentStation]);
      if (!available.has(value)) return `AI action rejected: station ${value || '(missing)'} is not in this session.`;
      switchStation(value);
      return `Selected station ${value}.`;
    }
    if (instruction.type === 'select-event') {
      const event = currentEvents.find((candidate) => candidate.id === value);
      if (!event) return `AI action rejected: event ${value || '(missing)'} is not in this session.`;
      pickEvent(event);
      return `Opened event ${value}.`;
    }
    if (instruction.type === 'set-filter') {
      const index = FILTER_IDS.indexOf(value as typeof FILTER_IDS[number]);
      const filter = FILTER_PRESETS[index];
      if (!filter) return `AI action rejected: unknown filter ${value || '(missing)'}.`;
      filterPicker.setFilter(filter); applyFilter(filter);
      return `Applied ${filter.label}.`;
    }
    if (instruction.type === 'set-units') {
      if (!UNIT_OPTIONS.some((option) => option.value === value)) {
        return `AI action rejected: unknown units ${value || '(missing)'}.`;
      }
      unitsPicker.setUnits(value); applyUnits(value);
      return `Changed units to ${value}.`;
    }
    if (instruction.type === 'set-mode') {
      if (value === 'live') pickEvent(null);
      else if (value === 'history') showHistory();
      else if (value === 'event' && currentEventId) showEvent();
      else return `AI action rejected: mode ${value || '(missing)'} is unavailable in this session.`;
      return `Changed to ${value} mode.`;
    }
    return 'AI action rejected: unsupported instruction.';
  }

  mountAiTerminal(centerPane, {
    getSessionSnapshot: () => {
      const plots = currentMode === 'event'
        ? recordSection.aiSnapshot()
        : currentMode === 'history'
          ? historyView.aiSnapshot()
          : { visiblePlots: activePanels, plotFrames: dashboard.snapshotFrames() };
      return {
        mode: currentMode,
        selectedStation: currentStation,
        selectedEvent: currentEvents.find((event) => event.id === currentEventId) || null,
        availableEvents: currentEvents,
        availableStations: [
          ...STATION_PRESETS.map((station) => ({ nslc: station.nslc, lat: station.lat, lon: station.lon })),
          ...(STATION_PRESETS.some((station) => station.nslc === currentStation) || !stationCoords.has(currentStation)
            ? []
            : [{ nslc: currentStation, ...stationCoords.get(currentStation)! }]),
        ],
        visiblePlots: plots.visiblePlots,
        filter: currentFilter,
        units: currentUnits,
        plotFrames: plots.plotFrames,
      };
    },
    applyInstruction: applyAiInstruction,
  });


  // Initial overlay + subscription. mountDashboard didn't fire
  // onActiveChanged during construction (would TDZ-crash on `client`),
  // so subscribe explicitly now that both exist.
  refreshDrumOverlays();
  void ensureStationCoords(currentStation);
  clientReady = true;
  client.subscribe(currentStation, subscribedPanels());
}

/** Collapsible event rail. Keeping a narrow visible handle makes reopening it
 * discoverable without stealing useful map space. */
function mountSidebarCollapse(pane: HTMLElement, toggle: HTMLButtonElement): void {
  const KEY = 'tremiom-events-collapsed';
  let collapsed = localStorage.getItem(KEY) === 'true';
  const render = () => {
    pane.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '›' : '‹';
    toggle.title = collapsed ? 'Expand events' : 'Collapse events';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    localStorage.setItem(KEY, String(collapsed));
  };
  toggle.addEventListener('click', () => { collapsed = !collapsed; render(); });
  render();
}

/** Vertical divider between the central map and the one-column plot
 * inspector. Width is persisted because plot readability is task-specific. */
function mountPlotWidthSplitter(splitter: HTMLElement, plotsPane: HTMLElement): void {
  const KEY = 'tremiom-plots-width';
  const MIN_W = 300;
  const maxWidth = () => Math.max(MIN_W, window.innerWidth - 360);
  let resizeFrame = 0;
  const setWidth = (requested: number) => {
    const width = Math.round(Math.max(MIN_W, Math.min(maxWidth(), requested)));
    document.documentElement.style.setProperty('--plots-w', `${width}px`);
    splitter.setAttribute('aria-valuemin', String(MIN_W));
    splitter.setAttribute('aria-valuemax', String(maxWidth()));
    splitter.setAttribute('aria-valuenow', String(width));
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => window.dispatchEvent(new Event('tremiom:plots-resized')));
    return width;
  };
  const saved = Number(localStorage.getItem(KEY));
  setWidth(Number.isFinite(saved) && saved >= MIN_W ? saved : plotsPane.getBoundingClientRect().width || 440);
  let dragging = false, startX = 0, startW = 0;

  splitter.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = plotsPane.getBoundingClientRect().width;
    splitter.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setWidth(startW + (startX - e.clientX));
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    try { splitter.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    const width = plotsPane.getBoundingClientRect().width;
    localStorage.setItem(KEY, String(Math.round(width)));
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('keydown', (event) => {
    let width = plotsPane.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') width += 24;
    else if (event.key === 'ArrowRight') width -= 24;
    else if (event.key === 'Home') width = MIN_W;
    else if (event.key === 'End') width = maxWidth();
    else return;
    localStorage.setItem(KEY, String(setWidth(width)));
    event.preventDefault();
  });
  window.addEventListener('resize', () => setWidth(plotsPane.getBoundingClientRect().width));
}

/** Always-visible plots scrollbar. macOS hides native overlay scrollbars even
 * when CSS requests a gutter, so use a synchronized rail that is also
 * draggable and clickable. */
function mountPlotScrollbar(viewport: HTMLElement, rail: HTMLElement): void {
  const thumb = rail.querySelector('.plot-scroll-thumb') as HTMLElement;
  let thumbHeight = 28;
  let updateFrame = 0;

  const update = () => {
    updateFrame = 0;
    const visible = viewport.clientHeight;
    const total = viewport.scrollHeight;
    const track = rail.clientHeight;
    const scrollable = total > visible + 1 && track > 0;
    rail.classList.toggle('inactive', !scrollable);
    rail.setAttribute('aria-disabled', String(!scrollable));
    if (!scrollable) {
      thumb.style.height = `${track}px`;
      thumb.style.transform = 'translateY(0)';
      return;
    }
    thumbHeight = Math.max(28, Math.round(track * visible / total));
    const travel = Math.max(0, track - thumbHeight);
    const progress = viewport.scrollTop / Math.max(1, total - visible);
    rail.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${Math.round(travel * progress)}px)`;
  };
  const scheduleUpdate = () => {
    if (!updateFrame) updateFrame = requestAnimationFrame(update);
  };

  viewport.addEventListener('scroll', scheduleUpdate, { passive: true });
  new ResizeObserver(scheduleUpdate).observe(viewport);
  new MutationObserver(scheduleUpdate).observe(viewport, { childList: true, subtree: true });
  window.addEventListener('resize', scheduleUpdate);

  let dragging = false, startY = 0, startScroll = 0;
  thumb.addEventListener('pointerdown', (event) => {
    if (rail.classList.contains('inactive')) return;
    dragging = true;
    startY = event.clientY;
    startScroll = viewport.scrollTop;
    thumb.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  thumb.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const travel = Math.max(1, rail.clientHeight - thumbHeight);
    const scrollRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = startScroll + (event.clientY - startY) * scrollRange / travel;
  });
  const stopDragging = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { thumb.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
  };
  thumb.addEventListener('pointerup', stopDragging);
  thumb.addEventListener('pointercancel', stopDragging);
  rail.addEventListener('pointerdown', (event) => {
    if (event.target === thumb || rail.classList.contains('inactive')) return;
    const rect = rail.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
    viewport.scrollTop = ratio * Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  });

  rail.addEventListener('keydown', (event) => {
    const page = Math.max(80, Math.round(viewport.clientHeight * 0.85));
    if (event.key === 'ArrowDown') viewport.scrollBy({ top: 48 });
    else if (event.key === 'ArrowUp') viewport.scrollBy({ top: -48 });
    else if (event.key === 'PageDown') viewport.scrollBy({ top: page });
    else if (event.key === 'PageUp') viewport.scrollBy({ top: -page });
    else if (event.key === 'Home') viewport.scrollTo({ top: 0 });
    else if (event.key === 'End') viewport.scrollTo({ top: viewport.scrollHeight });
    else return;
    event.preventDefault();
  });
  scheduleUpdate();
}
