# tremiom

**A real-time and historical seismology workstation in your browser.**

Tremiom streams live waveforms from thousands of global broadband stations,
runs the full ObsPy/scipy analysis toolkit server-side, and presents it as a
configurable Grafana-style dashboard of scientific panels — helicorder drum,
spectrogram, PSD/PPSD, RSAM, STA/LTA, 3-component, particle motion, H/V site
response, and more. A live world map and USGS feed drive an event-analysis
mode (record sections, TauP arrivals, focal-mechanism beachballs, felt-report
+ ShakeMap overlays, manual + automatic phase picking, grid-search location,
ML/Md magnitudes, QuakeML/MiniSEED export). A History mode browses any
station over any time window with zoom/pan, or opens your own MiniSEED/SAC
files. Every panel removes the instrument response on demand (counts →
velocity / displacement / acceleration / Wood-Anderson) and applies
server-side band-pass filters. Dashboards are named, saved, printed to PDF,
and shared as JSON. And it's self-teaching: every panel carries built-in
educational help.

All in the browser, with no install, behind an optional one-token private
deploy.

It's a sibling project to [radiom](https://github.com/andrepaquette/radiom)
and follows the same shape: thin Vite + TypeScript client, Node WebSocket
multiplexer, real DSP done server-side (Python / ObsPy / scipy instead of
csdr). See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design and
[`COMPETITIVE.md`](./COMPETITIVE.md) for how it measures up against the
established tools.

## Authorship

Tremiom is a two-name project:

- **[Claude Code](https://www.anthropic.com/claude-code)** — Anthropic's
  CLI coding agent, sole coder. Every line of TypeScript, Python, the
  Dockerfile, the `fly.toml`, and the docs you're reading was written by
  the agent.
- **[Andre Paquette](https://github.com/andrepaquette)** — human
  maintainer. Set the direction, made design and scope decisions,
  evaluated each iteration on a real fly.io deployment, and decided when
  to ship — but didn't write the code by hand.

Bugs and design choices are the agent's; the call to keep them or fix
them is the maintainer's.

## Features

### Data sources & stations
- **Live SeedLink streaming** from IRIS/EarthScope (`rtserve`) and Raspberry
  Shake (`data.raspberryshake.org`), routed per network.
- **Station picker** — 15 curated GSN broadbands plus free-form
  `NET.STA.LOC.CHA` entry, plus a **Browse…** modal that searches the full
  FDSN station catalog by network / channel / radius.
- **Open local files** — load your own MiniSEED / SAC / GSE2 (anything
  ObsPy reads) and view them in History mode.

### Live panels (15, on a configurable dashboard)
- **Helicorder** — 24-hour drum recorder; 24 h backfilled on subscribe, then
  live. Catalog events marked at their predicted arrival time.
- **RSAM** — real-time seismic amplitude (1-min bins over 24 h); tremor tracker.
- **Spectrogram** — sliding time–frequency heatmap.
- **Spectrum (FFT)** — live magnitude spectrum + decaying peak-hold.
- **PSD** — Welch power spectral density.
- **PPSD** — accumulating probabilistic PSD (station noise/quality).
- **STA/LTA** — trigger ratio with threshold shading.
- **Raw scope** — rolling waveform window.
- **3-component** — Z / N / E (or 1/2) stacked.
- **Particle motion** — horizontal hodogram (polarization).
- **H/V ratio** — Nakamura horizontal-to-vertical site response, f₀ peak.
- **Network** — multi-station RSAM overview.
- **Station QC** — gaps / latency / RMS health metrics.
- **Wave clipboard** — pinned trace snapshots for comparison.
- **Notes** — editable markdown panels (0..many per dashboard).

### Signal processing (server-side, applied across panels)
- **Instrument response removal / units** — counts, velocity (m/s),
  displacement (m), acceleration (m/s²), or **Wood-Anderson** (mm), via
  ObsPy + cached StationXML.
- **Band-pass / low / high filters** — Butterworth presets (local quake,
  regional, teleseismic, microseism, surface waves, …), zero-phase.

### World map & events
- **Pan/zoom world map** (wheel + drag, double-click reset) with coastlines,
  live USGS epicenters (magnitude color/size, age fade), and station markers.
- **Event sidebar** — 17 USGS feeds; magnitude badges; felt-report intensity
  chips (CDI/MMI).

### Event-analysis mode (click any event)
- **Record section** — N nearest stations stacked by epicentral distance,
  **TauP** (iasp91) predicted P (yellow) / S (red) arrivals, origin line.
- **Z / R / T rotation** — rotate horizontals to radial/transverse.
- **Focal-mechanism beachball** from the USGS moment tensor.
- **Independent magnitudes** — ML (Wood-Anderson) and Md (coda duration).
- **DYFI felt-report polygons** + **ShakeMap** modeled-intensity raster on the map.
- **Phase picking** — manual P/S (click), **auto-pick** (STA/LTA onset),
  persistent per-event pick catalog, **QuakeML** export.
- **Grid-search location** from your P picks (offset vs the catalog).
- **Export** — full-resolution **MiniSEED**, decimated **CSV**, or **PNG**.

### Dashboards
- **Many named dashboards**, one shown at a time; create / rename / delete
  from the topbar selector. Drag-to-move, drag-to-resize panels (gridstack).
- **Per-panel PNG export**, **print whole dashboard to PDF**.
- **Export / import dashboards as JSON** (Grafana-style sharing/backup).
- Layout, panels, notes, and picks **persist** in the browser.

### Live monitoring
- **STA/LTA trigger alerts** — browser notification + banner when a station
  crosses your threshold.

### Modes
- **Live** (the dashboard), **Event** (record section), **History** (any
  station, any time window, zoom/pan/step, or a local file).

### Built-in help
- A **?** in the topbar and on every panel opens a searchable, educational
  reference: what each panel is, how to read it, and how to use it.

### Deployment & access
- One-command **fly.io** deploy (Docker), **`TREMIOM_TOKEN`** single-token
  private access with a sign-in form + cookie, or fully open for local use.

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

Open the URL Vite prints. Expect the panels to say "waiting for
frames…" for ~10–20 s while the SeedLink handshake completes; that's
normal. Set `TREMIOM_SYNTHETIC=1` on the server to develop the UI
offline with synthetic data.

## Layout

```
src/
  main.ts                 Entry
  ui/
    app.ts                Top-level layout + state plumbing
    dashboard.ts          Multi-dashboard manager (gridstack) + markdown panels
    dashboard-bar.ts      Topbar dashboard selector / CRUD / JSON / PDF
    panel-picker.ts       Add/remove panels popover
    station-picker.ts     Topbar station selector + Browse modal
    station-search.ts     FDSN station-catalog search modal
    filter-picker.ts      Band-pass filter selector
    units-picker.ts       Response-removal / units selector
    alert-picker.ts, alerts.ts   STA/LTA trigger alerts
    event-list.ts         Sidebar (USGS feed + felt chips)
    world-map.ts          Pan/zoom map + DYFI + ShakeMap overlays
    record-section.ts     Event mode: record section, picks, locate, export
    history-view.ts       History mode: arbitrary time window + local files
    beachball.ts          Focal-mechanism renderer
    settings.ts           Auth/settings modal
    help.ts               Educational help overlay (per-panel docs)
  panels/
    registry.ts           Panel registry
    drum.ts rsam.ts spectrogram.ts spectrum.ts psd.ts ppsd.ts
    sta-lta.ts raw-scope.ts three-comp.ts particle-motion.ts hv.ts
    helicorder.ts network.ts clipboard.ts qc.ts
    axes.ts colormap.ts   Shared plot helpers
  data/
    stations.ts events.ts event-waveforms.ts filters.ts
    coastlines.json       Natural Earth 1:110m land outlines
  transport/
    ws.ts events.ts       WebSocket client + USGS feed poller
  util/markdown.ts        Dependency-free markdown renderer (notes panels)
server.mjs                Node WS multiplexer + REST/FDSN/USGS proxies + auth
workers/
  worker.py               Unified SeedLink ingestor + live panel computers
  event_fetch.py          Record-section waveforms + TauP (+ ZRT rotation)
  event_export.py         Full-resolution MiniSEED export
  event_magnitude.py      ML (Wood-Anderson) + Md (coda) estimation
  event_autopick.py       STA/LTA P-arrival auto-picker
  waveform_fetch.py       Arbitrary-window fetch (History mode)
  parse_waveform.py       Parse uploaded local files
  requirements.txt        obspy, numpy, scipy
ARCHITECTURE.md           Design doc + roadmap
COMPETITIVE.md            Feature comparison vs 17 established tools
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
[`fly.toml`](./fly.toml) at the project root drive everything. Fly's
remote builders handle the Docker build, so no local Docker daemon is
needed once you can run `fly deploy`.

### Prerequisites

```bash
# Install flyctl (macOS/Linux)
curl -L https://fly.io/install.sh | sh

# Sign in (opens a browser)
fly auth login
```

### First-time setup

```bash
cd /path/to/tremiom

# Create the app (name must be globally unique on fly.io)
fly apps create tremiom

# Set the private-deployment secret (see "Private-deployment token"
# above). Skip this if you intend to leave the instance open.
fly secrets set TREMIOM_TOKEN="$(openssl rand -hex 32)" -a tremiom

# Build + deploy. First build is ~5–8 min (obspy/numpy/scipy wheels);
# subsequent builds are ~30 s–2 min with layer caching.
fly deploy
```

Once the deploy lands, visit `https://tremiom.fly.dev/` — you'll see
the sign-in page (or the app directly if you didn't set a token).

### Subsequent deploys

```bash
git pull        # if you fetched changes
fly deploy      # rebuilds image, rolls out
```

### What the image actually contains

Multi-stage Docker build:

1. `node:22-alpine` builds the Vite/TS frontend → `dist/`
2. `python:3.11-slim-bookworm` installs ObsPy + numpy + scipy into a
   self-contained `/opt/venv` (in its own layer so changes to TS source
   don't bust the pip cache)
3. Final stage: same Python base + Node 22 from NodeSource + the venv +
   built frontend + `server.mjs` + `workers/`

Final image size: ~220 MB.

### Default Fly config (`fly.toml`)

| Setting | Value | Notes |
|---|---|---|
| `primary_region` | `yyz` | Toronto — change to your nearest Fly region |
| VM | 1 shared CPU, 1024 MB | Heavy because obspy + scipy + matplotlib hold ~350 MB RSS |
| `auto_stop_machines` | `stop` | Sleeps when idle, restarts on next request |
| `auto_start_machines` | `true` | Auto-wake on incoming traffic |
| `min_machines_running` | `0` | Cost-optimized; first request after sleep adds ~5 s cold-start |
| `force_https` | `true` | Fly's edge terminates TLS; the inside is HTTP |
| `internal_port` | `8080` | Matches `PORT` env + `server.mjs` |

Change region by editing `fly.toml` then `fly deploy`. Change VM size
by editing `[[vm]]` (e.g. `memory_mb = 2048` if you see OOM-kill in
the logs).

### Outbound network requirements

The container needs outbound access to:

| Host | Port | Why |
|---|---|---|
| `rtserve.iris.washington.edu` | 18000/tcp | Live SeedLink (GSN broadbands) |
| `data.raspberryshake.org` | 18000/tcp | Live SeedLink (AM citizen seismometers) |
| `service.iris.edu` | 443/tcp | FDSN station + dataselect (event mode) |
| `service.earthscope.org` | 443/tcp | FDSN — ObsPy redirects IRIS → EarthScope |
| `earthquake.usgs.gov` | 443/tcp | USGS event feed |

Fly allows all outbound TCP by default — nothing to configure.

### Operating the instance

```bash
fly logs -a tremiom              # tail logs
fly status -a tremiom            # machine status
fly ssh console -a tremiom       # shell into the running container
fly machine restart -a tremiom   # force restart
fly scale memory 2048 -a tremiom # bump RAM if obspy spikes
fly secrets list -a tremiom      # see env var NAMES (values stay hidden)
fly secrets unset TREMIOM_TOKEN -a tremiom   # remove the token (instance becomes open)
```

### Custom domain (optional)

```bash
fly certs create tremiom.yourdomain.com -a tremiom
# then point a CNAME from yourdomain.com to tremiom.fly.dev
fly certs show tremiom.yourdomain.com -a tremiom   # check issuance
```

### Troubleshooting

- **Build fails on a `pip install` step:** a Debian native lib may be
  missing for some obspy dep. Add it to `apt-get install` in the
  `pydeps` Docker stage and retry.
- **OOM-killed machine:** bump `memory_mb` in `fly.toml` to 2048; ObsPy
  spikes when many `/api/event/waveforms` requests run concurrently.
- **Stuck at "waiting for first sample" forever:** the SeedLink upstream
  may be blocked. `fly ssh console` then
  `nc -zv rtserve.iris.washington.edu 18000` to verify. Fly logs will
  show `sl[host]: upstream unreachable — backing off 60s` if the probe
  caught it.
- **401 after a deploy:** the cookie is still valid against the old
  `TREMIOM_TOKEN`, but you may have rotated it. Sign in again with the
  new token via the form.

## Status

**v0.4.x.** Live, event, and history modes all work end-to-end against IRIS
rtserve + EarthScope FDSN + USGS, with 15 panels, configurable multi-
dashboards, response removal, picking/location/magnitudes, and built-in
help. Per [`COMPETITIVE.md`](./COMPETITIVE.md), Tremiom is a superset of the
live-monitoring + single-event-analysis feature sets of the established
tools (Swarm, SeisComP, Snuffler, Wilber 3, GeoNet, Raspberry Shake, …);
the only deliberate exclusions are array/research subsystems (FK,
receiver functions, cross-correlation) and the full automatic
detect→associate→locate pipeline.

`TREMIOM_SYNTHETIC=1` on the server forces synthetic ingestion for offline
UI development.

## Security

See [`SECURITY.md`](./SECURITY.md) for the threat model, cookie flags,
and what is / isn't in the repo. **No secrets are committed**: `.env`,
keys, and Fly secret values are gitignored and managed via
`fly secrets set …`.

## Contributing

tremiom is a solo-authored project and **does not accept pull requests**.
An automated workflow closes incoming PRs. Bug reports, feature
requests, and discussions are welcome — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md). The MIT license grants you the
right to use, fork, and modify it freely.

## Acknowledgments

- **IRIS / EarthScope** — SeedLink stream + FDSN station / dataselect web services
- **Raspberry Shake** — AM-network citizen-seismometer SeedLink + catalog
- **USGS** — earthquake summary GeoJSON feeds, per-event detail
  (moment tensor, DYFI felt reports, ShakeMap intensity)
- **ObsPy** — the seismology toolkit that makes the Python side possible
  (SeedLink, FDSN, response removal, TauP, triggers, beachballs, …)
- **gridstack.js** — the draggable/resizable dashboard grid
- **Natural Earth** — public-domain 1:110m land outlines
- **TauP** — iasp91 travel-time tables, via ObsPy

## License

[MIT](./LICENSE) © Andre Paquette. Third-party dependency licenses are
listed in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).
