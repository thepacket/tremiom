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

// ─── Whole-app token gate ─────────────────────────────────────────────────
// When TREMIOM_TOKEN is set (e.g. `fly secrets set TREMIOM_TOKEN=…`), every
// HTTP and WebSocket request must present a matching cookie. A one-time
// `?token=<value>` URL parameter installs the cookie and redirects to a
// clean URL, so the secret only has to be pasted once. Unset = open,
// matching dev / self-host. Designed for a single-user deployment; no
// rate-limiting or per-user identity beyond "owns the secret".
const TREMIOM_TOKEN = (process.env.TREMIOM_TOKEN || '').trim();
const AUTH_COOKIE = 'tremiom_auth';
const AUTH_COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year
if (!TREMIOM_TOKEN) {
  console.warn('[auth] TREMIOM_TOKEN not set — server is OPEN. Set it to require a token on every request.');
} else {
  console.log('[auth] TREMIOM_TOKEN gate active');
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Constant-time string compare to avoid timing side channels. */
function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function tokenFromUrl(req) {
  try {
    return new URL(req.url || '/', 'http://x').searchParams.get('token') || '';
  } catch { return ''; }
}

function isAuthorized(req) {
  if (!TREMIOM_TOKEN) return true;
  const c = getCookie(req, AUTH_COOKIE);
  if (c && tokenEqual(c, TREMIOM_TOKEN)) return true;
  const q = tokenFromUrl(req);
  return q ? tokenEqual(q, TREMIOM_TOKEN) : false;
}

function clientIp(req) {
  return (
    (req.headers['fly-client-ip'] || '').trim() ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || ''
  );
}

function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').trim() === 'https'
      || req.socket?.encrypted === true;
}

/** Set the auth cookie + 302 to a token-stripped URL. */
function installCookieAndRedirect(req, res) {
  const u = new URL(req.url || '/', 'http://x');
  u.searchParams.delete('token');
  const dest = (u.pathname + (u.search || '')) || '/';
  const flags = [
    `${AUTH_COOKIE}=${encodeURIComponent(TREMIOM_TOKEN)}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${AUTH_COOKIE_MAX_AGE}`,
    'Path=/',
  ];
  if (isHttps(req)) flags.push('Secure');
  res.writeHead(302, {
    'set-cookie': flags.join('; '),
    'location': dest,
    'cache-control': 'no-store',
  });
  res.end();
}

function renderLoginPage({ error = false } = {}) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>tremiom — sign in</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{--bg:#0d0d0d;--fg:#e6e6e6;--muted:#8a8a8a;--accent:#ff8c1a;--panel:#141414;--border:#2a2a2a}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  body{display:grid;place-items:center;padding:24px;box-sizing:border-box}
  main{width:100%;max-width:360px;background:var(--panel);border:1px solid var(--border);
    border-radius:6px;padding:24px}
  h1{color:var(--accent);font-size:18px;margin:0 0 4px;font-weight:600}
  .sub{color:var(--muted);font-size:12px;margin:0 0 18px}
  label{display:block;font-size:11px;color:var(--muted);margin-bottom:6px}
  input[type="password"]{width:100%;background:#0d0d0d;color:var(--fg);
    border:1px solid var(--border);border-radius:3px;padding:8px 10px;
    font:inherit;font-size:13px;box-sizing:border-box;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  input[type="password"]:focus{outline:none;border-color:var(--accent)}
  .err{color:#ff8a80;font-size:11px;margin:8px 0 0;display:${error ? 'block' : 'none'}}
  .row{display:flex;gap:8px;margin-top:14px;align-items:center}
  button{background:var(--accent);color:#111;border:none;border-radius:3px;
    padding:8px 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
  button:hover{filter:brightness(1.1)}
  .help{font-size:11px;color:var(--muted);margin-left:auto}
</style></head><body><main>
<h1>tremiom</h1>
<p class="sub">This instance is private. Enter the access token to continue.</p>
<form method="POST" action="/api/auth/login" autocomplete="on">
  <label for="t">Access token</label>
  <input id="t" type="password" name="token" autofocus required
    autocomplete="current-password" spellcheck="false">
  <p class="err">Incorrect token.</p>
  <div class="row">
    <button type="submit">Sign in</button>
    <span class="help">cookie expires in 1&nbsp;year</span>
  </div>
</form>
</main></body></html>`;
}

function sendUnauthorized(req, res) {
  console.warn(`[auth] 401 ${req.method} ${req.url} ip=${clientIp(req)}`);
  res.writeHead(401, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'www-authenticate': 'Token realm="tremiom"',
  });
  res.end(renderLoginPage({ error: false }));
}

// ─── /api/auth/* — always reachable (you need them to log in/out) ─────────

function authCookieFlags(req, value, maxAge) {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, 'Path=/',
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

async function handleAuthLogin(req, res) {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk.toString('utf8');
      if (body.length > 4096) { res.writeHead(413).end(); return; }
    }
  } catch { res.writeHead(400).end(); return; }
  let submitted = '';
  try {
    const ct = req.headers['content-type'] || '';
    if (ct.startsWith('application/json')) {
      submitted = (JSON.parse(body || '{}').token || '').toString();
    } else {
      submitted = new URLSearchParams(body).get('token') || '';
    }
  } catch {}
  if (!TREMIOM_TOKEN || !tokenEqual(submitted, TREMIOM_TOKEN)) {
    console.warn(`[auth] failed login ip=${clientIp(req)}`);
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(renderLoginPage({ error: true }));
    return;
  }
  // Success.
  res.writeHead(302, {
    'set-cookie': authCookieFlags(req, TREMIOM_TOKEN, AUTH_COOKIE_MAX_AGE),
    'location': '/',
    'cache-control': 'no-store',
  });
  res.end();
}

function handleAuthLogout(req, res) {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  res.writeHead(302, {
    'set-cookie': authCookieFlags(req, '', 0),
    'location': '/',
    'cache-control': 'no-store',
  });
  res.end();
}

function handleAuthStatus(req, res) {
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({
    required: !!TREMIOM_TOKEN,
    authenticated: !TREMIOM_TOKEN || isAuthorized(req),
  }));
}

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

// ─── USGS per-event detail (focal mechanism / moment tensor) ──────────────
const detailCache = new Map(); // eventId -> { ts, body }
const DETAIL_TTL_MS = 30 * 60_000;

async function handleEventDetail(req, res) {
  const url = new URL(req.url, 'http://x');
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^[A-Za-z0-9]{6,20}$/.test(id)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad id' }));
    return;
  }
  const now = Date.now();
  const cached = detailCache.get(id);
  if (cached && now - cached.ts < DETAIL_TTL_MS) {
    res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'HIT' });
    res.end(cached.body);
    return;
  }
  try {
    const upstream = await fetch(
      `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${id}.geojson`,
      { headers: { 'user-agent': 'tremiom (https://github.com/thepacket/tremiom)' } }
    );
    if (!upstream.ok) {
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream', status: upstream.status }));
      return;
    }
    const j = await upstream.json();
    const prods = j?.properties?.products || {};
    const mech = (prods['moment-tensor'] || [])[0] || (prods['focal-mechanism'] || [])[0];
    let out = { id, hasMechanism: false };
    if (mech) {
      const p = mech.properties || {};
      const strike = parseFloat(p['nodal-plane-1-strike']);
      const dip    = parseFloat(p['nodal-plane-1-dip']);
      const rake   = parseFloat(p['nodal-plane-1-rake']);
      if (isFinite(strike) && isFinite(dip) && isFinite(rake)) {
        out = {
          id, hasMechanism: true, strike, dip, rake,
          derivedMag: parseFloat(p['derived-magnitude']) || null,
          magType: p['derived-magnitude-type'] || null,
        };
      }
    }
    const body = JSON.stringify(out);
    detailCache.set(id, { ts: now, body });
    res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'MISS' });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fetch failed', detail: String(e?.message || e) }));
  }
}

const magCache = new Map(); // eventId -> { ts, body }
const MAG_TTL_MS = 30 * 60_000;

async function handleEventMagnitude(req, res) {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body;
  try { body = await readBody(req); } catch { res.writeHead(400).end(); return; }
  let payload;
  try { payload = JSON.parse(body); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad json' })); return;
  }
  const id = payload.eventId || '';
  if (id && magCache.has(id)) {
    const c = magCache.get(id);
    if (Date.now() - c.ts < MAG_TTL_MS) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'HIT' });
      res.end(c.body); return;
    }
  }
  const proc = spawn(PYTHON, ['workers/event_magnitude.py'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let stdout = '';
  const timer = setTimeout(() => proc.kill('SIGTERM'), 120_000);
  proc.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  proc.on('exit', (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'magnitude failed', code })); return;
    }
    if (id) magCache.set(id, { ts: Date.now(), body: stdout });
    res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'MISS' });
    res.end(stdout);
  });
  proc.stdin.write(body);
  proc.stdin.end();
}

async function handleEventLocate(req, res) {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body;
  try { body = await readBody(req); } catch { res.writeHead(400).end(); return; }
  const proc = spawn(PYTHON, ['workers/event_locate.py'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let stdout = '';
  const timer = setTimeout(() => proc.kill('SIGTERM'), 120_000);
  proc.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  proc.on('exit', (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'locate failed', code })); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(stdout);
  });
  proc.stdin.write(body);
  proc.stdin.end();
}

// ─── Arbitrary-window waveform fetch (History mode) ───────────────────────
async function handleWaveform(req, res) {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body;
  try { body = await readBody(req); } catch { res.writeHead(400).end(); return; }
  // Validate JSON early.
  try { JSON.parse(body); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad json' })); return;
  }
  const proc = spawn(PYTHON, ['workers/waveform_fetch.py'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let stdout = '';
  const timer = setTimeout(() => proc.kill('SIGTERM'), 60_000);
  proc.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  proc.on('exit', (code) => {
    clearTimeout(timer);
    if (code !== 0 || !stdout) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'waveform fetch failed', code })); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(stdout);
  });
  proc.stdin.write(body);
  proc.stdin.end();
}

async function handleEventExport(req, res) {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body;
  try { body = await readBody(req); } catch { res.writeHead(400).end(); return; }
  let payload;
  try { payload = JSON.parse(body); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad json' })); return;
  }
  const id = (payload.eventId || 'event').replace(/[^A-Za-z0-9._-]/g, '_');
  const proc = spawn(PYTHON, ['workers/event_export.py'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const chunks = [];
  const timer = setTimeout(() => proc.kill('SIGTERM'), 120_000);
  proc.stdout.on('data', (c) => chunks.push(c));
  proc.on('exit', (code) => {
    clearTimeout(timer);
    if (code !== 0 || !chunks.length) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'export failed', code }));
      return;
    }
    const buf = Buffer.concat(chunks);
    res.writeHead(200, {
      'content-type': 'application/vnd.fdsn.mseed',
      'content-disposition': `attachment; filename="tremiom_${id}.mseed"`,
      'content-length': buf.length,
    });
    res.end(buf);
  });
  proc.stdin.write(body);
  proc.stdin.end();
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

// ─── FDSN station search ──────────────────────────────────────────────────
// Proxies IRIS's FDSN station service. Pipe-delimited text-format
// response is parsed server-side into JSON the picker can render.
// Station metadata is stable, so cache by full query for 1 hour.

const stationCache = new Map(); // querystring -> { ts, body }
const STATION_TTL_MS = 60 * 60_000;

async function handleStationSearch(req, res) {
  const url = new URL(req.url, 'http://x');
  const sp = url.searchParams;
  const network = (sp.get('network') || 'IU,II,US,G,GE,IV,AU,NZ,CN,CI,IM').trim();
  const channel = (sp.get('channel') || 'BHZ,HHZ').trim();
  const limit   = Math.min(parseInt(sp.get('limit') || '500', 10) || 500, 2000);
  const lat = sp.get('lat'); const lon = sp.get('lon');
  const maxradius = sp.get('maxradius'); // degrees
  const activeOnly = sp.get('active') !== 'false';

  // Build the upstream URL.
  const args = new URLSearchParams({
    network, channel,
    level: 'channel',
    format: 'text',
    nodata: '404',
    includerestricted: 'false',
  });
  if (activeOnly) {
    // Stations still operational past 2030: i.e. effectively "open".
    args.set('endafter', '2030-01-01');
  }
  if (lat && lon && maxradius) {
    args.set('latitude', lat);
    args.set('longitude', lon);
    args.set('maxradius', maxradius);
  }
  const upstreamUrl =
    `https://service.iris.edu/fdsnws/station/1/query?${args}`;

  const cacheKey = upstreamUrl;
  const now = Date.now();
  const cached = stationCache.get(cacheKey);
  if (cached && now - cached.ts < STATION_TTL_MS) {
    res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'HIT' });
    res.end(cached.body);
    return;
  }
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { 'user-agent': 'tremiom (https://github.com/andrepaquette/tremiom)' },
    });
    if (upstream.status === 404) {
      // FDSN returns 404 for no-data; respond with empty list.
      const body = JSON.stringify({ stations: [], note: 'no matches' });
      stationCache.set(cacheKey, { ts: now, body });
      res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'MISS' });
      res.end(body);
      return;
    }
    if (!upstream.ok) {
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream error', status: upstream.status }));
      return;
    }
    const text = await upstream.text();
    const stations = parseFdsnStationText(text, limit);
    const body = JSON.stringify({ stations, count: stations.length });
    stationCache.set(cacheKey, { ts: now, body });
    res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'MISS' });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fetch failed', detail: String(e?.message || e) }));
  }
}

// Lookup one specific NSLC → {nslc, lat, lon, sensor, sr}. Returns 404 if
// the IRIS catalog doesn't know about the channel. Used by the frontend
// to resolve coordinates for custom NSLCs so drum event-markers work
// even for stations outside the curated preset list.
async function handleStationLookup(req, res) {
  const url = new URL(req.url, 'http://x');
  const nslc = (url.searchParams.get('nslc') || '').trim();
  if (!/^[A-Z0-9]{1,8}\.[A-Z0-9]{1,8}\.[A-Z0-9]{0,3}\.[A-Z0-9?]{2,3}$/.test(nslc)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad nslc', nslc }));
    return;
  }
  const [net, sta, loc, cha] = nslc.split('.');
  const args = new URLSearchParams({
    network: net, station: sta, channel: cha,
    level: 'channel', format: 'text', nodata: '404',
  });
  if (loc) args.set('location', loc);
  const upstreamUrl = `https://service.iris.edu/fdsnws/station/1/query?${args}`;
  const cacheKey = upstreamUrl;
  const now = Date.now();
  const cached = stationCache.get(cacheKey);
  if (cached && now - cached.ts < STATION_TTL_MS) {
    res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'HIT' });
    res.end(cached.body);
    return;
  }
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { 'user-agent': 'tremiom (https://github.com/thepacket/tremiom)' },
    });
    if (upstream.status === 404) {
      const body = JSON.stringify({ found: false });
      stationCache.set(cacheKey, { ts: now, body });
      res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'MISS' });
      res.end(body);
      return;
    }
    if (!upstream.ok) {
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream error', status: upstream.status }));
      return;
    }
    const text = await upstream.text();
    const stations = parseFdsnStationText(text, 1);
    if (!stations.length) {
      const body = JSON.stringify({ found: false });
      stationCache.set(cacheKey, { ts: now, body });
      res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'MISS' });
      res.end(body);
      return;
    }
    const body = JSON.stringify({ found: true, station: stations[0] });
    stationCache.set(cacheKey, { ts: now, body });
    res.writeHead(200, { 'content-type': 'application/json', 'x-cache': 'MISS' });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fetch failed', detail: String(e?.message || e) }));
  }
}

/** Parse FDSN station service `format=text` (pipe-delimited, channel-level)
 *  into deduplicated `{nslc, lat, lon, sensor, sr}` records. Latest-epoch
 *  wins on duplicates. */
function parseFdsnStationText(text, limit) {
  // Columns: Network|Station|Location|Channel|Latitude|Longitude|Elevation|
  //          Depth|Azimuth|Dip|SensorDescription|Scale|ScaleFreq|ScaleUnits|
  //          SampleRate|StartTime|EndTime
  const map = new Map(); // nslc -> record
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split('|');
    if (f.length < 17) continue;
    const net = f[0], sta = f[1], loc = f[2] || '', cha = f[3];
    const nslc = `${net}.${sta}.${loc}.${cha}`;
    const lat = parseFloat(f[4]);
    const lon = parseFloat(f[5]);
    const sensor = f[10] || '';
    const sr = parseFloat(f[14]) || 0;
    const startTime = f[15];
    const existing = map.get(nslc);
    if (!existing || startTime > existing.startTime) {
      map.set(nslc, { nslc, lat, lon, sensor, sr, startTime });
    }
  }
  // Strip startTime from the payload; sort by network+station.
  return [...map.values()]
    .sort((a, b) => a.nslc.localeCompare(b.nslc))
    .slice(0, limit)
    .map((s) => ({ nslc: s.nslc, lat: s.lat, lon: s.lon, sensor: s.sensor, sr: s.sr }));
}

const httpServer = http.createServer((req, res) => {
  // /api/auth/* endpoints are always reachable — they're how the user
  // logs in / out and how the client probes auth state.
  const path = (req.url || '/').split('?')[0];
  if (path === '/api/auth/login')  return handleAuthLogin(req, res);
  if (path === '/api/auth/logout') return handleAuthLogout(req, res);
  if (path === '/api/auth/status') return handleAuthStatus(req, res);

  // Whole-app token gate. A URL with `?token=<correct>` swaps the query
  // parameter for a cookie and redirects to the clean URL (the legacy
  // "magic link" path; the login form is now the canonical entry).
  if (TREMIOM_TOKEN) {
    const urlToken = tokenFromUrl(req);
    if (urlToken && tokenEqual(urlToken, TREMIOM_TOKEN)) {
      installCookieAndRedirect(req, res);
      return;
    }
    if (!isAuthorized(req)) { sendUnauthorized(req, res); return; }
  }

  if (req.url?.startsWith('/api/event/detail')) {
    handleEventDetail(req, res);
    return;
  }
  if (req.url?.startsWith('/api/events')) {
    handleUsgs(req, res);
    return;
  }
  if (req.url?.startsWith('/api/event/export')) {
    handleEventExport(req, res);
    return;
  }
  if (req.url?.startsWith('/api/event/magnitude')) {
    handleEventMagnitude(req, res);
    return;
  }
  if (req.url?.startsWith('/api/waveform')) {
    handleWaveform(req, res);
    return;
  }
  if (req.url?.startsWith('/api/event/locate')) {
    handleEventLocate(req, res);
    return;
  }
  if (req.url?.startsWith('/api/event/waveforms')) {
    handleEventFetch(req, res);
    return;
  }
  if (req.url?.startsWith('/api/stations/search')) {
    handleStationSearch(req, res);
    return;
  }
  if (req.url?.startsWith('/api/stations/lookup')) {
    handleStationLookup(req, res);
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
  if (TREMIOM_TOKEN && !isAuthorized(req)) {
    console.warn(`[auth] 401 WS ${req.url} ip=${clientIp(req)}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
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
    } else if (msg.op === 'filter') {
      tellWorker({ op: 'filter', station: msg.station, spec: msg.spec });
    } else if (msg.op === 'units') {
      tellWorker({ op: 'units', station: msg.station, units: msg.units });
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
