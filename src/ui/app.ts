import { panelRegistry } from '../panels/registry';
import { resetSpectrogram } from '../panels/spectrogram';
import { TremiomClient } from '../transport/ws';
import { DEFAULT_STATION } from '../data/stations';
import { mountStationPicker } from './station-picker';
import { mountEventList } from './event-list';
import { mountWorldMap } from './world-map';
import { mountRecordSection } from './record-section';
import { openSettings } from './settings';
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
    <button class="settings-btn" id="settings-btn" title="Settings" aria-label="Settings">⚙</button>
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
  let firstFrameAt: number | null = null;
  const subscribedAt = Date.now();

  const client = new TremiomClient({
    onStatus(s) {
      const el = document.getElementById('conn');
      if (!el) return;
      // Decorate with first-frame status so the user knows the
      // expected ~10-20 s SeedLink handshake is in progress.
      if (firstFrameAt === null && s === 'connected') {
        const elapsed = ((Date.now() - subscribedAt) / 1000).toFixed(0);
        el.textContent = `connected · waiting for first sample (${elapsed}s)`;
      } else {
        el.textContent = s;
      }
    },
    onPanelFrame(panelId, frame) {
      if ((frame as { station?: string }).station !== currentStation) return;
      if (firstFrameAt === null) {
        firstFrameAt = Date.now();
        const el = document.getElementById('conn');
        if (el) {
          const latency = ((firstFrameAt - subscribedAt) / 1000).toFixed(1);
          el.textContent = `live · first frame at +${latency}s`;
        }
      }
      renderers.get(panelId)?.draw(frame);
    },
  });

  // Refresh the "waiting for first sample" counter once a second.
  const connTicker = window.setInterval(() => {
    if (firstFrameAt !== null) return;
    const el = document.getElementById('conn');
    if (el && el.textContent?.startsWith('connected · waiting')) {
      const elapsed = ((Date.now() - subscribedAt) / 1000).toFixed(0);
      el.textContent = `connected · waiting for first sample (${elapsed}s)`;
    }
  }, 1000);
  // Stop the ticker once we have a frame.
  window.setTimeout(() => {
    if (firstFrameAt !== null) window.clearInterval(connTicker);
  }, 60_000);

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
    firstFrameAt = null;
    const subAt = Date.now();
    // Re-show the "waiting for first sample" status for the new station.
    const el = document.getElementById('conn');
    if (el) el.textContent = `connected · waiting for first sample (0s)`;
    worldMap.setActiveStation(next);
    picker.setStation(next);
    client.subscribe(currentStation, INITIAL_PANELS);
    // Local first-frame timer for the new station.
    const subTimer = window.setInterval(() => {
      if (firstFrameAt !== null) { window.clearInterval(subTimer); return; }
      const conn = document.getElementById('conn');
      if (conn) {
        const elapsed = ((Date.now() - subAt) / 1000).toFixed(0);
        conn.textContent = `connected · waiting for first sample (${elapsed}s)`;
      }
    }, 1000);
    window.setTimeout(() => window.clearInterval(subTimer), 60_000);
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

  // Settings gear → modal with auth state + sign-out + token field.
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);

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
