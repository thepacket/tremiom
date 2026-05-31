import {
  type SeismicEvent, type UsgsFeed,
  USGS_FEEDS, DEFAULT_FEED,
  magColor, ago,
} from '../data/events';
import { EventFeedPoller } from '../transport/events';

/** Sidebar event list. Polls USGS via /api/events on a 60 s timer and
 *  re-renders the list. The "ago" labels also re-render every 30 s so
 *  they don't go stale between polls. */
export function mountEventList(
  parent: HTMLElement,
  onPick: (event: SeismicEvent) => void,
): { destroy(): void } {
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
      return `
        <li class="event" data-id="${e.id}">
          <span class="mag" style="background:${c}">${m}</span>
          <span class="meta">
            <span class="place">${escapeHtml(e.place)}</span>
            <span class="muted small">
              ${ago(e.timeMs, now)} · ${e.depthKm.toFixed(0)} km depth
              ${e.tsunami ? ' · ⚠ tsunami' : ''}
              ${e.alert ? ` · alert ${e.alert}` : ''}
            </span>
          </span>
        </li>`;
    }).join('');
  }

  listEl.addEventListener('click', (ev) => {
    const li = (ev.target as HTMLElement).closest('.event') as HTMLElement | null;
    if (!li) return;
    const id = li.dataset.id;
    const e = events.find((x) => x.id === id);
    if (e) onPick(e);
  });

  const poller = new EventFeedPoller({
    feed: DEFAULT_FEED,
    onUpdate(next) {
      // USGS GeoJSON ordering varies; sort by time desc so newest is on top.
      events = [...next].sort((a, b) => b.timeMs - a.timeMs);
      render();
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
