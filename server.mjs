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

const httpServer = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    // TODO: USGS / EMSC proxy + cache.
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not implemented' }));
    return;
  }
  serveStatic(req, res);
});

// ─── Python worker pool ────────────────────────────────────────────────────
// One ingestor (SeedLink) shared by everyone. Panel-computer workers per
// panel kind, spawned lazily on first subscription. Each speaks NDJSON
// over stdout; the multiplexer dispatches by frame's `panel` field.

const subscribers = new Map(); // ws -> { stations: Set, panels: Set }
const panelWorkers = new Map(); // panelId -> child process

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

function spawnPanelWorker(panelId) {
  if (panelWorkers.has(panelId)) return panelWorkers.get(panelId);
  const proc = spawn(PYTHON, ['workers/panels.py', '--panel', panelId], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
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
    console.log(`[worker:${panelId}] exited ${code}`);
    panelWorkers.delete(panelId);
  });
  panelWorkers.set(panelId, proc);
  console.log(`[worker:${panelId}] spawned`);
  return proc;
}

function tellWorker(panelId, msg) {
  const proc = spawnPanelWorker(panelId);
  proc.stdin.write(JSON.stringify(msg) + '\n');
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
      for (const p of msg.panels || []) {
        sub.panels.add(p);
        tellWorker(p, { op: 'subscribe', station: msg.station });
      }
    } else if (msg.op === 'unsubscribe') {
      sub.stations.delete(msg.station);
      for (const p of sub.panels) {
        tellWorker(p, { op: 'unsubscribe', station: msg.station });
      }
    }
  });

  ws.on('close', () => {
    subscribers.delete(ws);
    console.log(`[ws] -client (${subscribers.size} total)`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`tremiom server on :${PORT}`);
});
