# tremiom

Real-time and historical seismic data viewer with scientific plots.

Web client + Node multiplexer + Python/ObsPy workers. Same shape as
[radiom](https://github.com/…/radiom) but for seismology instead of SDR.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design.

## Status

**v0.0.1 scaffold.** Frontend boots, multiplexer accepts WebSocket
subscriptions, panel workers emit *synthetic* frames so the UI can be
developed independently. Real SeedLink + ObsPy DSP is the next step
(`workers/ingestor.py` is stubbed for it).

## Quick start

```bash
# 1. Node deps
npm install

# 2. Python workers (creates workers/.venv with ObsPy/numpy/scipy)
npm run workers:install

# 3. In one terminal: Node multiplexer (spawns panel workers on demand)
npm start

# 4. In another terminal: Vite dev server with HTTPS
npm run dev
# or HTTP, port 5174:
npm run dev:http
```

Open the URL Vite prints. You should see 4 panels showing synthetic data.

## Layout

```
src/                    Frontend (Vite + TS, plain modules — no framework)
  main.ts               Entry
  ui/app.ts             Top-level layout, panel mounting
  transport/ws.ts       WebSocket client to the multiplexer
  panels/
    registry.ts         Panel registry
    helicorder.ts       v0.1 panels (live category)
    spectrogram.ts
    raw-scope.ts
    psd.ts
server.mjs              Node multiplexer (WS server + Python worker spawner)
workers/
  ingestor.py           SeedLink client → ring buffer (stubbed)
  panels.py             Panel computer (currently emits synthetic frames)
  requirements.txt      Python deps
public/icon.svg         App icon
ARCHITECTURE.md         Design doc
```

## Contributing

tremiom is a solo-authored project and **does not accept pull requests**. An
automated workflow closes incoming PRs. Bug reports, feature requests, and
discussions are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). The
GPL-3.0-or-later license grants you the right to fork and modify your fork
freely.

## License

[GPL-3.0-or-later](./LICENSE)
