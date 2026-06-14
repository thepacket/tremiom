import { resetSpectrogram } from '../panels/spectrogram';
import { resetDrum, setDrumOverlays } from '../panels/drum';
import { resetRsam } from '../panels/rsam';
import { resetSpectrum } from '../panels/spectrum';
import { TremiomClient } from '../transport/ws';
import { DEFAULT_STATION, STATION_PRESETS } from '../data/stations';
import { mountStationPicker } from './station-picker';
import { mountFilterPicker } from './filter-picker';
import { DEFAULT_FILTER, type FilterSpec } from '../data/filters';
import { mountUnitsPicker, DEFAULT_UNITS } from './units-picker';
import { mountEventList } from './event-list';
import { mountWorldMap } from './world-map';
import { mountRecordSection } from './record-section';
import { mountHistoryView } from './history-view';
import { openSettings } from './settings';
import { openHelp } from './help';
import { openAbout } from './about';
import { initTooltips } from './tooltip';
import { mountDashboard, type DashboardHandle, clampPerRow } from './dashboard';
import { mountAlertPicker } from './alert-picker';
import { alerts } from './alerts';
import { feedNetwork, resetNetwork, networkGroup } from '../panels/network';
import type { SeismicEvent } from '../data/events';

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
      <span class="topbar-label">Panels per row</span>
      <select id="per-row" class="per-row-input" title="Panels per row">
        <option>1</option><option>2</option><option>3</option>
        <option>4</option><option>5</option><option>6</option>
      </select>
      <span class="topbar-label">Height</span>
      <select id="panel-height" class="per-row-input" title="Panel height (px)">
        <option>100</option><option>150</option><option>200</option><option>250</option>
        <option>300</option><option>350</option><option>400</option><option>450</option>
      </select>
      <button class="refresh-btn" id="refresh-btn" title="Redraw all panels with the current settings">Refresh</button>
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
    </div>
  `;
  root.appendChild(topbar);

  // ── Top region: events panel (left) + world map (right) ─────────────
  const topRegion = document.createElement('div');
  topRegion.className = 'top-region';
  root.appendChild(topRegion);

  const sidebarHost = document.createElement('div');
  sidebarHost.className = 'sidebar-host';
  topRegion.appendChild(sidebarHost);

  const mapHost = document.createElement('div');
  mapHost.className = 'map-host';
  topRegion.appendChild(mapHost);

  // Restore a previously dragged map height before first layout.
  const savedMapH = localStorage.getItem('tremiom-map-h');
  if (savedMapH) document.documentElement.style.setProperty('--map-h', savedMapH);

  // ── Map resize splitter (drag to change the map height) ─────────────
  const splitter = document.createElement('div');
  splitter.className = 'map-splitter';
  splitter.title = 'Drag to resize the map';
  root.appendChild(splitter);
  mountMapSplitter(splitter, mapHost);

  // ── Body (sidebar + dashboard) ──────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'body';
  root.appendChild(body);

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
  const recordSection = mountRecordSection(eventHost);

  // History (waveform-browser) mode container.
  const historyHost = document.createElement('div');
  historyHost.className = 'history-host hidden';
  mainArea.appendChild(historyHost);
  const historyView = mountHistoryView(historyHost, {
    station: () => currentStation,
    units: () => currentUnits,
    filter: () => currentFilter,
  });

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
  const PER_ROW_KEY = 'tremiom-panels-per-row';
  const HEIGHT_KEY = 'tremiom-panel-height';
  const HEIGHT_OPTIONS = [100, 150, 200, 250, 300, 350, 400, 450];
  const initialPerRow = clampPerRow(Number(localStorage.getItem(PER_ROW_KEY)) || 2);
  const initialHeight = HEIGHT_OPTIONS.includes(Number(localStorage.getItem(HEIGHT_KEY)))
    ? Number(localStorage.getItem(HEIGHT_KEY)) : 200;
  const dashboard: DashboardHandle = mountDashboard(dashHost, {
    onActiveChanged,
    stationName: () => currentStation,
    perRow: initialPerRow,
    height: initialHeight,
  });
  activePanels = dashboard.activePanels();

  // "Panels per row" controls how many panels appear per grid row.
  const perRowInput = document.getElementById('per-row') as HTMLSelectElement;
  perRowInput.value = String(initialPerRow);
  perRowInput.addEventListener('change', () => {
    const n = clampPerRow(Number(perRowInput.value));
    perRowInput.value = String(n);
    dashboard.setPerRow(n);
    localStorage.setItem(PER_ROW_KEY, String(n));
  });

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
    setModeSelect('live');
  }
  function showEvent() {
    dashHost.classList.add('hidden');
    eventHost.classList.remove('hidden');
    historyHost.classList.add('hidden');
    historyView.hide();
    setModeSelect('event');
  }
  function showHistory() {
    dashHost.classList.add('hidden');
    eventHost.classList.add('hidden');
    historyHost.classList.remove('hidden');
    historyView.show();
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
  mountFilterPicker(filterMount, currentFilter, (spec) => {
    currentFilter = spec;
    client.setFilter(currentStation, {
      kind: spec.kind,
      low:  spec.low,
      high: spec.high,
    });
    historyView.refresh();
  });

  const unitsMount = document.getElementById('units-mount')!;
  mountUnitsPicker(unitsMount, currentUnits, (units) => {
    currentUnits = units;
    client.setUnits(currentStation, units);
    historyView.refresh();
  });

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


  // Initial overlay + subscription. mountDashboard didn't fire
  // onActiveChanged during construction (would TDZ-crash on `client`),
  // so subscribe explicitly now that both exist.
  refreshDrumOverlays();
  void ensureStationCoords(currentStation);
  clientReady = true;
  client.subscribe(currentStation, subscribedPanels());
}

/** Drag-to-resize the map height. Updates the `--map-h` CSS variable (which
 *  drives both the map host and the body offset below it) and persists the
 *  chosen height to localStorage. The map canvas's ResizeObserver redraws. */
function mountMapSplitter(splitter: HTMLElement, mapHost: HTMLElement): void {
  const MIN_H = 120;
  let dragging = false, startY = 0, startH = 0;

  splitter.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = mapHost.getBoundingClientRect().height;
    splitter.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const maxH = window.innerHeight - 160;
    const h = Math.max(MIN_H, Math.min(maxH, startH + (e.clientY - startY)));
    document.documentElement.style.setProperty('--map-h', `${Math.round(h)}px`);
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    try { splitter.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    const h = getComputedStyle(document.documentElement).getPropertyValue('--map-h').trim();
    if (h) localStorage.setItem('tremiom-map-h', h);
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
}
