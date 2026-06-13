/** Integrated help overlay — educational reference. A ? topbar button (or
 *  the ? on any panel header) opens it. Organized into three sections,
 *  mirroring the sibling Quantiom app's docs:
 *    • Introduction  — what Tremiom is, the three modes, the topbar controls.
 *    • Tutorial      — a hands-on, numbered getting-started walkthrough.
 *    • Panel Reference — a teaching entry for every panel (what it is + the
 *      physics, how to read it, how to use it).
 *  Content lives here, in one place. */

import { APP_VERSION } from '../version';

/** Per-panel teaching content. Keyed by panel registry id (+ "markdown"). */
interface PanelHelp { id: string; title: string; what: string; read: string; use: string; }

export const PANEL_HELP: PanelHelp[] = [
  {
    id: 'drum', title: 'Helicorder (24-hour drum)',
    what: `The classic drum-recorder view: a full day of one station's ground motion,
      wrapped into rows of one hour each — the same picture a paper helicorder
      pen would trace. Tremiom backfills the last 24 h from the data archive the
      moment you select a station, then appends live.`,
    read: `Time runs left→right within each row and top→bottom down the rows; the
      left axis labels each row's start hour (UTC). Amplitude is auto-scaled per
      row, so a quiet hour and a loud hour are both legible. Colored dots mark the
      predicted arrival time of catalog earthquakes at this station (color = magnitude).`,
    use: `Glance at a full day at once: teleseisms appear as fat spindles lasting
      minutes, local quakes as sharp short bursts, and cultural/ocean noise as the
      slowly breathing background thickness. Rising background through the day is the
      diurnal human-noise cycle. Match a surprising burst to a dot to identify it.`,
  },
  {
    id: 'rsam', title: 'RSAM (Real-time Seismic Amplitude)',
    what: `Real-time Seismic Amplitude Measurement: the mean absolute ground motion
      averaged into fixed time bins (1 minute) over 24 h. It throws away waveform
      detail and keeps just "how much is shaking", which is exactly what you want
      for tracking sustained energy.`,
    read: `A filled trend line: height = average shaking in each minute, time on X
      (UTC). Spikes are individual events; the baseline is ambient noise.`,
    use: `The volcano-monitoring workhorse. Watch the baseline: a slow, sustained
      rise over minutes-to-hours signals volcanic tremor or an eruption onset that
      no single event on the drum would reveal. Also good for spotting storms
      (microseism rises) and instrument problems (flatlines or steps).`,
  },
  {
    id: 'spectrogram', title: 'Spectrogram',
    what: `A sliding time–frequency picture: how the signal's energy is distributed
      across frequencies, and how that changes through time. Computed by a moving
      short-time Fourier transform.`,
    read: `X = time (newest at the right), Y = frequency in Hz, color = power in dB
      (brighter = stronger). Horizontal streaks are steady tones (often instrumental
      or cultural); vertical smears are transients (an arrival hits all frequencies
      at once).`,
    use: `Tell signal types apart by their frequency fingerprint: local quakes are
      broadband and high-frequency, distant quakes are low-frequency, ocean
      microseism sits around 0.1–0.3 Hz. Apply the topbar filter and watch bands
      appear/disappear. Spot monochromatic interference as a persistent horizontal line.`,
  },
  {
    id: 'spectrum', title: 'Spectrum (FFT)',
    what: `The instantaneous amplitude spectrum — a single live snapshot of how much
      energy sits at each frequency right now (the seismic equivalent of an audio
      spectrum analyzer).`,
    read: `X = frequency (Hz), Y = amplitude in dB. The bright line is the current
      spectrum; the dim trailing line is a slowly-decaying peak-hold so brief spectral
      spikes stay visible for a moment.`,
    use: `Identify discrete tones (peaks) — calibration pulses, electrical hum,
      resonances — and confirm a filter band is doing what you expect. For
      distribution/averaging over time use PSD/PPSD instead; this one is for "what's
      happening this second".`,
  },
  {
    id: 'psd', title: 'PSD (Power Spectral Density)',
    what: `Power spectral density via Welch's method: the signal's power per unit
      frequency, averaged over a window to suppress noise. The standard way to
      quantify how much energy lives at each frequency.`,
    read: `X = frequency on a log axis, Y = power in dB. Smoother and more stable than
      the raw FFT spectrum because of the averaging.`,
    use: `Characterize the station's spectral shape and noise level. Compare bands
      (microseism vs body-wave vs high-frequency) quantitatively. For the full
      probabilistic picture across many windows, see PPSD.`,
  },
  {
    id: 'ppsd', title: 'PPSD (Probabilistic PSD)',
    what: `Probabilistic Power Spectral Density (McNamara & Buland): instead of one
      PSD curve, it accumulates a 2-D histogram of PSD over many windows, showing the
      probability of each power level at each frequency. The definitive station-noise
      / quality plot.`,
    read: `X = frequency (log), Y = power in dB, color = how often that power occurred
      (the probability density). A bright band traced across frequency is the
      station's typical noise; the spread shows its variability. The bright yellow
      line is the most recent single PSD.`,
    use: `Assess station health and siting: where the noise band sits relative to
      global low/high noise models tells you if the site is quiet or noisy and in
      which bands. Spikes, gaps, or a band that drifts up over time flag sensor or
      telemetry problems. Give it several minutes to build up.`,
  },
  {
    id: 'sta-lta', title: 'STA/LTA trigger',
    what: `The classic automatic event detector: the ratio of a Short-Term Average of
      the signal envelope to a Long-Term Average. It rises when energy arrives faster
      than the slow background can follow.`,
    read: `X = time (seconds back), Y = the ratio. The dashed line is the trigger
      threshold; periods above it are shaded red (a "detection"). A flat line near 1
      means quiet.`,
    use: `Watch for the ratio to spike above the threshold — that's an arrival. Pair
      it with the 🔔 alerts button to get a notification when it fires. Tune the idea
      mentally: short windows catch crisp local P arrivals, the threshold trades
      sensitivity against false alarms from noise bursts.`,
  },
  {
    id: 'raw-scope', title: 'Raw scope',
    what: `A plain rolling window of the most recent waveform — the unprocessed (or
      filtered/response-removed, per the topbar) ground motion as a time series.`,
    read: `X = time (seconds back from now), Y = amplitude in the current units
      (counts, or m/s etc. if you've removed the response).`,
    use: `The "what does the signal actually look like" panel. Use the units toggle to
      see real ground velocity/displacement, and the filter to isolate a band. Good
      for eyeballing waveform character and confirming an arrival's shape.`,
  },
  {
    id: 'three-comp', title: '3-component (Z / N / E)',
    what: `All three sensor components stacked: vertical (Z) plus the two horizontals
      (N/E, or 1/2 on unoriented sensors). Ground motion is 3-D, and the split between
      vertical and horizontal energy identifies the wave type.`,
    read: `Three lanes sharing one time axis, each auto-scaled. Z on top, horizontals
      below.`,
    use: `Read wave type: P waves are compressional and show strongly on the vertical;
      S and Love/Rayleigh surface waves dominate the horizontals and arrive later.
      The relative timing and amplitude across components is the basis for picking and
      for the particle-motion and H/V panels.`,
  },
  {
    id: 'particle-motion', title: 'Particle motion (hodogram)',
    what: `A hodogram: plots the two horizontal components against each other so you
      see the actual path the ground particle traces in the horizontal plane, rather
      than two separate time series.`,
    read: `A 2-D trajectory inside a circle (N up, E right). The trace fades from gray
      (older) to orange (newest); the dot is "now". The plot is square so angles are
      true.`,
    use: `Identify polarization: a near-linear back-and-forth line means the motion is
      aligned to one azimuth — typically a P arrival pointing back toward the source.
      Elliptical or circular loops indicate S waves and Rayleigh surface waves. The
      line's orientation estimates the direction to the earthquake.`,
  },
  {
    id: 'hv', title: 'H/V spectral ratio (Nakamura)',
    what: `The horizontal-to-vertical spectral ratio of ambient noise — a cheap,
      single-station estimate of site response (how the local soil column amplifies
      shaking).`,
    read: `X = frequency (log), Y = the H/V ratio. The dashed line at 1 is "no
      amplification". A clear yellow peak (f₀) marks the resonance frequency.`,
    use: `Read the peak frequency f₀: soft, thick sediments resonate at low frequency
      (a fraction of a Hz), thin/stiff sites at higher frequency, and hard rock shows
      no peak (flat near 1). f₀ relates to sediment depth and is a key input to
      microzonation and building-resonance hazard.`,
  },
  {
    id: 'network', title: 'Network overview',
    what: `A multi-station RSAM panel: one amplitude row per station in your group, so
      you watch a whole network at once (the observatory wall-display view).`,
    read: `Each row is a station's recent mean-amplitude trend, stacked for comparison.`,
    use: `Spot which stations are active and whether an energy increase is local to one
      site (instrument issue or nearby source) or shared across the network (a real,
      widespread signal like a teleseism or regional storm).`,
  },
  {
    id: 'qc', title: 'Station QC',
    what: `Operator-grade health metrics for the live stream: data gaps, latency, and
      amplitude/RMS — the things you check before trusting the data.`,
    read: `Compact status readouts/series per metric.`,
    use: `Confirm the station is delivering complete, timely data. Growing latency or
      frequent gaps mean telemetry trouble; a daily RMS that's flat-zero or railed
      means a dead or clipped sensor.`,
  },
  {
    id: 'clipboard', title: 'Wave clipboard',
    what: `A scratch panel holding trace snapshots you've pinned (📌 Pin), so you can
      compare waveforms from different stations or times side by side.`,
    read: `Each pinned snapshot is drawn as its own labeled trace.`,
    use: `Pin a trace now, switch station or time, pin another, and compare — useful for
      checking whether a feature appears on multiple stations, or comparing an event
      against a quiet reference window.`,
  },
  {
    id: 'markdown', title: 'Note (markdown)',
    what: `An editable markdown panel for annotations — observations, an event log, a
      to-do list — saved with the dashboard. Add as many as you like via the
      <b>Notes</b> entry in the PANELS picker.`,
    read: `Rendered markdown; click ✎ in its header to edit, click again to render.`,
    use: `Keep context next to the data: note what you were watching, flag an event for
      follow-up, or write a shift handover. Notes travel with the dashboard when you
      export it to JSON.`,
  },
];

interface HelpSection { id: string; title: string; html: string; }

const SECTIONS: HelpSection[] = [
  {
    id: 'intro', title: 'Introduction',
    html: `
      <p><b>Tremiom</b> is a real-time + historical seismic viewer. It streams
      live waveforms from global broadband stations, runs scientific DSP
      server-side, and lets you browse, analyze, and pick earthquakes — all in
      the browser, with no install and no account.</p>

      <h3>Three modes</h3>
      <ul>
        <li><b>Live</b> (default) — the configurable dashboard of panels for the
          selected station, updating ~1/s.</li>
        <li><b>Event</b> — click any earthquake in the sidebar or map to open a
          record section of the nearest stations with predicted arrivals.</li>
        <li><b>History</b> — pull any station over any time window and
          zoom / pan / step through it; also opens local MiniSEED/SAC files.</li>
      </ul>

      <h3>Topbar controls</h3>
      <table class="help-table">
        <tr><td><b>station</b></td><td>Pick a curated GSN station, type any
          <code>NET.STA.LOC.CHA</code>, or <b>Browse…</b> the full FDSN catalog.</td></tr>
        <tr><td><b>filter</b></td><td>Server-side Butterworth band: raw, local quake
          (1–20 Hz), teleseismic (0.5–2 Hz), microseism, surface waves…</td></tr>
        <tr><td><b>units</b></td><td>Remove the instrument response: counts, velocity
          (m/s), displacement (m), acceleration, or Wood-Anderson (mm).</td></tr>
        <tr><td><b>PANELS</b></td><td>Add/remove panels (including <b>Notes</b> markdown);
          reset the layout.</td></tr>
        <tr><td><b>Dashboard ▾</b></td><td>Switch dashboards. <b>+</b> new, <b>✎</b>
          rename, <b>−</b> delete, <b>⤓ JSON / ⤒ Import</b> share, <b>⤓ PDF</b> print.</td></tr>
        <tr><td><b>📌 Pin</b></td><td>Snapshot the current trace into the Wave clipboard.</td></tr>
        <tr><td><b>🔔</b></td><td>STA/LTA trigger alerts: toggle + set a threshold;
          fires a notification + banner when crossed.</td></tr>
        <tr><td><b>History</b></td><td>Arbitrary-time waveform browser. <b>Live</b>
          returns.</td></tr>
        <tr><td><b>⚙</b></td><td>Settings: instance auth status, sign out.</td></tr>
      </table>

      <p class="help-hint">Tip: every panel has a <b>?</b> in its header that jumps
      straight to its entry in the Panel Reference section.</p>`,
  },
  {
    id: 'tutorial', title: 'Tutorial',
    html: `
      <p>A hands-on walkthrough. Work through it once with the default
      dashboard open and you'll know your way around.</p>

      <h3>1 · Pick a station and go live</h3>
      <p>Use the <b>station</b> picker in the topbar — choose a curated GSN
      station from the dropdown, or type any <code>NET.STA.LOC.CHA</code> (e.g.
      <code>IU.ANMO.00.BHZ</code>). The connection badge walks from
      <i>connecting…</i> to <i>live</i>; the first frame takes ~10–20 s while the
      SeedLink handshake completes, then the <b>Helicorder</b> backfills the last
      24 h and every panel starts updating ~1/s.</p>

      <h3>2 · Read the panels</h3>
      <p>The default dashboard pairs complementary views: the drum for a
      day-at-a-glance, spectrogram + spectrum for frequency content, PSD/PPSD for
      noise character, STA/LTA + RSAM for energy, and scope/3-component/particle
      motion for waveform shape. Click the <b>?</b> on any panel header to jump to
      its full entry in <b>Panel Reference</b> (what it is, how to read it, how to
      use it).</p>

      <h3>3 · Filter and change units</h3>
      <p>Set <b>filter</b> to a band (e.g. <i>local quake 1–20 Hz</i>) and watch
      the scope and spectrogram sharpen. Set <b>units</b> to <i>velocity (m/s)</i>
      to remove the instrument response and see real ground motion instead of raw
      counts.</p>

      <h3>4 · Customize the dashboard</h3>
      <p>Drag a panel by its <b>header</b> to move it; drag any edge or corner to
      resize. Use <b>PANELS</b> to add or remove panels — including the <b>Notes</b>
      markdown scratchpad. Layout autosaves per dashboard. Create more
      dashboards with the <b>Dashboard ▾</b> menu, and share one via <b>⤓ JSON</b>
      / <b>⤒ Import</b> or print it with <b>⤓ PDF</b>.</p>

      <h3>5 · Explore an earthquake (Event mode)</h3>
      <p>Click any event in the sidebar list or on the world map to open the
      <b>record section</b>: the 6 nearest stations' waveforms stacked by distance,
      with TauP-predicted <span style="color:#ffd54a">P</span> and
      <span style="color:#ff8a80">S</span> arrivals, the focal-mechanism beachball,
      an independent <b>ML</b> + <b>Md</b> estimate, and DYFI felt + ShakeMap
      overlays on the map.</p>
      <ul>
        <li><b>Z / R / T</b> — rotate horizontals to radial/transverse (radial
          carries P + Rayleigh, transverse carries SH + Love).</li>
        <li><b>Pick P / Pick S</b> — click a trace to place an arrival;
          <b>Auto-pick</b> detects P automatically. Picks persist and export to
          <b>QuakeML</b>.</li>
        <li><b>Locate</b> — grid-search the hypocenter from your P picks.</li>
        <li><b>⤓ MiniSEED / CSV / PNG</b> — export the data or the plot.</li>
      </ul>

      <h3>6 · Browse history and local files</h3>
      <p>Hit <b>History</b> for an arbitrary-time waveform browser: wheel =
      zoom at the cursor, drag = pan, <b>◀ ▶</b> step, a duration dropdown, and
      <b>Now</b> to jump to the latest. <b>📂 Open</b> loads a local MiniSEED/SAC
      file. <b>Live</b> returns to live mode.</p>

      <h3>7 · Set an alert</h3>
      <p>Click <b>🔔</b>, enable alerts, and set a threshold. When the STA/LTA
      ratio crosses it, Tremiom fires a browser notification and an in-app banner —
      a hands-off watch for arrivals while you do something else.</p>

      <p class="help-hint">Map tip: wheel = zoom, drag = pan, double-click =
      reset. Every plot panel has a <b>⤓</b> to save it as a PNG.</p>`,
  },
  {
    id: 'panels', title: 'Panel Reference',
    html: PANEL_HELP.map((p) => `
      <div class="help-panel" id="help-panel-${p.id}">
        <h3>${p.title}</h3>
        <p><span class="help-tag">What</span>${p.what}</p>
        <p><span class="help-tag">How to read it</span>${p.read}</p>
        <p><span class="help-tag">How to use it</span>${p.use}</p>
      </div>`).join(''),
  },
];

export function openHelp(targetPanelId?: string): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal help-modal">
      <header>
        <span class="title">Tremiom help <span class="muted">v${APP_VERSION}</span></span>
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

  const search = backdrop.querySelector('.help-search') as HTMLInputElement;
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    content.querySelectorAll('section').forEach((sec) => {
      const secEl = sec as HTMLElement;
      // Per-panel cards and table rows are the filterable units.
      const units = secEl.querySelectorAll('tr, .help-panel');
      if (!q) {
        secEl.style.display = '';
        units.forEach((u) => ((u as HTMLElement).style.display = ''));
        return;
      }
      let anyVisible = false;
      if (units.length) {
        units.forEach((u) => {
          const match = u.textContent!.toLowerCase().includes(q);
          (u as HTMLElement).style.display = match ? '' : 'none';
          if (match) anyVisible = true;
        });
      } else {
        anyVisible = secEl.textContent!.toLowerCase().includes(q);
      }
      secEl.style.display = anyVisible ? '' : 'none';
    });
  });

  // Deep-link: jump to a specific panel's entry and flash it.
  if (targetPanelId) {
    const el = backdrop.querySelector(`#help-panel-${targetPanelId}`) as HTMLElement | null;
    if (el) {
      requestAnimationFrame(() => {
        el.scrollIntoView({ block: 'center' });
        el.classList.add('help-flash');
        setTimeout(() => el.classList.remove('help-flash'), 1500);
      });
    }
  }
}
