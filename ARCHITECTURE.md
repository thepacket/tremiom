# Tremiom — Architecture Sketch (v0.1)

Real-time and historical seismic data viewer with scientific plots.
Mirrors Radiom's shape: thin web client, server doing the heavy lifting,
many small panels in a registry.

---

## Goals (v0.1)

- Stream live waveforms from one or more SeedLink stations to a browser.
- Display 4–6 scientific panels per station, time-aligned.
- Browse a global event catalog (USGS / EMSC), click an event → fetch
  waveforms from N nearest stations and open per-event panels.
- Run locally first; cloud-deploy story comes later (mirror Radiom's
  `fly.toml` pattern when we get there).

## Non-goals (v0.1)

- No native app, no Qt, no Electron. Browser only.
- No write-side: we don't ingest user-uploaded SEED files yet.
- No authoritative picking/location service. We *display* picks; the
  authoritative seismic network does the science.
- No mobile-first UI. Desktop/responsive web; mobile companion later.

---

## Stack (mirroring Radiom)

| Layer       | Choice                              | Why                                                 |
|-------------|-------------------------------------|-----------------------------------------------------|
| Frontend    | Vite + TypeScript, plain modules    | Same as Radiom. No framework tax.                   |
| Plots       | Canvas2D / WebGL (Regl or custom)   | Same canvas-heavy approach as Radiom panels.        |
| Transport   | WebSocket (`ws`)                    | Same as Radiom.                                     |
| Multiplexer | Node.js `server.mjs`                | Same as Radiom — fans out client subscriptions.     |
| Workers     | **Python 3.11 + ObsPy**             | SeedLink client, FDSN client, all the DSP. No JS equivalent worth fighting. |
| IPC         | Node ⇄ Python via stdio (NDJSON + framed binary) or ZeroMQ | Same shape as Radiom's csdr subprocess pattern. |
| PWA         | `vite-plugin-pwa`                   | Same as Radiom.                                     |
| Deploy      | Dockerfile + fly.toml (later)       | Same as Radiom.                                     |

---

## Server architecture

```
   SeedLink (rtserve.iris…)  ───► ┌──────────────────────────────────┐
   SeedLink (Raspberry Shake) ──► │ Python worker (workers/worker.py)│
                                  │   - SeedLink client (ObsPy)      │
                                  │   - per-channel ring buffer      │
                                  │   - panel computers (scipy DSP): │
                                  │     spectrogram / PSD / helicord.│
                                  │     / raw-scope / …              │
                                  │   - emits NDJSON frames @ ~1 Hz  │
                                  │   - falls back to synthetic mode │
                                  │     if obspy/scipy missing       │
                                  └──────────┬───────────────────────┘
                                             │ NDJSON over stdio
                                             ▼
   USGS / EMSC event feeds ───►    ┌──────────────────────────────────┐
                                   │ Node multiplexer (server.mjs)    │
                                   │   - WebSocket server             │
                                   │   - subscription registry        │
                                   │     (clientId → {station, panel})│
                                   │   - fan-out to subscribers       │
                                   │   - worker auto-restart          │
                                   │   - REST proxy to FDSN/USGS      │
                                   └──────────┬───────────────────────┘
                                              │ WebSocket
                                              ▼
                                   ┌──────────────────────────────────┐
                                   │ Browser (Vite + TS)              │
                                   │   - panel registry               │
                                   │   - canvas renderers             │
                                   │   - station picker, event picker │
                                   └──────────────────────────────────┘
```

### Why one unified worker (not separate ingestor + computer)

The earlier sketch split SeedLink ingestion and panel computation into
separate Python processes. **We collapsed that into one process** because:

- The ring buffer lives in *one* process's memory; an IPC layer to share
  it (Redis, shared memory) would be pure overhead at our scale.
- Multiple processes would each open their own SeedLink TCP connection
  to IRIS — wasteful, and bad upstream citizenship.
- One process keeps the SeedLink callback (background thread inside
  ObsPy) and the panel timer thread coordinated via a single lock on the
  ring buffer.

If panel computation ever becomes CPU-bound enough to matter, we'll move
it to threads or a multiprocessing pool *inside* the worker, not split
the process boundary.

### What the worker hands back to the multiplexer

Two frame kinds:

- **Waveform tick** (binary, ~1 Hz): one second of samples for one
  channel, gzipped or float16-quantized. Goes to helicorder + raw scope.
- **Panel result** (NDJSON): pre-computed arrays the canvas can draw
  directly — spectrogram column, PPSD percentile bands, hodogram XY
  points, STA/LTA series, etc.

Computing panels server-side (not in the browser) is the Radiom lesson:
the client should never see raw 100 Hz samples it doesn't need.

---

## WebSocket protocol (sketch)

Client → server:

```json
{ "op": "subscribe", "station": "IU.ANMO.00.BHZ",
  "panels": ["helicorder", "spectrogram", "ppsd"] }
{ "op": "unsubscribe", "station": "IU.ANMO.00.BHZ" }
{ "op": "event-open", "eventId": "us7000abcd",
  "panels": ["record-section", "particle-motion"] }
```

Server → client:

```
[NDJSON line] { "frame": "panel", "station": "...", "panel": "spectrogram",
                "t": 1748736000.0, "data": [...] }
[binary]      <waveform tick, framed>
```

Binary frames are length-prefixed and tagged so they can interleave with
the NDJSON channel.

---

## Panel registry pattern (port from Radiom)

Each panel is a self-contained module exporting:

```ts
interface Panel {
  id: string;                    // "spectrogram"
  label: string;                 // "Spectrogram"
  category: "live" | "event";    // picker group (mutex within group)
  serverWorker: string;          // python module to dispatch to
  render(ctx: CanvasRenderingContext2D, data: PanelFrame): void;
  onResize?(w: number, h: number): void;
}
```

Same registry-from-day-1 discipline that let Radiom grow to 60+ panels.

---

## v0.1 panel inventory

### Live (continuous stream from a chosen station)

| Panel              | Description                                         | Server work                |
|--------------------|-----------------------------------------------------|----------------------------|
| **Helicorder**     | 24-h drum recorder, the iconic seismology view      | downsample to display rate |
| **Spectrogram**    | Sliding STFT, log-frequency Y                       | STFT @ ~1 Hz column rate   |
| **PSD / PPSD**     | McNamara-Buland probabilistic PSD over last N min   | Welch + histogram          |
| **Raw scope**      | 60-s rolling waveform, 3 components stacked         | downsample only            |
| **STA/LTA**        | Trigger ratio + threshold ribbon                    | classic STA/LTA            |
| **Particle motion**| 3-component hodogram (ZN / ZE / NE pairs)           | window resample            |

### Event (triggered by clicking a catalog event)

| Panel              | Description                                         |
|--------------------|-----------------------------------------------------|
| **Event map**      | Epicenter + N nearest stations, great-circle arcs   |
| **Record section** | Waveforms stacked by epicentral distance            |
| **Travel-time**    | TauP-predicted P/S overlaid on record section       |
| **Beachball**      | Focal mechanism if USGS provides Mt solution        |
| **Felt reports**   | DYFI (USGS) / LastQuake (EMSC) intensity dots       |

Six live + five event panels = a credible v0.1. Room to add wavelet/HHT
panels (you already have the math from Radiom) once the skeleton is up.

---

## v0.1 milestone checklist

- [x] Repo scaffold (package.json, Vite, TS, server.mjs) mirroring Radiom
- [x] Python venv + ObsPy + scipy (plain stdio framing — no pyzmq needed)
- [x] Unified worker connecting to IRIS (`rtserve.iris.washington.edu:18000`)
- [x] Node multiplexer with one WS endpoint and station subscriptions
- [x] Panel registry + 4 live panels: helicorder, spectrogram, raw scope, PSD
- [x] Real-network smoke test: confirmed IRIS samples reach the browser
      (~10–20 s first-frame latency for BHZ on rtserve.iris.washington.edu)
- [x] Station picker UI — curated GSN presets + free-form NSLC input
- [ ] FDSN station service search (network/region/free-text → live results)
- [ ] Lower switch-latency on station change (SeedLink reconnect can take
      >30 s after `close()`; investigate keeping the connection open and
      sending a SeedLink `INFO`/restart command instead)
- [x] USGS event feed → event list in sidebar (60 s server-side cache,
      17 feeds, click-to-select hook in place)
- [ ] Click an event → event-map panel + record-section (next milestone)
- [ ] USGS event feed → event list in sidebar
- [ ] Click an event → event-map panel + record-section
- [ ] README with "what is Tremiom" + screenshots
- [ ] Dockerfile (defer fly.toml until we deploy)

---

## Open questions

1. **Upstream SeedLink etiquette.** IRIS asks real-time clients to
   identify themselves and limit channel count. Need a `User-Agent`-like
   selector strategy and per-station rate-limit before going public.
2. **Storage.** v0.1 keeps everything in-memory ring buffers. Do we want
   on-disk miniSEED archiving for "rewind" UX, or punt to FDSN historical
   queries? (Lean: punt for v0.1.)
3. **Auth / multi-tenant.** Public demo or single-user-on-localhost
   first? Affects whether the multiplexer needs per-client quota.
4. **Raspberry Shake integration.** Their public SeedLink server is
   `data.raspberryshake.org:18000`. Worth adding a curated "interesting
   Shake stations" list as a built-in catalog for the hobbyist audience.

