// Tremiom multiplexer.
//
// Roles:
//   1. Serve the built static client (production only — `vite` handles dev).
//   2. Maintain WebSocket connections to browsers at /ws/main.
//   3. Spawn Python workers (workers/ingestor.py, workers/panels.py) and
//      pipe their NDJSON output to the right WebSocket subscribers.
//   4. Proxy REST catalog calls (USGS, EMSC) under /api/* — TODO.
//
// Protocol (browser ↔ server):
//   client → server  NDJSON  { op: 'subscribe', station, panels }
//                            { op: 'unsubscribe', station }
//   server → client  NDJSON  { frame: 'panel', station, panel, t, data, ... }
//                    binary  (length-prefixed waveform ticks — TBD)

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer, WebSocket as WS } from 'ws';

const PORT = +(process.env.PORT || 8080);
const DIST = resolve(new URL('./dist', import.meta.url).pathname);
const PYTHON = process.env.TREMIOM_PYTHON || resolve('workers/.venv/bin/python');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// ─── Static server (production only; in dev, Vite serves and proxies WS) ──
function serveStatic(req, res) {
  try {
    const url = (req.url || '/').split('?')[0];
    const path = url === '/' ? '/index.html' : url;
    const full = join(DIST, path);
    if (!full.startsWith(DIST)) { res.writeHead(403).end(); return; }
    const st = statSync(full);
    if (!st.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
    createReadStream(full).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
}

// ─── USGS event feed proxy + cache ────────────────────────────────────────
// USGS publishes static GeoJSON summaries that update at most once per
// minute. We cache each feed in memory for 60 s so a sidebar full of
// clients hits USGS only once per minute total.
const USGS_FEEDS = new Set([
  'significant_hour', '4.5_hour', '2.5_hour', '1.0_hour', 'all_hour',
  'significant_day', '4.5_day', '2.5_day', '1.0_day', 'all_day',
  'significant_week', '4.5_week', '2.5_week', '1.0_week', 'all_week',
  'significant_month', '4.5_month', '2.5_month', 'all_month',
]);
const usgsCache = new Map(); // feed -> { ts: number, body: string }
const USGS_TTL_MS = 60_000;

async function handleUsgs(req, res) {
  const url = new URL(req.url, 'http://x');
  const feed = url.searchParams.get('feed') || 'M2.5_day';
  if (!USGS_FEEDS.has(feed)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown feed', feed }));
    return;
  }
  const now = Date.now();
  const cached = usgsCache.get(feed);
  if (cached && (now - cached.ts) < USGS_TTL_MS) {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30',
      'x-cache': 'HIT',
    });
    res.end(cached.body);
    return;
  }
  try {
    const upstream = await fetch(
      `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`,
      { headers: { 'user-agent': 'tremiom (https://github.com/andrepaquette/tremiom)' } }
    );
    const body = await upstream.text();
    // USGS sometimes returns "200 OK + text/plain + body '404 File Not
    // Found'" for non-existent feeds. Reject anything that isn't a JSON
    // response so we never cache that.
    const ct = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !ct.includes('json')) {
      res.writeHead(upstream.ok ? 502 : upstream.status, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({
        error: 'upstream not json',
        status: upstream.status,
        contentType: ct,
        bodySnippet: body.slice(0, 80),
      }));
      return;
    }
    usgsCache.set(feed, { ts: now, body });
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30',
      'x-cache': 'MISS',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fetch failed', detail: String(e?.message || e) }));
  }
}

// ─── Event waveform fetch (FDSN + TauP via Python) ─────────────────────────
// POST /api/event/waveforms  body: {eventId, lat, lon, depthKm, timeMs, ...}
// Spawns workers/event_fetch.py one-shot. Cached briefly by eventId so
// reloading or re-clicking the same event doesn't refetch from IRIS.

const eventCache = new Map(); // eventId -> { ts, body }
const EVENT_TTL_MS = 5 * 60_000;
const EVENT_TIMEOUT_MS = 90_000;

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; if (data.length > 64_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleEventFetch(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(); return;
  }
  let body;
  try { body = await readBody(req); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad body' })); return;
  }
  let payload;
  try { payload = JSON.parse(body); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad json' })); return;
  }
  const eventId = payload.eventId || '';
  if (eventId && eventCache.has(eventId)) {
    const c = eventCache.get(eventId);
    if (Date.now() - c.ts < EVENT_TTL_MS) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'HIT' });
      res.end(c.body); return;
    }
  }
  // Spawn the Python one-shot.
  const proc = spawn(PYTHON, ['workers/event_fetch.py'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let stdout = '';
  const timer = setTimeout(() => proc.kill('SIGTERM'), EVENT_TIMEOUT_MS);
  proc.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  proc.on('exit', (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'event_fetch failed', code }));
      return;
    }
    if (eventId) eventCache.set(eventId, { ts: Date.now(), body: stdout });
    res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'MISS' });
    res.end(stdout);
  });
  proc.stdin.write(body);
  proc.stdin.end();
}

const httpServer = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/events')) {
    handleUsgs(req, res);
    return;
  }
  if (req.url?.startsWith('/api/event/waveforms')) {
    handleEventFetch(req, res);
    return;
  }
  if (req.url?.startsWith('/api/')) {
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not implemented' }));
    return;
  }
  serveStatic(req, res);
});

// ─── Python worker ─────────────────────────────────────────────────────────
// ONE worker process owns the SeedLink connection, the ring buffer, and all
// panel computations. Spawning a process per panel-kind would mean N
// parallel SeedLink connections to IRIS — bad citizen. The worker speaks
// NDJSON: stdin = subscribe/unsubscribe, stdout = panel frames.

const subscribers = new Map(); // ws -> { stations: Set, panels: Set }
let worker = null;
const WORKER_ARGS = process.env.TREMIOM_SYNTHETIC === '1'
  ? ['workers/worker.py', '--synthetic']
  : ['workers/worker.py'];

function dispatchPanelFrame(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.frame !== 'panel') return;
  for (const [ws, sub] of subscribers) {
    if (ws.readyState !== WS.OPEN) continue;
    if (sub.stations.has(msg.station) && sub.panels.has(msg.panel)) {
      ws.send(line);
    }
  }
}

function spawnWorker() {
  const proc = spawn(PYTHON, WORKER_ARGS, { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) dispatchPanelFrame(line);
    }
  });
  proc.on('exit', (code) => {
    console.log(`[worker] exited ${code} — restarting in 2s`);
    worker = null;
    setTimeout(() => { worker = spawnWorker(); resubscribeAll(); }, 2000);
  });
  console.log(`[worker] spawned (${WORKER_ARGS.join(' ')})`);
  return proc;
}

function tellWorker(msg) {
  if (!worker) return;
  try { worker.stdin.write(JSON.stringify(msg) + '\n'); } catch {}
}

function resubscribeAll() {
  // After a worker restart, replay every client's subscriptions so the
  // ring buffer + SeedLink streams come back without the browser needing
  // to know anything.
  const seen = new Map(); // station -> Set<panel>
  for (const sub of subscribers.values()) {
    for (const st of sub.stations) {
      const merged = seen.get(st) ?? new Set();
      for (const p of sub.panels) merged.add(p);
      seen.set(st, merged);
    }
  }
  for (const [station, panels] of seen) {
    tellWorker({ op: 'subscribe', station, panels: [...panels] });
  }
}

// ─── WebSocket server ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws/main')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  subscribers.set(ws, { stations: new Set(), panels: new Set() });
  console.log(`[ws] +client (${subscribers.size} total)`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    const sub = subscribers.get(ws);
    if (!sub) return;
    if (msg.op === 'subscribe') {
      sub.stations.add(msg.station);
      for (const p of msg.panels || []) sub.panels.add(p);
      tellWorker({ op: 'subscribe', station: msg.station,
                   panels: msg.panels || [...sub.panels] });
    } else if (msg.op === 'unsubscribe') {
      sub.stations.delete(msg.station);
      tellWorker({ op: 'unsubscribe', station: msg.station });
    }
  });

  ws.on('close', () => {
    subscribers.delete(ws);
    console.log(`[ws] -client (${subscribers.size} total)`);
  });
});

// Spawn the unified Python worker before we start accepting clients so its
// SeedLink connection has a head start.
worker = spawnWorker();

httpServer.listen(PORT, () => {
  console.log(`tremiom server on :${PORT}`);
});
