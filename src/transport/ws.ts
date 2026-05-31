/** Thin WebSocket client. Speaks NDJSON to the Node multiplexer.
 *  Reconnects with exponential backoff. Backpressure is not handled yet
 *  — the v0.1 server keeps frame rate low enough that it doesn't matter. */

export interface ClientHandlers {
  onStatus(s: string): void;
  onPanelFrame(panelId: string, frame: unknown): void;
}

export class TremiomClient {
  private ws: WebSocket | null = null;
  private backoffMs = 500;
  private pending: object[] = [];

  constructor(private h: ClientHandlers) {
    this.connect();
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/main`;
    this.h.onStatus('connecting…');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.h.onStatus('connected');
      this.backoffMs = 500;
      for (const m of this.pending) ws.send(JSON.stringify(m));
      this.pending.length = 0;
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // binary frames TBD
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.frame === 'panel' && typeof msg.panel === 'string') {
        this.h.onPanelFrame(msg.panel, msg);
      }
    };

    ws.onclose = () => {
      this.h.onStatus(`disconnected — retry in ${(this.backoffMs / 1000).toFixed(1)}s`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    };

    ws.onerror = () => { /* close handler retries */ };
  }

  private send(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.pending.push(msg);
    }
  }

  subscribe(station: string, panels: string[]): void {
    this.send({ op: 'subscribe', station, panels });
  }

  unsubscribe(station: string): void {
    this.send({ op: 'unsubscribe', station });
  }
}
