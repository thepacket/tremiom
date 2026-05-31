# Tremiom — Competitive Analysis vs. 17 Reference Tools

Scope: feature gaps and differentiators for Tremiom v0.1.3 (web-based real-time + historical seismic viewer) measured against the popular seismology software ecosystem. Engineering tone, no marketing.

---

## 1. Per-tool inventory

### Desktop / heavyweight ops

**1. Swarm (USGS / VDAP)** — Java desktop app for real-time + historical waveform display and volcano monitoring. The single closest analogue to Tremiom in scope.
- Helicorder view with click-to-zoom into wave panels; configurable bar range, clip threshold; screenshot button.
- Four wave-view types: standard scope, spectra (FFT), spectrogram, particle motion.
- **Wave Clipboard**: multi-trace workbench; duration markers convert to Coda markers on copy.
- **RSAM viewer** with 10 s / 1 min / 10 min periods and bin sizes from minute to year.
- Full-screen **kiosk monitor mode** for live ops.
- Map view with hypocenters overlaid; connects to Earthworm/Winston wave servers, SeedLink, FDSN, files.
- Screenshots: [USGS gallery](https://www.usgs.gov/media/images/swarm-screenshot) · [Swarm v3 PDF manual](https://volcanoes.usgs.gov/software/swarm/doc/swarm_v3.pdf) · [docs](https://volcanoes.usgs.gov/software/swarm/documentation.shtml)

**2. SeisComP (gempa/GEOFON)** — Production-grade processing pipeline + Qt analyst GUIs. The de-facto standard at national networks.
- **scrttv**: real-time multi-trace viewer with spectrograms, mini phase associator + manual locator, station enable/disable, QC overlays.
- **scolv**: origin locator with phase picks, arrival residuals, hypocenter with uncertainties, magnitude estimation, focal mechanisms.
- **scmv**: map view with stations, trigger status, ground motion, station QC, bathymetry, plate/fault overlays.
- **scqcv**: quality-control viewer with latency, gaps, clock drift, RMS.
- Full pipeline: acquisition, picker (scautopick), associator (scautoloc), magnitude, alert dispatch.
- Screenshots: [scolv docs](https://www.seiscomp.de/doc/apps/scolv.html) · [scmv docs](https://www.seiscomp.de/doc/apps/scmv.html) · [scrttv docs](https://www.seiscomp.de/doc/apps/scrttv.html) · [scolv example](https://www.researchgate.net/figure/Screenshot-of-the-SeisComP-Origin-Locator-View-scolv-interactive-tool-for-the-Mw77_fig12_379627352)

**3. Earthworm (ISTI/USGS)** — Modular C/Tcl real-time processing system; the plumbing under many networks.
- `wave_serverV`: circular ring-buffer wave server.
- `wave_viewer`: GUI client to one wave_server; trigger-file navigation; jump-to-time.
- Picker, associator (binder), locator (eqproc), Carl-trigger, hyp2000 hooks.
- ASCII configs; modules talk via shared-memory rings.
- Screenshots: [wave_viewer overview](https://folkworm.ceri.memphis.edu/ew-doc/ovr/wave_viewer_ovr.html) · [Earthworm docs](http://www.earthwormcentral.org/)

**4. Antelope (BRTT, commercial)** — Datascope database + analyst tools, widely used by USArray.
- **dbpick / traceview**: trace browser with arrivals, detections, predicted arrivals, residuals, interactive arrival editing, first-motion picking.
- **dbloc2 / dbloc**: interactive event locator with chooseable algorithm (dbgenloc) + TauP/iasp91 travel times.
- Real-time orb messaging; magnitude, MT, alarm modules.
- Screenshots: [4.7 release notes](http://m.brtt.com/release/4.7/release_notes.html) · [Antelope guide PDF](https://nappe.wustl.edu/antelope/docs/Arizona-docs/Antelope_guide-Arizona.pdf)

**5. SeisGram2K (Alomax)** — Java single-app seismogram viewer with strong picking/analysis pedagogy use.
- Time/amplitude picking, horizontal component rotation, animated 3-D particle motion.
- Time-domain integration/differentiation, frequency-domain filtering, instrument response removal.
- Interactive spectrum + spectrogram windows aligned to trace.
- Theoretical phase arrival overlay (TauP-style).
- Screenshots: [SeisGram2K v7 help](http://alomax.free.fr/seisgram/ver70/SeisGram2KHelp.html) · [home](http://alomax.free.fr/seisgram/SeisGram2K.html) · [v5 frame](http://alomax.free.fr/seisgram/ver53/SeisGram2K_main_frame.html)

### Analysis / Python ecosystem

**6. Snuffler (Pyrocko, GFZ)** — Python/Qt seismogram workbench, scriptable via "snufflings" plugins.
- Multi-trace browser with marker system (Marker, EventMarker, PhaseMarker) for picks.
- Live remote-data streaming, large-dataset support, keystroke-driven UX.
- Spectrogram snuffling: window length, overlap, taper (Hann/Hamming/Blackman/Bartlett), color scales (log/sqrt/lin).
- Plugin API: catalog integration, custom auto-pickers, beam-forming, polarization.
- Screenshots: [Snuffler manual](https://pyrocko.org/docs/current/apps/snuffler/manual.html) · [tutorial](https://pyrocko.org/docs/current/apps/snuffler/tutorial.html)

**7. ObsPy** — Python library (not a GUI), but the canonical analysis toolkit; informs what every other tool's "advanced" tab should do.
- Read/write MiniSEED, SAC, SEGY, GSE2, etc.; FDSN client; SeedLink client.
- Filters (Butterworth, bandstop), instrument response removal with water-level deconvolution, rotate ZNE↔LQT.
- PPSD (McNamara/Buland), spectrogram, beam-forming, STA/LTA, AR-pick, polarization, cross-correlation, TauP.
- Inventory metadata handling with time-aware response.
- Docs: [PPSD](https://docs.obspy.org/packages/autogen/obspy.signal.spectral_estimation.PPSD.html) · [tutorial PDF](https://docs.obspy.org/archive/1.2.0/_downloads/ObsPyTutorial.pdf)

**8. PQLX / PQL (PASSCAL/IRIS)** — Station-QC focused; the "data manager's" tool.
- **Trace Viewer** (= PQL): browse traces, filter, compute spectra.
- **PDF Viewer**: PPSD/PDF plots over user-defined windows backed by MySQL.
- **Station Viewer**: trace statistics, PDF thumbnails, available-data calendar.
- Built for daily review of 400+ TA/Backbone stations for gaps, dead channels, clock issues.
- Screenshots: [PQLX product page](https://ds.iris.edu/ds/nodes/dmc/software/downloads/pqlx/) · [PQLX manual PDF](https://pubs.usgs.gov/of/2010/1292/pdf/OF10-1292.pdf)

### Web-based / browser

**9. IRIS Wilber 3** — Browser tool for event-based bulk waveform requests.
- Event search via FDSN webservice: quick yearly datasets, custom queries on date/magnitude/depth/region; up to 10000 events.
- Color-coded event map (magnitude + depth).
- Station picker with map and table, distance/azimuth filters, channel selectors.
- Time-window definition relative to phase arrivals; output as MiniSEED/SAC bundle.
- Screenshots: [Wilber 3 app](https://ds.iris.edu/wilber3/find_event)

**10. IRIS Quake Browser / Seismon / IEB** — Catalog explorers.
- **Seismon**: world map updated every 30 min; click region to see 24 h / 15 d / 5 y events.
- **IEB**: query millions of epicenters by mag/depth/time/box; 2-D map with plate boundaries; up to 5000 in 3-D rotatable view; CSV export; sortable table.
- Screenshots: [Seismon](https://ds.iris.edu/seismon/) · [IEB](https://ds.iris.edu/ieb/) · [Station Monitor](https://www.iris.edu/app/station_monitor/)

**11. GEOFON event browser** — GFZ Potsdam earthquake list + per-event detail pages.
- Real-time event list with GEVN contributions.
- Per-event page: epicenter map, **moment tensor solutions** (body + surface wave inversion), focal mechanism beachballs, magnitude history, station list.
- Screenshots: [eqinfo list](https://geofon.gfz-potsdam.de/eqinfo/list.php) · [MT list mode](https://geofon.gfz-potsdam.de/old/eqinfo/list.php?mode=mt) · [event example](https://geofon.gfz.de/old/eqinfo/event.php?id=gfz2025jffc)

**12. GeoNet (NZ)** — National-network public site; pedagogically excellent.
- **Earthquake Drums**: previous 4 h × all national stations, rendered north→south; red trace = malfunction; very simple UX.
- Volcano drums (per-volcano stacked stations).
- Quake list with severity filters (weak/moderate/severe), shaking-intensity reports, felt-by-you button.
- Quake search: temporal/spatial/depth/magnitude query, multiple output formats, interactive map.
- Screenshots: [drums page](https://www.geonet.org.nz/earthquake/drums) · [about drums](https://www.geonet.org.nz/about/earthquake/drums) · [Quake Search](https://quakesearch.geonet.org.nz/)

**13. Heliviewer / institutional helicorder galleries** — Static-image webicorders.
- USGS GSN heliplots; SCEDC, BSL Berkeley, NCEDC, AVO (Alaska Volcano Observatory), Lamont, NMT galleries.
- 24-hour PNG drums regenerated on schedule (5–15 min); no interactivity beyond browsing.
- Screenshots: [GSN heliplots](https://earthquake.usgs.gov/monitoring/operations/heliplot.php?virtual_network=GSN) · [AVO webicorders](https://avo.alaska.edu/webicorders/) · [USGS real-time seismograms](https://earthquake.usgs.gov/monitoring/seismograms)

**14. "SeisGard" / similar new browser tools** — No tool by that exact name found in the timeframe. Closest contemporary equivalents: IRIS Seismic Waves Viewer (3-D wave propagation animation), IRIS Global Seismogram Viewer (per-event multi-station record-section in browser).
- Screenshots: [Seismic Waves Viewer](https://www.iris.edu/hq/inclass/software-web-app/seismic_waves_viewer) · [Global Seismogram Viewer](https://www.iris.edu/hq/inclass/software-web-app/global_seismogram_viewer)

### Citizen / Raspberry Shake / mobile

**15. Raspberry Shake StationView + DataView** — The strongest direct competitor in the browser real-time category.
- **StationView**: global map of all live Shakes + recent quakes; click station for details and recent traces; event list.
- **DataView**: per-station deep-dive in the browser; three modes: Live Stream, Helicorder (24 h), Compare Data; supports geophone Z/H, accelerometer, infrasound channels; filtering and frequency-domain analysis; spectrogram for any channel/time; processing options include RMS and amplitude clipping for drum compression.
- Screenshots: [StationView](https://stationview.raspberryshake.org/) · [DataView app](https://dataview.raspberryshake.org/) · [DataView release post](https://raspberryshake.org/dataview-official-release/) · [new StationView post](https://raspberryshake.org/the-new-stationview/)

**16. EMSC LastQuake (web + mobile)** — Citizen-oriented event firehose.
- Real-time earthquake list with felt-report integration: comments, photos, videos by eyewitnesses; testimonies map alongside felt map.
- Push notifications: destructive quakes, near-you alerts, customizable thresholds.
- SMS "I'm safe" service for impacted regions.
- Native iOS/Android apps; web mirror at m.emsc.eu.
- Screenshots: [LastQuake page](https://m.emsc-csem.org/lastquake/information_channels/lastquake_app/) · [EMSC mobile web](https://m.emsc.eu/)

**17. PyWEED (IRIS)** — Cross-platform PyQt/ObsPy desktop event+station picker for bulk download.
- Map-based event selection + station selection; preview waveforms before save.
- Phase-arrival-relative time-window definition.
- Downloads MiniSEED/SAC with metadata for instrument correction.
- Screenshots: [User Guide](https://iris-edu.github.io/pyweed/UserGuide/) · [About](https://iris-edu.github.io/pyweed/) · [GitHub](https://github.com/iris-edu/pyweed)

---

## 2. Feature matrix

Legend: `✓` full, `~` partial/limited, `✗` absent, `—` not applicable. Columns: Sw=Swarm, SC=SeisComP, EW=Earthworm, An=Antelope, SG=SeisGram2K, Sn=Snuffler, OP=ObsPy, PQ=PQLX, Wi=Wilber3, IR=IRIS Quake Browser, GF=GEOFON, GN=GeoNet, He=Heliviewer galleries, SX=SeisGard/Seismic Waves Viewer, RS=Raspberry Shake SV/DV, EM=EMSC LastQuake, PW=PyWEED, **Tr=Tremiom today**.

| Feature | Sw | SC | EW | An | SG | Sn | OP | PQ | Wi | IR | GF | GN | He | SX | RS | EM | PW | **Tr** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 24-h helicorder drum | ✓ | ~ | ~ | ~ | ✗ | ✗ | ~ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | **✓** |
| Drum event arrival markers | ~ | ✓ | ~ | ✓ | ✗ | ✓ | ~ | ✗ | ✗ | ✗ | ✗ | ~ | ~ | ✗ | ~ | ✗ | ✗ | **✓** |
| Multi-station drum overview | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ~ | ✗ | ✗ | **✗** |
| Live waveform scope | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | **✓** |
| Spectrogram | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | **✓** |
| FFT / spectrum panel | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | **~** |
| PSD (Welch) | ✗ | ✓ | ✗ | ✓ | ~ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~ | ✗ | ✗ | **✓** |
| PPSD (McNamara) | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| STA/LTA trigger panel | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| RSAM panel | ✓ | ~ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| Manual phase picker | ~ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| Auto picker (AR / STA/LTA) | ~ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **~** |
| Event locator | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| Magnitude estimation | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| Focal mechanism / beachball | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| Instrument response removal | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | **✗** |
| Wood-Anderson / displacement sim | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| 3-component scope (ZNE) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | **✗** |
| Particle motion / hodogram | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| Polarization analysis | ✗ | ✓ | ✗ | ✓ | ~ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| Filter ladder / cascading bandpass | ~ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~ | ✗ | ✗ | **~** |
| Bandpass presets | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | **✓** |
| World event map | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ~ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | **✓** |
| Station map | ✓ | ✓ | ✗ | ✓ | ✗ | ~ | ~ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✗ | ✓ | ✗ | ✓ | **✓** |
| Station search / picker | ✓ | ✓ | ✗ | ✓ | ✗ | ~ | ✓ | ✓ | ✓ | ~ | ~ | ~ | ✗ | ✗ | ✓ | ✗ | ✓ | **✓** |
| USGS / FDSN event feed | ✓ | ✓ | ~ | ✓ | ✗ | ~ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | **✓** |
| Per-event record section | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | **✓** |
| TauP arrival overlay | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | **✓** |
| Moment tensor / MT view | ✗ | ✓ | ✗ | ✓ | ✗ | ~ | ✓ | ✗ | ✗ | ✗ | ✓ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** |
| Station QC dashboard (gaps, latency) | ✗ | ✓ | ✓ | ✓ | ✗ | ~ | ✓ | ✓ | ✗ | ✗ | ✗ | ~ | ✗ | ✗ | ~ | ✗ | ✗ | **✗** |
| Felt-reports overlay | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | **✗** |
| Mobile-responsive UI | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~ | ~ | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | ✗ | **✗** |
| Native mobile app | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | **✗** |
| Alerts / named triggers | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | **✗** |
| Recording / replay / export window | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ~ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | **✗** |
| Multi-station live overlay | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ~ | ✗ | ✗ | **✗** |
| Wave clipboard / workbench | ✓ | ~ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~ | ✗ | ✓ | **✗** |
| Kiosk / fullscreen monitor mode | ✓ | ✓ | ~ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ~ | ✗ | ✗ | **~** |
| Server-side DSP uniform across panels | ✗ | ~ | ✗ | ✗ | ✗ | ✗ | — | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~ | ✗ | ✗ | **✓** |
| One-token / browser-only deploy | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | **✓** |
| Drum + sidebar + map synced UI | ✗ | ~ | ✗ | ~ | ✗ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~ | ✗ | ✗ | **✓** |

---

## 3. Gap list — prioritized

Ordered by impact for a seismology audience. "Effort" assumes Tremiom's existing stack (Python worker, ObsPy, scipy, WS multiplexer, Vite/TS frontend, DrumHistory buckets).

1. **3-component (Z/N/E) scope and spectrogram** — Single-channel-only is the biggest analyst-credibility gap. Competitors: Swarm, SeisComP, SeisGram2K, Snuffler, ObsPy, PQLX, RS DataView, Antelope, Earthworm. **Effort: Medium.** Subscribe to BH1/BH2 or BHN/BHE alongside BHZ in the worker; extend panel layouts to optionally stack 3 traces; reuse existing filter+STA/LTA paths.

2. **Particle motion / hodogram panel** — Standard tool for visualizing P/S/Rayleigh polarization; trivial once 3-C is wired. Competitors: Swarm, SeisGram2K, Snuffler, ObsPy. **Effort: Easy** (after 3-C).

3. **Instrument response removal + Wood-Anderson / displacement / velocity / acceleration toggle** — Required for any quantitative work; today's drum/scope show raw counts. Competitors: SeisComP, Antelope, Earthworm, SeisGram2K, Snuffler, ObsPy, PQLX. **Effort: Medium.** ObsPy `attach_response` + `remove_response`, cache StationXML per station; expose as a topbar select alongside the bandpass dropdown.

4. **PPSD (probabilistic PSD)** — The single most-asked-for noise/QC plot. Competitors: SeisComP (scqcv), PQLX, ObsPy, Snuffler, Antelope. **Effort: Easy.** ObsPy `PPSD` class consumes the existing trace stream; render as heatmap with NLNM/NHNM overlays.

5. **Manual phase picker with persisted markers** — Step from "viewer" to "tool." Competitors: SeisComP, Antelope, SeisGram2K, Snuffler, Earthworm, ObsPy. **Effort: Medium.** Click-to-place P/S markers on scope/drum/record-section, store in a session-scoped catalog (server-side SQLite), export as QuakeML or CSV.

6. **Multi-station live overlay / mini-network drum** — GeoNet drums + Swarm wave clipboard semantics in one panel. Competitors: Swarm, SeisComP, GeoNet, Earthworm, Antelope, Snuffler. **Effort: Medium.** Reuse DrumHistory + subscription multiplexing; add a "Group" UI on top of the curated GSN list.

7. **Recording / replay / export of arbitrary windows** — Click-drag on the drum → download MiniSEED / PNG / WAV. Competitors: everyone except the read-only galleries. **Effort: Easy.** Wire FDSN dataselect on demand; reuse existing FDSN backfill code.

8. **RSAM panel (10 s / 1 min / 10 min bins)** — Volcanologist-favourite continuous-amplitude tracker. Competitors: Swarm, Earthworm, Antelope, ObsPy. **Effort: Easy.** Already have envelope buckets in DrumHistory — just resample and plot.

9. **Station QC dashboard (gaps, latency, clock drift, daily RMS)** — Operator-grade visibility; differentiator for network owners. Competitors: SeisComP scqcv, PQLX, Antelope, Earthworm. **Effort: Medium.** Per-station heartbeat already exists in worker; surface gap/latency/RMS metrics.

10. **Event locator** — Even a single-event TauP-based grid-search using selected picks. Competitors: SeisComP, Antelope, Earthworm, Snuffler, ObsPy. **Effort: Hard.** Needs picker (#5) first, plus velocity model handling.

11. **Felt-reports overlay on event detail** — Trivial USGS DYFI / EMSC felt-report integration. Competitors: GeoNet, EMSC LastQuake, GEOFON. **Effort: Easy.** USGS DYFI API exists; render polygons on the world map.

12. **Focal mechanism beachballs on event markers** — Pull from USGS/GEOFON MT feeds. Competitors: GEOFON, GeoNet, SeisComP, Antelope. **Effort: Easy** (rendering only — USGS event JSON includes MT when available; ObsPy has `beachball`).

13. **Mobile-responsive layout** — Currently desktop only. Competitors: GeoNet, EMSC, RS StationView, GEOFON. **Effort: Medium.** CSS/layout work; collapse 4-panel grid to single-panel carousel below ~600 px.

14. **Wave clipboard / multi-trace workbench** — Pin traces from different stations/times to a scratch panel for comparison. Competitors: Swarm, Antelope, Snuffler, ObsPy, PyWEED. **Effort: Medium.**

15. **Alerts / named triggers (push or email)** — STA/LTA already runs server-side; expose persisted threshold rules. Competitors: SeisComP, Earthworm, Antelope, EMSC. **Effort: Medium** (mostly auth+notification plumbing, not DSP).

16. **PyWEED-style bulk event-station downloader** — One-shot record-section export for a region/time. Competitors: PyWEED, Wilber 3. **Effort: Easy** (mostly UI on top of existing FDSN code).

17. **Magnitude estimation per pick set** — Once response removal + picker land, ML/Mb/Mw is small. Competitors: SeisComP, Antelope, Earthworm, ObsPy. **Effort: Medium.**

---

## 4. Things Tremiom already does that almost no one else does well

- **Synchronized drum + spectrogram + STA/LTA + PSD + world map + event sidebar in one screen, all live**. Swarm gets close on desktop but never in a browser; RS DataView only does single-panel-at-a-time.
- **Server-side Butterworth (sosfiltfilt) applied uniformly across all time-domain panels and the spectrogram** from a single dropdown. Most tools force per-panel filter configuration; Tremiom guarantees panel consistency by construction.
- **Event arrival markers projected onto the drum at the predicted P time** (magnitude-colored dot + tick). Snuffler and SeisComP show markers, but tying them to the 24-h drum row position is unusual.
- **24-h FDSN backfill on subscribe** — drum is "full" the instant a user lands. Most live viewers start empty and fill over hours.
- **Browser-only, single-token deploy** (~220 MB Docker image, one-click fly.io). All true-comparable real-time tools are Java desktop apps; the only browser competitors (RS DataView, GeoNet drums) lack analysis depth.
- **One Python worker hosting SeedLink + ring buffers + DrumHistory + FDSN backfill** — simpler ops than Earthworm's module-soup or SeisComP's full pipeline.
- **TauP overlays on a per-event record section, fetched on demand from FDSN with curated 6-nearest selection** — Wilber 3 + Global Seismogram Viewer can produce something similar but require manual station selection and a request workflow.
- **Curated GSN broadband list combined with full-IRIS station search + AM/Shake** in the same picker. Nobody else mixes the curated/explore model this cleanly.

---

## 5. Recommended next 5–10 features

In order of recommended build sequence; each chosen for ratio of (impact to seismology audience) ÷ (effort given current stack).

1. **3-component (Z/N/E) subscription + panel layout** — Unblocks particle motion, polarization, rotation, 3-C spectrograms, hodograms. Single biggest credibility step.
2. **Instrument response removal + units toggle (counts / velocity / displacement / Wood-Anderson)** — Moves Tremiom from "pretty viewer" to "analysis tool." ObsPy already in the stack; mostly StationXML caching and a topbar select.
3. **PPSD panel with NLNM/NHNM overlays** — Highest-value QC view; pure ObsPy; visible payoff for station operators.
4. **Particle motion panel** — Cheap once #1 lands; instant visual win for teaching/marketing.
5. **RSAM panel** — Reuses DrumHistory envelopes; brings in the volcano-monitoring audience that Swarm owns.
6. **Click-drag-to-export on the drum (MiniSEED + PNG)** — Lowest-effort, highest-frequency feature request a real user will have within minutes.
7. **Manual phase picker with QuakeML export** — Foundation for future locator/magnitude work; differentiates from every browser tool.
8. **Felt-reports + focal-mechanism overlay on the world map** — Free data from USGS/GEOFON; closes the citizen-science gap vs. LastQuake/GeoNet/GEOFON with one API integration.
9. **Multi-station live overlay (a "Drum group")** — Matches GeoNet's strongest UX while keeping Tremiom's per-row analysis depth.
10. **Mobile-responsive layout** — Last because the analyst use case is desktop, but the citizen-science audience expects it; one good CSS pass.

---

> **Note on this snapshot.** Analysis written against **v0.1.3**. Items
> #1 (3-component subscription) and #4 (particle motion hodogram) of
> the recommendation list landed in **v0.1.5** — see that commit for
> details. The matrix's "Tremiom" column has not been re-graded; the
> gap list and recommendations still drive the post-v0.1.5 roadmap from
> #2 onward (instrument response removal, PPSD, RSAM, click-drag
> export, picker, felt-reports + beachballs, multi-station drum,
> mobile).

