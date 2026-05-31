import { panelRegistry } from '../panels/registry';
import { resetSpectrogram } from '../panels/spectrogram';
import { TremiomClient } from '../transport/ws';
import { DEFAULT_STATION } from '../data/stations';
import { mountStationPicker } from './station-picker';
import { mountEventList } from './event-list';
import { mountWorldMap } from './world-map';
import { mountRecordSection } from './record-section';
import type { SeismicEvent } from '../data/events';

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
    <button class="live-btn hidden" id="live-btn" title="Return to live mode">← Live</button>
    <span class="muted" id="conn">connecting…</span>
  `;
  root.appendChild(topbar);

  // ── World map (full width, between topbar and body) ─────────────────
  const mapHost = document.createElement('div');
  mapHost.className = 'map-host';
  root.appendChild(mapHost);

  // ── Body (sidebar + grid) ───────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'body';
  root.appendChild(body);

  // ── State + transport ───────────────────────────────────────────────
  let currentStation = DEFAULT_STATION;
  let currentEventId: string | null = null;

  const client = new TremiomClient({
    onStatus(s) {
      const el = document.getElementById('conn');
      if (el) el.textContent = s;
    },
    onPanelFrame(panelId, frame) {
      if ((frame as { station?: string }).station !== currentStation) return;
      renderers.get(panelId)?.draw(frame);
    },
  });

  // ── Sidebar (event list) ────────────────────────────────────────────
  const sidebarHost = document.createElement('div');
  sidebarHost.className = 'sidebar-host';
  body.appendChild(sidebarHost);

  // ── Main area: either live grid OR event record-section ────────────
  const mainArea = document.createElement('div');
  mainArea.className = 'main-area';
  body.appendChild(mainArea);

  // Live mode grid.
  const grid = document.createElement('div');
  grid.className = 'grid';
  mainArea.appendChild(grid);

  // Event mode container (record section).
  const eventHost = document.createElement('div');
  eventHost.className = 'event-host hidden';
  mainArea.appendChild(eventHost);
  const recordSection = mountRecordSection(eventHost);

  const renderers = new Map<string, ReturnType<typeof mountPanel>>();
  for (const id of INITIAL_PANELS) {
    const panel = panelRegistry[id];
    if (!panel) continue;
    renderers.set(id, mountPanel(grid, panel.label, panel));
  }

  function showLive() {
    grid.classList.remove('hidden');
    eventHost.classList.add('hidden');
    const lb = document.getElementById('live-btn');
    if (lb) lb.classList.add('hidden');
  }
  function showEvent() {
    grid.classList.add('hidden');
    eventHost.classList.remove('hidden');
    const lb = document.getElementById('live-btn');
    if (lb) lb.classList.remove('hidden');
  }

  // ── Map + sidebar wired to shared state ─────────────────────────────
  function pickEvent(e: SeismicEvent | null) {
    currentEventId = e?.id ?? null;
    worldMap.setSelectedEvent(currentEventId);
    eventList.setSelectedEvent(currentEventId);
    if (e) {
      showEvent();
      void recordSection.setEvent(e);
    } else {
      showLive();
      void recordSection.setEvent(null);
    }
  }

  function switchStation(next: string) {
    if (next === currentStation) return;
    client.unsubscribe(currentStation);
    resetSpectrogram();
    for (const r of renderers.values()) r.clear();
    currentStation = next;
    worldMap.setActiveStation(next);
    picker.setStation(next);
    client.subscribe(currentStation, INITIAL_PANELS);
  }

  const worldMap = mountWorldMap(mapHost, {
    onEventPicked(e) { pickEvent(e); },
    onStationPicked(nslc) { switchStation(nslc); },
  });
  worldMap.setActiveStation(currentStation);

  const eventList = mountEventList(sidebarHost, {
    onPick(e) { pickEvent(e); },
    onEvents(events) { worldMap.setEvents(events); },
  });

  // ── Station picker ──────────────────────────────────────────────────
  const pickerMount = document.getElementById('picker-mount')!;
  const picker = mountStationPicker(pickerMount, currentStation, switchStation);

  // "← Live" button to leave event mode.
  document.getElementById('live-btn')?.addEventListener('click', () => {
    pickEvent(null);
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
      panel.render(ctx, canvas, null);
    },
  };
}
