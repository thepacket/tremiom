/** Station search modal — queries /api/stations/search (the IRIS FDSN
 *  station-service proxy) and lets the user pick any station the IRIS
 *  catalog knows about, beyond the 15 curated GSN presets. */

export interface SearchedStation {
  nslc: string;
  lat: number;
  lon: number;
  sensor: string;
  sr: number;
}

interface SearchResponse {
  stations: SearchedStation[];
  count?: number;
  note?: string;
}

/** Common global networks to seed the dropdown. */
const NETWORK_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'IU,II,US,G,GE,IV,AU,NZ,CN,CI,IM', label: 'All global broadbands (default)' },
  { value: 'IU', label: 'IU — IRIS/USGS GSN' },
  { value: 'II', label: 'II — IRIS/IDA GSN' },
  { value: 'US', label: 'US — USGS National Network' },
  { value: 'G',  label: 'G — GEOSCOPE (France)' },
  { value: 'GE', label: 'GE — GEOFON (Germany)' },
  { value: 'IV', label: 'IV — INGV (Italy)' },
  { value: 'AU', label: 'AU — Australia' },
  { value: 'NZ', label: 'NZ — GeoNet New Zealand' },
  { value: 'CN', label: 'CN — Canada' },
  { value: 'CI', label: 'CI — Caltech / SoCal' },
  { value: 'IM', label: 'IM — IMS (CTBTO)' },
  { value: 'TA', label: 'TA — USArray Transportable' },
  { value: 'AM', label: 'AM — Raspberry Shake citizen seismometers' },
  { value: '*',  label: 'All networks' },
];

const CHANNEL_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'BHZ,HHZ', label: 'BHZ + HHZ — broadband Z (default)' },
  { value: 'BHZ',     label: 'BHZ — broadband Z (20 sps)' },
  { value: 'HHZ',     label: 'HHZ — high-rate Z (100+ sps)' },
  { value: 'LHZ',     label: 'LHZ — long-period Z (1 sps)' },
  { value: 'BH?',     label: 'BH? — broadband all components' },
  { value: 'HH?',     label: 'HH? — high-rate all components' },
  { value: 'SHZ,EHZ', label: 'SHZ + EHZ — short-period Z (Shake)' },
];

export function openStationSearch(
  initialQuery: { lat?: number; lon?: number } | null,
  onPick: (nslc: string, hit?: SearchedStation) => void,
): void {
  // Backdrop + modal shell.
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal station-search">
      <header>
        <span class="title">Browse stations</span>
        <button class="modal-close" title="Close">✕</button>
      </header>
      <div class="search-controls">
        <label>Network
          <select class="net">${
            NETWORK_PRESETS.map((n) =>
              `<option value="${n.value}">${n.label}</option>`).join('')
          }</select>
        </label>
        <label>Channel
          <select class="cha">${
            CHANNEL_PRESETS.map((c) =>
              `<option value="${c.value}">${c.label}</option>`).join('')
          }</select>
        </label>
        <label class="radius-block">
          Within
          <input type="number" class="radius" value="" placeholder="(any)" min="1" max="180" step="1" />
          ° of
          <input type="number" class="lat" value="" placeholder="lat" step="0.01" />
          ,
          <input type="number" class="lon" value="" placeholder="lon" step="0.01" />
        </label>
        <label class="active-block">
          <input type="checkbox" class="active" checked /> Only currently-active stations
        </label>
        <button class="search-go">Search</button>
      </div>
      <div class="status muted">choose filters and press Search</div>
      <ul class="results"></ul>
    </div>
  `;
  document.body.appendChild(backdrop);

  const $ = (sel: string) => backdrop.querySelector(sel) as HTMLElement;
  const $i = (sel: string) => backdrop.querySelector(sel) as HTMLInputElement;
  const $s = (sel: string) => backdrop.querySelector(sel) as HTMLSelectElement;

  const status = $('.status');
  const results = $('.results') as HTMLUListElement;
  let currentHits: SearchedStation[] = [];

  // Pre-fill radius search if the caller provided a lat/lon (e.g. from a
  // selected event).
  if (initialQuery?.lat != null && initialQuery?.lon != null) {
    $i('.lat').value = initialQuery.lat.toFixed(2);
    $i('.lon').value = initialQuery.lon.toFixed(2);
    $i('.radius').value = '20';
  }

  function close() { backdrop.remove(); }
  backdrop.querySelector('.modal-close')!.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  async function search() {
    const network = $s('.net').value;
    const channel = $s('.cha').value;
    const active  = $i('.active').checked;
    const radius  = $i('.radius').value.trim();
    const lat     = $i('.lat').value.trim();
    const lon     = $i('.lon').value.trim();
    const params = new URLSearchParams({ network, channel, active: String(active) });
    if (radius && lat && lon) {
      params.set('maxradius', radius);
      params.set('lat', lat);
      params.set('lon', lon);
    }
    status.textContent = 'searching…';
    results.innerHTML = '';
    try {
      const r = await fetch(`/api/stations/search?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json() as SearchResponse;
      if (!j.stations.length) {
        status.textContent = j.note ? `no matches (${j.note})` : 'no matches';
        return;
      }
      status.textContent = `${j.count ?? j.stations.length} stations`;
      currentHits = j.stations;
      results.innerHTML = j.stations.map((s) => `
        <li class="hit" data-nslc="${s.nslc}">
          <span class="nslc">${s.nslc}</span>
          <span class="meta">
            <span>${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}</span>
            <span>${s.sr ? s.sr + ' Hz' : '—'}</span>
            <span class="sensor">${escapeHtml(s.sensor || '')}</span>
          </span>
        </li>
      `).join('');
    } catch (e) {
      status.textContent = `search failed: ${(e as Error).message}`;
    }
  }

  results.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('.hit') as HTMLElement | null;
    if (!li) return;
    const nslc = li.dataset.nslc!;
    // Pass the full hit (with lat/lon) so the caller can cache station
    // coords for downstream overlays (drum event markers, etc.).
    const idx = Array.from(results.children).indexOf(li);
    const hit = currentHits[idx];
    onPick(nslc, hit);
    close();
  });

  backdrop.querySelector('.search-go')!.addEventListener('click', () => void search());
  void search();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}
