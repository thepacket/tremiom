# Third-party licenses

Tremiom itself is licensed under the [MIT License](./LICENSE). It depends on,
and (for the server-side Python components) redistributes in its Docker image,
the third-party software listed below. Each remains under its own license; the
notices and obligations here are preserved as those licenses require.

This file is informational, not legal advice.

## Runtime — Python workers (bundled in the Docker image)

| Package | License | Notes |
|---|---|---|
| **ObsPy** | **LGPL-3.0** | SeedLink/FDSN clients, response removal, TauP, triggers, beachballs. Used unmodified, installed via `pip` as a separate process (`workers/*.py` are spawned subprocesses) — not linked into Tremiom. |
| NumPy | BSD-3-Clause | numerical arrays |
| SciPy | BSD-3-Clause | signal processing (Welch, Butterworth, …) |
| matplotlib | Matplotlib License (BSD-style, PSF-derived) | transitive via ObsPy |
| lxml | BSD-3-Clause | transitive via ObsPy (StationXML/QuakeML) |
| SQLAlchemy | MIT | transitive via ObsPy |
| requests | Apache-2.0 | transitive via ObsPy |
| certifi | MPL-2.0 | CA bundle; used unmodified |
| python-dateutil, six, etc. | Apache-2.0 / MIT / BSD | transitive |

### LGPL-3.0 (ObsPy) compliance

ObsPy is **LGPL-3.0**. Tremiom complies with it as follows:

- ObsPy is installed unmodified from PyPI and invoked as a standalone
  subprocess; it is **not** statically or dynamically linked into Tremiom's
  own code. Anyone may replace it with a different ObsPy build
  (`pip install obspy==<version>`) without changing Tremiom.
- ObsPy's source and license are publicly available at
  <https://github.com/obspy/obspy> (LGPL-3.0).
- Using an LGPL library this way does **not** place Tremiom's own MIT-licensed
  code under the LGPL/GPL.

## Runtime — Node / browser

| Package | License |
|---|---|
| ws | MIT |
| Natural Earth 1:110m land outlines (`src/data/coastlines.json`) | Public domain |

## Build / dev only (not shipped in the runtime image)

| Package | License |
|---|---|
| Vite | MIT |
| TypeScript | Apache-2.0 |
| vite-plugin-pwa | MIT |
| vite-plugin-mkcert | MIT |
| @types/ws | MIT |

## External services (accessed at runtime, not redistributed)

Tremiom fetches data from public services; their data and terms are their own:

- **IRIS / EarthScope** — SeedLink + FDSN web services
- **Raspberry Shake** — AM-network SeedLink + FDSN
- **USGS** — earthquake feeds, moment tensors, DYFI felt reports, ShakeMap

---

To regenerate the dependency list: `npm ls --prod` (Node) and
`workers/.venv/bin/pip list` (Python). License identifiers use SPDX where
applicable.
