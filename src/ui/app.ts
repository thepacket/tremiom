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
import { mountDashboard, type DashboardHandle } from './dashboard';
import { mountDashboardBar } from './dashboard-bar';
import { mountPanelPicker } from './panel-picker';
import { mountAlertPicker } from './alert-picker';
import { alerts } from './alerts';
import { feedNetwork, resetNetwork, networkGroup } from '../panels/network';
import { pinTrace } from '../panels/clipboard';
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
      <span class="muted">station:</span>
      <span id="picker-mount"></span>
      <span class="muted">filter:</span>
      <span id="filter-mount"></span>
      <span class="muted">units:</span>
      <span id="units-mount"></span>
      <span class="topbar-spacer"></span>
      <span class="muted" id="conn">connecting…</span>
      <button class="settings-btn" id="help-btn" title="Help" aria-label="Help">?</button>
      <button class="settings-btn" id="settings-btn" title="Settings" aria-label="Settings">⚙</button>
    </div>
    <div class="topbar-row">
      <span id="panel-picker-mount"></span>
      <span id="dashboard-bar-mount"></span>
      <button class="pin-btn" id="pin-btn" title="Pin current trace to the Wave clipboard">📌 Pin</button>
      <span id="alert-picker-mount"></span>
      <span class="topbar-spacer"></span>
      <button class="hist-btn" id="hist-btn" title="Browse arbitrary time windows">🕓 History</button>
      <button class="live-btn hidden" id="live-btn" title="Return to live mode">← Live</button>
    </div>
  `;
  root.appendChild(topbar);

  // ── World map (full width, between topbar and body) ─────────────────
  const mapHost = document.createElement('div');
  mapHost.className = 'map-host';
  root.appendChild(mapHost);

  // ── Body (sidebar + dashboard) ──────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'body';
  root.appendChild(body);

  // ── State ───────────────────────────────────────────────────────────
  let currentStation = DEFAULT_STATION;
  let currentEventId: string | null = null;
  let firstFrameAt: number | null = null;
  const subscribedAt = Date.now();
  let currentFilter: FilterSpec = DEFAULT_FILTER;
  let currentUnits: string = DEFAULT_UNITS;
  let latestRawScope: { windowS?: number; unit?: string; data: number[] } | null = null;

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

  // ── Sidebar ─────────────────────────────────────────────────────────
  const sidebarHost = document.createElement('div');
  sidebarHost.className = 'sidebar-host';
  body.appendChild(sidebarHost);

  // ── Main area: dashboard (live mode) ⇄ record-section (event mode) ─
  const mainArea = document.createElement('div');
  mainArea.className = 'main-area';
  body.appendChild(mainArea);

  // Live mode container — the gridstack dashboard mounts inside.
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
    // Clipboard pins raw-scope snapshots, so keep that stream live while
    // the clipboard panel is mounted even if raw-scope isn't displayed.
    if (activePanels.includes('clipboard')) set.add('raw-scope');
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
  const dashboard: DashboardHandle = mountDashboard(dashHost, {
    onActiveChanged,
    stationName: () => currentStation,
  });
  activePanels = dashboard.activePanels();

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
      // Remember the latest raw-scope frame so the Pin button can
      // snapshot it into the wave clipboard.
      if (panelId === 'raw-scope') {
        latestRawScope = frame as { windowS?: number; unit?: string; data: number[] };
      }
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

  // ── Live / Event mode switch ────────────────────────────────────────
  function showLive() {
    dashHost.classList.remove('hidden');
    eventHost.classList.add('hidden');
    historyHost.classList.add('hidden');
    historyView.hide();
    document.getElementById('live-btn')?.classList.add('hidden');
    document.getElementById('hist-btn')?.classList.remove('hidden');
  }
  function showEvent() {
    dashHost.classList.add('hidden');
    eventHost.classList.remove('hidden');
    historyHost.classList.add('hidden');
    historyView.hide();
    document.getElementById('live-btn')?.classList.remove('hidden');
    document.getElementById('hist-btn')?.classList.remove('hidden');
  }
  function showHistory() {
    dashHost.classList.add('hidden');
    eventHost.classList.add('hidden');
    historyHost.classList.remove('hidden');
    historyView.show();
    document.getElementById('live-btn')?.classList.remove('hidden');
    document.getElementById('hist-btn')?.classList.add('hidden');
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

  const panelPickerMount = document.getElementById('panel-picker-mount')!;
  mountPanelPicker(panelPickerMount, {
    isActive: (id) => activePanels.includes(id),
    onAdd:    (id) => dashboard.addPanel(id),
    onRemove: (id) => dashboard.removePanel(id),
    onReset:  () => dashboard.resetLayout(),
  });

  const dashBarMount = document.getElementById('dashboard-bar-mount')!;
  mountDashboardBar(dashBarMount, dashboard);

  const alertMount = document.getElementById('alert-picker-mount')!;
  mountAlertPicker(alertMount, () => resubscribe());

  document.getElementById('hist-btn')?.addEventListener('click', () => showHistory());
  document.getElementById('live-btn')?.addEventListener('click', () => {
    historyView.hide();
    pickEvent(null);
  });
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);
  document.getElementById('help-btn')?.addEventListener('click', () => openHelp());

  document.getElementById('pin-btn')?.addEventListener('click', () => {
    if (!latestRawScope?.data?.length) return;
    pinTrace({
      station: currentStation,
      capturedMs: Date.now(),
      windowS: latestRawScope.windowS ?? 10,
      unit: latestRawScope.unit ?? 'counts',
      data: latestRawScope.data.slice(),
    });
    // If the clipboard panel is up, nudge it to redraw immediately.
    dashboard.setFrame('clipboard', {});
  });

  // Initial overlay + subscription. mountDashboard didn't fire
  // onActiveChanged during construction (would TDZ-crash on `client`),
  // so subscribe explicitly now that both exist.
  refreshDrumOverlays();
  void ensureStationCoords(currentStation);
  clientReady = true;
  client.subscribe(currentStation, subscribedPanels());
}
