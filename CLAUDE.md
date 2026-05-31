# CLAUDE.md — Tremiom working notes

Browser-based real-time + historical **seismology** workstation.
Sole coder: Claude Code; human maintainer (Andre Paquette) directs + ships.
Repo: github.com/thepacket/tremiom. Public, **MIT** licensed (relicensed
from GPL-3.0 — no dep requires copyleft; ObsPy is LGPL-3.0 used as a
separate pip subprocess). Deployed on fly.io.

## Stack & architecture
- Frontend: **Vite + TypeScript**, no framework. Canvas panels. `src/`.
- `server.mjs`: Node **WebSocket multiplexer** + REST/FDSN/USGS proxies + auth.
- `workers/*.py`: **Python + ObsPy/scipy/numpy** in a venv (`workers/.venv`).
  `worker.py` = unified SeedLink ingestor + live panel computers (one process,
  per-network SeedLink routing IRIS + Raspberry Shake). One-shot helpers:
  `event_fetch` (record section + TauP + ZRT), `event_export` (MiniSEED),
  `event_magnitude` (ML+Md), `event_autopick`, `waveform_fetch` (History),
  `parse_waveform` (local files).
- Panels: registry in `src/panels/registry.ts`; each is `render(ctx,canvas,frame)`.
- Dashboard: `src/ui/dashboard.ts` (gridstack), multi-dashboard store in
  localStorage `tremiom-dashboards-v2`.

## Conventions (FOLLOW THESE)
- **Bump `package.json` version every change** (v0.x.y), commit with a detailed
  message, `git push`. Commit footer: `Co-Authored-By: Claude …`. Currently ~v0.4.7.
- **Never push without explicit OK** — wait, the maintainer was explicit early that
  push is allowed for this repo; still confirm for anything unusual.
- **Verify in a real browser** before claiming a UI fix done. Preview tool:
  `.claude/launch.json` has `tremiom-dev`. Pattern: build → `preview_eval`
  to measure DOM rects / state, `preview_screenshot`. Don't trust
  reasoning about layout — measure.
- Synthetic mode for offline UI dev: `TREMIOM_SYNTHETIC=1 PORT=8080 node server.mjs`.
- Build check: `npx tsc -b` (typecheck) then `npx vite build`.

## Gotchas (HARD-WON)
- **gridstack ships CSS only for ≤12 columns.** Grid is **12-column**: full-width
  panels w:12, pairs w:6. `column:24` silently fell back to 12 and stacked
  everything. `migrate24to12()` rescales old 24-col saved layouts.
- **CSS layout offsets use vars** `--topbar-h: 64px` (two-row topbar) and
  `--map-h: 340px` (map header). Don't hardcode 36/220 px.
- **Canvas panels need `minmax(0,1fr)` grid track + `min-height:0`** or the
  canvas's intrinsic 150px overflows and clips axis labels (the big "truncation"
  bug). Root cause of most "plot cut off" reports.
- **IU.ANMO streams horizontals as BH1/BH2, not BHN/BHE.** Sibling/3-comp code
  tries both naming families.
- **macOS/container Python: set `SSL_CERT_FILE=certifi.where()`** before any
  ObsPy FDSN HTTPS call or it fails CERTIFICATE_VERIFY_FAILED.
- **FDSN inventory fetch must be narrowed** (channel pattern + `starttime=now`)
  or it pulls ~700 channel-epochs and takes ~50s instead of ~1.5s.
- **easyseedlink** can't change streams after `run()`; reconnect on stream-set
  change (debounced) + TCP reachability probe so blocked upstreams fail fast.
- Event-waveform server cache key must include component (Z/R/T) + nStations.
- Auth: `TREMIOM_TOKEN` env → whole-app cookie gate + sign-in form; unset = open.

## Default dashboard (v0.4.7)
Drum full row; then pairs: spectrogram|spectrum, psd|ppsd, sta-lta|rsam,
raw-scope|three-comp, particle-motion|hv. No markdown/clipboard/network/qc by
default (available via + Panel).

## Feature status
Superset of surveyed tools' live-monitoring + single-event analysis — see
`COMPETITIVE.md`. 15 panels, response removal/units, filters, History mode +
local files, picking/auto-pick/locate, ML/Md, beachballs, DYFI+ShakeMap,
multi-dashboard (CRUD/PDF/JSON), alerts, built-in per-panel help.
**Deliberately NOT built** (documented): FK/array (no arrays in data), receiver
functions, cross-correlation, full auto-association pipeline, Mb/Ms/Mw.

## Docs to keep current
README.md (features + description), ARCHITECTURE.md, COMPETITIVE.md,
THIRD_PARTY_LICENSES.md, SECURITY.md. CONTRIBUTING = no PRs (auto-closed).
