import {
  parseUsgs, type SeismicEvent, type UsgsFeed,
} from '../data/events';

/** Poll the Node /api/events proxy at a fixed interval. The Node side
 *  caches each USGS feed for 60 s, so polling more frequently is cheap
 *  and the user sees fresh data within ~1 min of USGS publishing it. */
export class EventFeedPoller {
  private timer: number | null = null;
  private feed: UsgsFeed;
  private intervalMs: number;
  private onUpdate: (events: SeismicEvent[]) => void;
  private onError: (err: Error) => void;

  constructor(opts: {
    feed: UsgsFeed;
    intervalMs?: number;
    onUpdate: (events: SeismicEvent[]) => void;
    onError?: (err: Error) => void;
  }) {
    this.feed = opts.feed;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.onUpdate = opts.onUpdate;
    this.onError = opts.onError ?? ((e) => console.warn('[events]', e));
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tick(); // immediate first poll
    this.timer = window.setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  setFeed(feed: UsgsFeed): void {
    if (feed === this.feed) return;
    this.feed = feed;
    void this.tick();
  }

  private async tick(): Promise<void> {
    try {
      const r = await fetch(`/api/events?feed=${encodeURIComponent(this.feed)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      this.onUpdate(parseUsgs(json));
    } catch (e) {
      this.onError(e as Error);
    }
  }
}
