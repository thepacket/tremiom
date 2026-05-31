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
                                  ┌──────────────────────────────────┐
   SeedLink (rtserve.iris…)  ───► │ Python worker: SeedLinkIngestor  │
   SeedLink (Raspberry Shake) ──► │   - obspy.clients.seedlink       │
                                  │   - per-channel ring buffer (60s)│
                                  │   - emits frames @ ~1 Hz         │
                                  └──────────┬───────────────────────┘
                                             │ NDJSON + binary frames over stdio
                                             ▼
                                  ┌──────────────────────────────────┐
                                  │ Python worker: PanelComputer     │
                                  │   - takes ring-buffer windows    │
                                  │   - computes panel-specific data │
                                  │     (spectrogram, PPSD, hodogram,│
                                  │      STA/LTA, etc.)              │
                                  │   - one worker per panel-kind    │
                                  └──────────┬───────────────────────┘
                                             │
                                             ▼
   USGS / EMSC event feeds ───►    ┌──────────────────────────────────┐
                                   │ Node multiplexer (server.mjs)    │
                                   │   - WebSocket server             │
                                   │   - subscription registry        │
                                   │     (clientId → {station, panel})│
                                   │   - fan-out + backpressure       │
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

### Why the Python workers are split (ingestor vs computer)

- The **ingestor** is I/O-bound and stateful (one persistent SeedLink TCP
  connection per upstream server). It must never block on computation.
- The **computer** is CPU-bound and stateless per request (window in,
  panel-data out). We can run N of them, or use multiprocessing inside
  one, depending on load.
- Same separation Radiom used between csdr stages: ingest stays hot,
  compute can scale.

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

- [ ] Repo scaffold (package.json, Vite, TS, server.mjs) mirroring Radiom
- [ ] Python venv + ObsPy + pyzmq (or plain stdio framing)
- [ ] SeedLinkIngestor worker connecting to IRIS (`rtserve.iris.washington.edu:18000`)
- [ ] Node multiplexer with one WS endpoint and station subscriptions
- [ ] Panel registry + 2 panels working end-to-end: helicorder + spectrogram
- [ ] Station picker UI (browse FDSN station metadata)
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

