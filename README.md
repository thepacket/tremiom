# tremiom

Real-time and historical seismic data viewer with scientific plots, in your browser.

Tremiom streams live waveforms from any IRIS / GSN station, runs server-side
scientific DSP (spectrogram, PSD, helicorder, raw scope), shows a live world
map of recent earthquakes from the USGS feed, and on demand fetches historical
waveforms for any event from FDSN and overlays TauP-predicted P/S arrival
times — all without leaving the page.

It's a sibling project to [radiom](https://github.com/andrepaquette/radiom)
and follows the same shape: thin Vite + TypeScript client, Node WebSocket
multiplexer, real DSP done server-side (Python/ObsPy/scipy instead of
csdr). See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design.

## What you get

### Live mode (default)

- **Station picker** — 15 curated GSN broadbands (ANMO, COLA, KIP, KONO,
  PMSA, BFO, SUR, …) plus a free-form `NET.STA.LOC.CHA` input for any
  station the SeedLink server knows.
- **World map** — live event epicenters from USGS (colored + sized by
  magnitude, faded by age over 24 h) plus the curated station markers.
  Click anything to select it.
- **Sidebar** — every event from the chosen USGS feed (17 to choose
  from, e.g. M2.5+ in the last day, M4.5+ this week, "significant"
  events). Mag-colored badges, time-ago labels that refresh between
  polls.
- **Four scientific panels** updating at 1 Hz from real samples:
  - **Helicorder** — 60 s drum-recorder downsample
  - **Spectrogram** — sliding STFT, dB scale, 8 s window
  - **Raw scope** — 10 s decimated waveform
  - **PSD** — Welch power spectral density over 60 s

### Event mode (click an event)

- Fetches the 6 nearest curated stations from FDSN dataselect
- Runs **TauP** on the iasp91 1-D Earth model for P and S arrivals
- Renders a **record section**: stacked waveforms aligned by epicentral
  distance, with dashed P (yellow) and S (red) arrival markers and a
  vertical line at the origin time
- "← Live" in the topbar to return to live mode

## Quick start

```bash
# 1. Node deps
npm install

# 2. Python workers (creates workers/.venv with obspy / numpy / scipy)
npm run workers:install

# 3. Terminal A — Node multiplexer (spawns the Python worker)
npm start

# 4. Terminal B — Vite dev server
npm run dev:http        # http://localhost:5174  (no certs needed)
# or HTTPS via mkcert:
npm run dev             # https://localhost:5173
```

Open the URL Vite prints. Expect the four panels to say "waiting for
frames…" for ~10–20 s while the SeedLink handshake completes; that's
normal.

## Layout

```
src/
  main.ts                 Entry
  ui/
    app.ts                Top-level layout + state plumbing
    station-picker.ts     Topbar station selector
    event-list.ts         Sidebar (USGS feed)
    world-map.ts          Equirectangular world map + click handling
    record-section.ts     Event-mode stacked waveforms with P/S overlays
  panels/
    registry.ts           Registry — same pattern as Radiom
    helicorder.ts         The four live panels
    spectrogram.ts
    raw-scope.ts
    psd.ts
  data/
    stations.ts           Curated 15 GSN broadband stations
    events.ts             USGS feed types + helpers
    event-waveforms.ts    Event fetch types + helpers
    coastlines.json       Natural Earth 1:110m land outlines
  transport/
    ws.ts                 WebSocket client (reconnecting)
    events.ts             USGS event-feed poller
server.mjs                Node WS multiplexer + REST proxy
workers/
  worker.py               Unified SeedLink ingestor + panel computers
  event_fetch.py          One-shot FDSN/TauP fetcher for event mode
  requirements.txt        obspy, numpy, scipy
ARCHITECTURE.md           Design doc + roadmap
```

## Private-deployment token

When `TREMIOM_TOKEN` is set in the environment, **every** HTTP and
WebSocket request must present a matching cookie or one-time URL
parameter. Use this on shared/public infrastructure (e.g. fly.io) to
keep the instance to yourself.

```bash
# Pick a secret (any string; longer is better)
openssl rand -hex 32
# → eg 7f1b…ab98

# On fly.io:
fly secrets set TREMIOM_TOKEN=7f1b…ab98
fly deploy   # only needed if the app is currently running an older image
```

Then visit your instance:

```
https://tremiom.fly.dev/
```

A sign-in page asks for the token. After submitting, the server sets a
1-year `HttpOnly; SameSite=Lax; Secure` cookie and the app loads.
Subsequent visits don't need to re-authenticate; the cookie does the
work, including for the WebSocket connection.

Inside the running app, the **⚙ Settings** button in the topbar shows
the current auth state, lets you sign out, and provides a token field
to apply a new token without leaving the page (useful after a server-
side rotation).

A legacy `?token=…` URL also works for bookmarks / scripts, but the
sign-in form is the canonical entry. To revoke all access, change
`TREMIOM_TOKEN` and redeploy — every existing cookie becomes
invalid immediately.

When the env var is unset, the server is open (the default for local
dev and self-hosting).

## Deploy (fly.io)

Same shape as Radiom: a [`Dockerfile`](./Dockerfile) and a
[`fly.toml`](./fly.toml) at the project root.

```bash
# First time only:
fly apps create tremiom
fly deploy

# Subsequent deploys:
fly deploy
```

The image is a multi-stage build:
1. `node:22-alpine` builds the Vite/TS frontend → `dist/`
2. `python:3.11-slim-bookworm` installs ObsPy + numpy + scipy into a
   self-contained `/opt/venv`
3. Final stage: same Python base + Node 22 from NodeSource + the venv +
   the built frontend + `server.mjs` and `workers/`

Default Fly config: `primary_region = "yyz"`, shared 1 CPU + 1024 MB,
`auto_stop_machines = "stop"` so the machine sleeps when idle. Outbound
TCP 18000 must be open from the Fly region for IRIS rtserve (and
data.raspberryshake.org if you want AM streams to work) — both are
allowed by default on Fly.

## Status

**v0.0.x.** Real-data live mode and event-mode work end-to-end against
IRIS rtserve + EarthScope FDSN, against the curated 15 station list.
Aesthetic + feature polish is happening live; future work tracked in the
checklist at the bottom of `ARCHITECTURE.md`.

The `TREMIOM_SYNTHETIC=1` environment variable forces synthetic
ingestion if you want to develop the UI without an internet connection.

## Security

See [`SECURITY.md`](./SECURITY.md) for the threat model, cookie flags,
and what is / isn't in the repo. **No secrets are committed**: `.env`,
keys, and Fly secret values are gitignored and managed via
`fly secrets set …`.

## Contributing

tremiom is a solo-authored project and **does not accept pull requests**.
An automated workflow closes incoming PRs. Bug reports, feature
requests, and discussions are welcome — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md). The GPL-3.0-or-later license
grants you the right to fork and modify your fork freely.

## Acknowledgments

- **IRIS / EarthScope** — `rtserve.iris.washington.edu` SeedLink stream
  and FDSN dataselect web service
- **USGS** — earthquake summary GeoJSON feeds
- **ObsPy** — the heroic seismology toolkit that makes the Python side
  possible
- **Natural Earth** — public-domain 1:110m land outlines
- **TauP** — iasp91 travel-time tables, via ObsPy

## License

[GPL-3.0-or-later](./LICENSE)
