/** Integrated help overlay. A single ? topbar button opens a searchable
 *  reference: what Tremiom is, the three modes, every topbar control, and
 *  every panel (what it shows + how to read it), plus interaction tips.
 *  Content lives here (not scattered across panel files) so it's one
 *  place to maintain. */

declare const __APP_VERSION__: string;

interface HelpSection { id: string; title: string; html: string; }

const SECTIONS: HelpSection[] = [
  {
    id: 'overview', title: 'Overview',
    html: `
      <p><b>Tremiom</b> is a real-time + historical seismic viewer. It streams
      live waveforms from global broadband stations, runs scientific DSP
      server-side, and lets you browse, analyze, and pick earthquakes — all
      in the browser.</p>
      <p>Three modes:</p>
      <ul>
        <li><b>Live</b> (default) — the configurable dashboard of panels for the
          selected station, updating ~1/s.</li>
        <li><b>Event</b> — click any earthquake in the sidebar or on the map to
          open a record section of the nearest stations with predicted arrivals.</li>
        <li><b>History</b> (🕓) — pull any station over any time window and
          zoom / pan / step through it; also opens local MiniSEED/SAC files.</li>
      </ul>`,
  },
  {
    id: 'topbar', title: 'Topbar controls',
    html: `
      <table class="help-table">
        <tr><td><b>station</b></td><td>Pick a curated GSN station, type any
          <code>NET.STA.LOC.CHA</code>, or <b>Browse…</b> the full FDSN catalog
          (network/channel/radius search).</td></tr>
        <tr><td><b>filter</b></td><td>Server-side Butterworth band: raw, local
          quake (1–20 Hz), teleseismic (0.5–2 Hz), microseism, surface waves, …
          Applied to the time-domain panels + spectrogram.</td></tr>
        <tr><td><b>units</b></td><td>Remove the instrument response: counts,
          velocity (m/s), displacement (m), acceleration, or Wood-Anderson (mm).</td></tr>
        <tr><td><b>+ Panel</b></td><td>Add/remove streaming panels; reset the
          layout to default.</td></tr>
        <tr><td><b>Dashboard ▾</b></td><td>Switch dashboards. <b>+</b> new,
          <b>✎</b> rename, <b>🗑</b> delete, <b>+ Notes</b> add a markdown panel,
          <b>⤓ JSON / ⤒ Import</b> share dashboards, <b>⤓ PDF</b> print.</td></tr>
        <tr><td><b>📌 Pin</b></td><td>Snapshot the current trace into the Wave
          clipboard panel for side-by-side comparison.</td></tr>
        <tr><td><b>🔔</b></td><td>STA/LTA trigger alerts: toggle on and set a
          threshold; fires a browser notification + banner when crossed.</td></tr>
        <tr><td><b>🕓 History</b></td><td>Enter the arbitrary-time waveform
          browser. <b>← Live</b> returns.</td></tr>
        <tr><td><b>⚙</b></td><td>Settings: instance auth status, sign out.</td></tr>
      </table>`,
  },
  {
    id: 'panels', title: 'Panels',
    html: `
      <table class="help-table">
        <tr><td><b>Helicorder</b></td><td>24-hour drum recorder — one row per
          hour. Colored dots mark predicted arrival times of catalog events.</td></tr>
        <tr><td><b>RSAM</b></td><td>Real-time Seismic Amplitude — mean |motion| in
          1-min bins over 24 h. A sustained rise flags tremor/eruption.</td></tr>
        <tr><td><b>Spectrogram</b></td><td>Sliding time-frequency heatmap (dB),
          newest at the right.</td></tr>
        <tr><td><b>Spectrum (FFT)</b></td><td>Live magnitude spectrum + a decaying
          peak-hold envelope.</td></tr>
        <tr><td><b>PSD / PPSD</b></td><td>Welch power spectral density; PPSD is the
          accumulating probability histogram (station noise character).</td></tr>
        <tr><td><b>STA/LTA</b></td><td>Short/long-term-average trigger ratio; the
          dashed line is the threshold, red shading = above it.</td></tr>
        <tr><td><b>Raw scope</b></td><td>Rolling raw waveform window.</td></tr>
        <tr><td><b>3-component</b></td><td>Z, N/1, E/2 stacked — read wave type from
          how energy splits vertical vs horizontal.</td></tr>
        <tr><td><b>Particle motion</b></td><td>Horizontal-motion hodogram; linear =
          P along the source azimuth, elliptical = S/surface.</td></tr>
        <tr><td><b>H/V ratio</b></td><td>Horizontal-to-vertical spectral ratio; the
          peak (f₀) is the site's resonance frequency.</td></tr>
        <tr><td><b>Network</b></td><td>Multi-station RSAM overview — one row per
          station in the group.</td></tr>
        <tr><td><b>Station QC</b></td><td>Gaps, latency, daily RMS — operator health
          metrics.</td></tr>
        <tr><td><b>Wave clipboard</b></td><td>Pinned trace snapshots for comparison.</td></tr>
        <tr><td><b>Notes</b></td><td>Editable markdown panel (✎ to edit). Add via
          <b>+ Notes</b>; many per dashboard.</td></tr>
      </table>`,
  },
  {
    id: 'event', title: 'Event mode',
    html: `
      <p>Click an event to open the <b>record section</b>: the 6 nearest stations'
      waveforms stacked by distance, with TauP-predicted P (yellow) and S (red)
      arrivals, the focal-mechanism beachball, an independent <b>ML</b> + <b>Md</b>
      estimate, and DYFI felt + ShakeMap overlays on the map.</p>
      <ul>
        <li><b>Z / R / T</b> — rotate horizontals to radial/transverse.</li>
        <li><b>Pick P / Pick S</b> — click a trace to place an arrival; <b>Auto-pick</b>
          detects P automatically. Picks persist and export to <b>QuakeML</b>.</li>
        <li><b>Locate</b> — grid-search the hypocenter from your P picks.</li>
        <li><b>⤓ MiniSEED / CSV / PNG</b> — export the data or plot.</li>
      </ul>`,
  },
  {
    id: 'tips', title: 'Interaction tips',
    html: `
      <ul>
        <li>Drag a panel by its <b>header</b> to move it; drag any edge/corner to
          resize. Layout autosaves per dashboard.</li>
        <li><b>World map</b>: wheel = zoom, drag = pan, double-click = reset. Click a
          station to switch, an event to open it.</li>
        <li><b>History</b>: wheel = zoom (at cursor), drag = pan, ◀ ▶ step,
          duration dropdown, Now jumps to latest. <b>📂 Open</b> loads a local file.</li>
        <li>Each plot panel has a <b>⤓</b> to save it as PNG.</li>
        <li>First live frame takes ~10–20 s (the SeedLink handshake) — the status
          text counts up while it waits.</li>
      </ul>`,
  },
];

export function openHelp(): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal help-modal">
      <header>
        <span class="title">Tremiom help <span class="muted">v${__APP_VERSION__}</span></span>
        <input class="help-search" type="search" placeholder="Filter help…" />
        <button class="modal-close" title="Close">✕</button>
      </header>
      <div class="help-body">
        <nav class="help-nav">
          ${SECTIONS.map((s) => `<button class="help-navlink" data-target="${s.id}">${s.title}</button>`).join('')}
        </nav>
        <div class="help-content">
          ${SECTIONS.map((s) => `<section id="help-${s.id}"><h2>${s.title}</h2>${s.html}</section>`).join('')}
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', esc); };
  function esc(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  backdrop.querySelector('.modal-close')!.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', esc);

  const content = backdrop.querySelector('.help-content') as HTMLElement;
  backdrop.querySelectorAll('.help-navlink').forEach((b) =>
    b.addEventListener('click', () => {
      const t = (b as HTMLElement).dataset.target!;
      backdrop.querySelector(`#help-${t}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

  // Live filter: hide sections (and rows) that don't match the query.
  const search = backdrop.querySelector('.help-search') as HTMLInputElement;
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    content.querySelectorAll('section').forEach((sec) => {
      const secEl = sec as HTMLElement;
      if (!q) {
        secEl.style.display = '';
        secEl.querySelectorAll('tr').forEach((r) => ((r as HTMLElement).style.display = ''));
        return;
      }
      let anyVisible = false;
      const rows = secEl.querySelectorAll('tr');
      if (rows.length) {
        rows.forEach((r) => {
          const match = r.textContent!.toLowerCase().includes(q);
          (r as HTMLElement).style.display = match ? '' : 'none';
          if (match) anyVisible = true;
        });
      } else {
        anyVisible = secEl.textContent!.toLowerCase().includes(q);
      }
      secEl.style.display = anyVisible ? '' : 'none';
    });
  });
}
