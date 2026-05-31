import {
  type SeismicEvent, type UsgsFeed,
  USGS_FEEDS, DEFAULT_FEED,
  magColor, ago, mmiRoman, intensityColor,
} from '../data/events';
import { EventFeedPoller } from '../transport/events';

interface EventListHandlers {
  onPick(event: SeismicEvent): void;
  /** Optional: called whenever a new feed snapshot arrives, so the
   *  caller can sync map markers without polling USGS twice. */
  onEvents?(events: SeismicEvent[]): void;
}

export interface EventListHandle {
  setSelectedEvent(id: string | null): void;
  destroy(): void;
}

/** Sidebar event list. Polls USGS via /api/events on a 60 s timer and
 *  re-renders the list. The "ago" labels also re-render every 30 s so
 *  they don't go stale between polls. */
export function mountEventList(
  parent: HTMLElement,
  handlers: EventListHandlers,
): EventListHandle {
  const root = document.createElement('aside');
  root.className = 'sidebar';
  root.innerHTML = `
    <header>
      <span>events</span>
      <select class="feed-select" title="USGS feed">
        ${USGS_FEEDS.map((f) =>
          `<option value="${f}"${f === DEFAULT_FEED ? ' selected' : ''}>${f}</option>`
        ).join('')}
      </select>
    </header>
    <div class="status muted">loading…</div>
    <ul class="event-list"></ul>
  `;
  parent.appendChild(root);

  const select  = root.querySelector('.feed-select') as HTMLSelectElement;
  const status  = root.querySelector('.status') as HTMLElement;
  const listEl  = root.querySelector('.event-list') as HTMLUListElement;

  let events: SeismicEvent[] = [];
  let selectedId: string | null = null;

  function render() {
    if (!events.length) {
      listEl.innerHTML = '';
      status.textContent = 'no events';
      return;
    }
    status.textContent = `${events.length} events`;
    const now = Date.now();
    listEl.innerHTML = events.map((e) => {
      const m = e.mag == null ? '—' : e.mag.toFixed(1);
      const c = magColor(e.mag);
      const sel = e.id === selectedId ? ' selected' : '';
      // Felt-report badge: community intensity (CDI) preferred, else
      // instrumental (MMI). Shown as a roman-numeral chip, ShakeMap
      // colored. Plus the raw felt-report count when present.
      const intensity = e.cdi ?? e.mmi;
      const roman = mmiRoman(intensity);
      const feltChip = roman
        ? `<span class="felt-chip" style="background:${intensityColor(intensity)}" title="Max intensity ${roman}${e.felt ? ` · ${e.felt} felt reports` : ''}">${roman}</span>`
        : '';
      const feltText = e.felt ? ` · felt ×${e.felt}` : '';
      return `
        <li class="event${sel}" data-id="${e.id}">
          <span class="mag" style="background:${c}">${m}</span>
          <span class="meta">
            <span class="place">${escapeHtml(e.place)}${feltChip}</span>
            <span class="muted small">
              ${ago(e.timeMs, now)} · ${e.depthKm.toFixed(0)} km depth
              ${feltText}
              ${e.tsunami ? ' · ⚠ tsunami' : ''}
              ${e.alert ? ` · alert ${e.alert}` : ''}
            </span>
          </span>
        </li>`;
    }).join('');
    // Scroll the selected row into view if it isn't visible.
    if (selectedId) {
      const sel = listEl.querySelector('.event.selected');
      if (sel) (sel as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }

  listEl.addEventListener('click', (ev) => {
    const li = (ev.target as HTMLElement).closest('.event') as HTMLElement | null;
    if (!li) return;
    const id = li.dataset.id;
    const e = events.find((x) => x.id === id);
    if (e) handlers.onPick(e);
  });

  const poller = new EventFeedPoller({
    feed: DEFAULT_FEED,
    onUpdate(next) {
      // USGS GeoJSON ordering varies; sort by time desc so newest is on top.
      events = [...next].sort((a, b) => b.timeMs - a.timeMs);
      render();
      handlers.onEvents?.(events);
    },
    onError(err) {
      status.textContent = `fetch failed: ${err.message}`;
    },
  });
  poller.start();

  select.addEventListener('change', () => {
    poller.setFeed(select.value as UsgsFeed);
    status.textContent = 'loading…';
  });

  // Re-render every 30 s so "ago" labels stay accurate between polls.
  const refresh = window.setInterval(render, 30_000);

  return {
    setSelectedEvent(id) {
      if (id === selectedId) return;
      selectedId = id;
      render();
    },
    destroy() {
      poller.stop();
      window.clearInterval(refresh);
      root.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[ch]);
}
