/** Record section: stacked waveforms aligned by epicentral distance,
 *  with TauP-predicted P and S arrival times overlaid.
 *
 *  This is a click-driven "event mode" view, not a streaming panel —
 *  it consumes a one-shot EventWaveforms bundle from the server.
 */

import type { SeismicEvent } from '../data/events';
import {
  type EventWaveforms,
  fetchEventWaveforms,
} from '../data/event-waveforms';

const PADDING = { top: 24, right: 56, bottom: 28, left: 110 };
const COLOR_TRACE = '#7ad';
const COLOR_AXIS  = '#444';
const COLOR_GRID  = '#1a1a1a';
const COLOR_TEXT  = '#cfd2d4';
const COLOR_MUTED = '#8a8a8a';
const COLOR_P     = '#ffd54f';
const COLOR_S     = '#ff6e6e';

export interface RecordSectionHandle {
  setEvent(event: SeismicEvent | null): Promise<void>;
  destroy(): void;
}

export function mountRecordSection(parent: HTMLElement): RecordSectionHandle {
  const root = document.createElement('div');
  root.className = 'record-section';
  root.innerHTML = `
    <header>
      <span class="title">record section</span>
      <span class="muted info"></span>
      <canvas class="rs-beachball" width="48" height="48" title="Focal mechanism"></canvas>
      <span class="rs-pick hidden">
        <button class="rs-btn pick-btn" data-pick="P" title="Click a trace to place a P pick">Pick P</button>
        <button class="rs-btn pick-btn" data-pick="S" title="Click a trace to place an S pick">Pick S</button>
        <button class="rs-btn" data-pick="clear" title="Clear picks for this event">Clear</button>
        <button class="rs-btn" data-pick="locate" title="Relocate from P picks (needs ≥4)">Locate</button>
        <button class="rs-btn" data-pick="quakeml" title="Download picks as QuakeML">⤓ QuakeML</button>
      </span>
      <span class="rs-export hidden">
        <button class="rs-btn" data-fmt="mseed" title="Download full-resolution MiniSEED">⤓ MiniSEED</button>
        <button class="rs-btn" data-fmt="csv" title="Download decimated CSV">⤓ CSV</button>
        <button class="rs-btn" data-fmt="png" title="Save plot as PNG">⤓ PNG</button>
      </span>
    </header>
    <div class="rs-body">
      <canvas></canvas>
      <div class="rs-status muted">no event selected</div>
    </div>
  `;
  parent.appendChild(root);

  const canvas = root.querySelector('.rs-body canvas') as HTMLCanvasElement;
  const info   = root.querySelector('.info')   as HTMLElement;
  const status = root.querySelector('.rs-status') as HTMLElement;
  const bbCanvas = root.querySelector('.rs-beachball') as HTMLCanvasElement;
  const exportBar = root.querySelector('.rs-export') as HTMLElement;
  const ctx = canvas.getContext('2d')!;

  function triggerDownload(blob: Blob, name: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function exportData(fmt: string) {
    const e = currentEvent;
    if (!e) return;
    const stamp = e.id;
    if (fmt === 'png') {
      canvas.toBlob((b) => { if (b) triggerDownload(b, `tremiom_${stamp}_record-section.png`); }, 'image/png');
      return;
    }
    if (fmt === 'csv') {
      if (!waveforms?.stations.length) return;
      // One CSV per station would be cleaner, but a single wide file is
      // easier to hand off: columns = time_s_from_origin + one per station.
      const lines: string[] = [];
      lines.push('# tremiom event ' + e.id + ' M' + (e.mag ?? '?') + ' ' + e.place);
      lines.push('# columns: station, distKm, pArrivalS, sArrivalS, sr, t0Ms, samples...');
      for (const s of waveforms.stations) {
        lines.push([s.nslc, s.distKm.toFixed(1), s.pArrivalS ?? '', s.sArrivalS ?? '',
                    s.sr, s.t0Ms, ...s.data.map((v) => v.toFixed(3))].join(','));
      }
      triggerDownload(new Blob([lines.join('\n')], { type: 'text/csv' }),
                      `tremiom_${stamp}.csv`);
      return;
    }
    if (fmt === 'mseed') {
      const btn = exportBar.querySelector('[data-fmt="mseed"]') as HTMLButtonElement;
      const old = btn.textContent; btn.textContent = '⤓ fetching…'; btn.disabled = true;
      try {
        const r = await fetch('/api/event/export', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventId: e.id, lat: e.lat, lon: e.lon,
                                 depthKm: e.depthKm, timeMs: e.timeMs, nStations: 6 }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        triggerDownload(await r.blob(), `tremiom_${stamp}.mseed`);
      } catch (err) {
        setStatus(`MiniSEED export failed: ${(err as Error).message}`, 'error');
      } finally {
        btn.textContent = old; btn.disabled = false;
      }
    }
  }

  exportBar.querySelectorAll('.rs-btn').forEach((b) =>
    b.addEventListener('click', () => exportData((b as HTMLElement).dataset.fmt!)));

  const pickBar = root.querySelector('.rs-pick') as HTMLElement;
  function updatePickButtons() {
    pickBar.querySelectorAll('.pick-btn').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.pick === pickMode);
    });
  }
  pickBar.querySelectorAll('.rs-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const action = (b as HTMLElement).dataset.pick!;
      if (action === 'P' || action === 'S') {
        pickMode = pickMode === action ? 'off' : action;
        root.classList.toggle('picking', pickMode !== 'off');
        updatePickButtons();
      } else if (action === 'clear') {
        picks.clear();
        draw();
      } else if (action === 'locate') {
        void locateFromPicks();
      } else if (action === 'quakeml') {
        exportQuakeML();
      }
    }));

  // Click-to-pick: map pixel → (station row, time) via the captured layout.
  canvas.addEventListener('click', (ev) => {
    if (pickMode === 'off' || !lastLayout || !currentEvent) return;
    const L = lastLayout;
    const rect = canvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    if (cx < L.left || cx > L.left + L.innerW) return;
    if (cy < L.top || cy > L.top + L.innerH) return;
    const row = Math.floor((cy - L.top) / L.rowH);
    const st = L.stations[row];
    if (!st) return;
    const t = L.t0sec + ((cx - L.left) / L.innerW) * (L.t1sec - L.t0sec);
    const cur = picks.get(st.nslc) || {};
    cur[pickMode] = t;
    picks.set(st.nslc, cur);
    draw();
  });

  async function locateFromPicks() {
    if (!currentEvent || !waveforms) return;
    const e = currentEvent;
    // Build P picks with absolute time + station coords (from the
    // fetched waveform metadata).
    const coordByNslc = new Map(waveforms.stations.map((s) => [s.nslc, s]));
    const pPicks: Array<{ lat: number; lon: number; tMs: number }> = [];
    for (const [nslc, ps] of picks) {
      if (ps.P == null) continue;
      const st = coordByNslc.get(nslc);
      if (!st) continue;
      pPicks.push({ lat: st.lat, lon: st.lon, tMs: e.timeMs + ps.P * 1000 });
    }
    if (pPicks.length < 4) {
      setStatus(`need ≥4 P picks to locate (have ${pPicks.length})`, 'error');
      return;
    }
    setStatus('relocating from picks…');
    try {
      const r = await fetch('/api/event/locate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ picks: pPicks, priorLat: e.lat, priorLon: e.lon }),
      });
      const d = await r.json() as {
        ok?: boolean; error?: string; lat?: number; lon?: number;
        depthKm?: number; rmsSec?: number; n?: number;
      };
      if (!d.ok) { setStatus(`locate failed: ${d.error || 'unknown'}`, 'error'); return; }
      // Offset from the catalog location, as a quality cross-check.
      const offKm = greatCircleKm(e.lat, e.lon, d.lat!, d.lon!);
      setStatus(
        `tremiom location: ${d.lat!.toFixed(2)}°, ${d.lon!.toFixed(2)}°, ` +
        `${d.depthKm} km · RMS ${d.rmsSec}s · n=${d.n} · ${offKm.toFixed(0)} km from catalog`,
        'info');
    } catch (err) {
      setStatus(`locate failed: ${(err as Error).message}`, 'error');
    }
  }

  function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371, toRad = (x: number) => x * Math.PI / 180;
    const p1 = toRad(lat1), p2 = toRad(lat2);
    const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
    const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function exportQuakeML() {
    if (!currentEvent || !picks.size) {
      setStatus('no picks to export', 'error'); return;
    }
    const e = currentEvent;
    const originIso = new Date(e.timeMs).toISOString();
    const pickEls: string[] = [];
    let n = 0;
    for (const [nslc, ps] of picks) {
      const [net, sta, loc, cha] = nslc.split('.');
      for (const phase of ['P', 'S'] as const) {
        const tp = ps[phase];
        if (tp == null) continue;
        const tIso = new Date(e.timeMs + tp * 1000).toISOString();
        pickEls.push(
          `    <pick publicID="smi:tremiom/pick/${e.id}/${++n}">\n` +
          `      <time><value>${tIso}</value></time>\n` +
          `      <waveformID networkCode="${net}" stationCode="${sta}" ` +
          `locationCode="${loc}" channelCode="${cha}"/>\n` +
          `      <phaseHint>${phase}</phaseHint>\n` +
          `      <evaluationMode>manual</evaluationMode>\n` +
          `    </pick>`);
      }
    }
    const qml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<q:quakeml xmlns="http://quakeml.org/xmlns/bed/1.2" ` +
      `xmlns:q="http://quakeml.org/xmlns/quakeml/1.2">\n` +
      `  <eventParameters publicID="smi:tremiom/catalog/${e.id}">\n` +
      `    <event publicID="smi:tremiom/event/${e.id}">\n` +
      `      <description><text>${escapeXml(e.place)}</text></description>\n` +
      `      <origin publicID="smi:tremiom/origin/${e.id}">\n` +
      `        <time><value>${originIso}</value></time>\n` +
      `        <latitude><value>${e.lat}</value></latitude>\n` +
      `        <longitude><value>${e.lon}</value></longitude>\n` +
      `        <depth><value>${e.depthKm * 1000}</value></depth>\n` +
      `      </origin>\n` +
      (e.mag != null ? `      <magnitude publicID="smi:tremiom/mag/${e.id}">` +
        `<mag><value>${e.mag}</value></mag></magnitude>\n` : '') +
      `    </event>\n` +
      pickEls.join('\n') + '\n' +
      `  </eventParameters>\n</q:quakeml>\n`;
    triggerDownload(new Blob([qml], { type: 'application/xml' }),
                    `tremiom_${e.id}_picks.xml`);
  }

  function escapeXml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    } as Record<string, string>)[c]);
  }

  let waveforms: EventWaveforms | null = null;
  let currentEvent: SeismicEvent | null = null;
  let token = 0; // race-guard for overlapping fetches

  // Manual phase picks: per-station P/S times in seconds from origin.
  // Keyed by event id so picks survive switching events and back.
  type Picks = Map<string, { P?: number; S?: number }>;
  const picksByEvent = new Map<string, Picks>();
  let picks: Picks = new Map();
  let pickMode: 'off' | 'P' | 'S' = 'off';
  let lastLayout: {
    stations: EventWaveforms['stations']; t0sec: number; t1sec: number;
    left: number; top: number; innerW: number; innerH: number; rowH: number;
  } | null = null;

  const ro = new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width  = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  });
  ro.observe(canvas);

  function setStatus(msg: string | null, kind: 'info' | 'error' = 'info') {
    if (!msg) { status.style.display = 'none'; return; }
    status.style.display = 'block';
    status.textContent = msg;
    status.classList.toggle('error', kind === 'error');
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);
    if (!waveforms || !waveforms.stations.length) return;

    const stations = [...waveforms.stations].sort((a, b) => a.distKm - b.distKm);
    const [t0sec, t1sec] = waveforms.windowSecs;

    // Layout: plot area inside padding; one row per station.
    const innerW = Math.max(10, w - PADDING.left - PADDING.right);
    const innerH = Math.max(10, h - PADDING.top - PADDING.bottom);
    const rowH = innerH / stations.length;

    // Time axis (X): seconds from origin.
    function xForT(s: number): number {
      return PADDING.left + ((s - t0sec) / (t1sec - t0sec)) * innerW;
    }

    // Grid + axis lines.
    ctx.strokeStyle = COLOR_GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const tickStep = niceStep(t1sec - t0sec, 8);
    for (let s = Math.ceil(t0sec / tickStep) * tickStep; s <= t1sec; s += tickStep) {
      const x = xForT(s);
      ctx.moveTo(x, PADDING.top);
      ctx.lineTo(x, PADDING.top + innerH);
    }
    ctx.stroke();

    // Time axis labels.
    ctx.fillStyle = COLOR_MUTED;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = Math.ceil(t0sec / tickStep) * tickStep; s <= t1sec; s += tickStep) {
      ctx.fillText(`${s.toFixed(0)}s`, xForT(s), PADDING.top + innerH + 4);
    }
    // "from origin" caption.
    ctx.textAlign = 'right';
    ctx.fillText('s from origin', w - 4, PADDING.top + innerH + 4);

    // Per-station traces.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    stations.forEach((s, i) => {
      const yMid = PADDING.top + rowH * (i + 0.5);

      // Label (left axis).
      ctx.fillStyle = COLOR_TEXT;
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(s.nslc, PADDING.left - 8, yMid - 6);
      ctx.fillStyle = COLOR_MUTED;
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`${s.distKm.toFixed(0)} km · ${s.distDeg.toFixed(1)}°`,
                   PADDING.left - 8, yMid + 8);

      // Trace baseline.
      ctx.strokeStyle = COLOR_AXIS;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(PADDING.left, yMid);
      ctx.lineTo(PADDING.left + innerW, yMid);
      ctx.stroke();

      // Trace itself.
      const d = s.data;
      if (d.length > 0) {
        // Per-trace auto-scale so even quiet stations show up.
        let m = 1e-9;
        for (const v of d) { const a = Math.abs(v); if (a > m) m = a; }
        const ampScale = (rowH * 0.42) / m;

        // X mapping: trace starts at t0Ms (relative to origin).
        const traceStartS = (s.t0Ms - waveforms!.originTimeMs) / 1000;
        const dt = 1 / s.sr;

        ctx.strokeStyle = COLOR_TRACE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 0; k < d.length; k++) {
          const t = traceStartS + k * dt;
          if (t < t0sec || t > t1sec) continue;
          const x = xForT(t);
          const y = yMid - d[k] * ampScale;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // P / S arrival markers.
      const yTop = PADDING.top + rowH * i + 4;
      const yBot = PADDING.top + rowH * (i + 1) - 4;
      if (s.pArrivalS !== null && s.pArrivalS >= t0sec && s.pArrivalS <= t1sec) {
        const x = xForT(s.pArrivalS);
        ctx.strokeStyle = COLOR_P;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLOR_P;
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('P', x + 2, yTop);
      }
      if (s.sArrivalS !== null && s.sArrivalS >= t0sec && s.sArrivalS <= t1sec) {
        const x = xForT(s.sArrivalS);
        ctx.strokeStyle = COLOR_S;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLOR_S;
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('S', x + 2, yTop);
      }

      // Manual user picks for this station (drawn solid + bold).
      const userPick = picks.get(s.nslc);
      for (const phase of ['P', 'S'] as const) {
        const tp = userPick?.[phase];
        if (tp == null || tp < t0sec || tp > t1sec) continue;
        const x = xForT(tp);
        ctx.strokeStyle = phase === 'P' ? COLOR_P : COLOR_S;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
        ctx.fillStyle = phase === 'P' ? COLOR_P : COLOR_S;
        ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'right'; ctx.textBaseline = 'top';
        ctx.fillText(phase, x - 2, yTop);
      }

      // Right-side margin: a small "row scale" hint.
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
    });

    // Capture layout so the click handler can reverse-map pixel → (row, time).
    lastLayout = {
      stations, t0sec, t1sec,
      left: PADDING.left, top: PADDING.top, innerW, innerH, rowH,
    };

    // Origin time line (t=0).
    if (0 >= t0sec && 0 <= t1sec) {
      const x = xForT(0);
      ctx.strokeStyle = '#fff';
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PADDING.top);
      ctx.lineTo(x, PADDING.top + innerH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('origin', x + 2, PADDING.top - 4);
    }
  }

  function clearBeachball() {
    bbCanvas.style.display = 'none';
  }

  async function loadMechanism(e: SeismicEvent, myToken: number): Promise<void> {
    clearBeachball();
    try {
      const r = await fetch(`/api/event/detail?id=${encodeURIComponent(e.id)}`);
      if (!r.ok || myToken !== token || currentEvent?.id !== e.id) return;
      const d = await r.json() as {
        hasMechanism?: boolean; strike?: number; dip?: number; rake?: number;
      };
      if (!d.hasMechanism || myToken !== token || currentEvent?.id !== e.id) return;
      const bctx = bbCanvas.getContext('2d')!;
      const { drawBeachball } = await import('./beachball');
      drawBeachball(bctx, 24, 24, 22, d.strike!, d.dip!, d.rake!, {
        fill: '#e0533a', bg: '#0d0d0d', stroke: '#6a737b',
      });
      bbCanvas.title = `Focal mechanism — strike ${d.strike!.toFixed(0)}° dip ${d.dip!.toFixed(0)}° rake ${d.rake!.toFixed(0)}°`;
      bbCanvas.style.display = 'block';
    } catch { /* no mechanism / network blip — leave hidden */ }
  }

  async function loadMagnitude(e: SeismicEvent, myToken: number): Promise<void> {
    try {
      const r = await fetch('/api/event/magnitude', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: e.id, lat: e.lat, lon: e.lon,
                               depthKm: e.depthKm, timeMs: e.timeMs, nStations: 6 }),
      });
      if (!r.ok || myToken !== token || currentEvent?.id !== e.id) return;
      const d = await r.json() as { ml?: number | null; n?: number; spread?: number };
      if (myToken !== token || currentEvent?.id !== e.id) return;
      if (d.ml != null) {
        const base = `M${e.mag?.toFixed(1) ?? '?'} · ${e.place} · ${e.depthKm.toFixed(0)} km depth`;
        info.textContent = `${base}  ·  tremiom ML ${d.ml.toFixed(1)} (±${d.spread ?? 0}, n=${d.n})`;
      }
    } catch { /* magnitude unavailable — leave the catalog mag */ }
  }

  async function setEvent(e: SeismicEvent | null): Promise<void> {
    currentEvent = e;
    waveforms = null;
    clearBeachball();
    exportBar.classList.add('hidden');
    pickBar.classList.add('hidden');
    pickMode = 'off';
    updatePickButtons();
    if (!e) {
      info.textContent = '';
      setStatus('no event selected');
      draw();
      return;
    }
    // Restore (or create) this event's pick set.
    picks = picksByEvent.get(e.id) ?? new Map();
    picksByEvent.set(e.id, picks);
    info.textContent =
      `M${e.mag?.toFixed(1) ?? '?'} · ${e.place} · ${e.depthKm.toFixed(0)} km depth`;
    setStatus('fetching nearest stations + TauP arrivals…');
    draw();
    const myToken = ++token;
    void loadMechanism(e, myToken);
    void loadMagnitude(e, myToken);
    try {
      const w = await fetchEventWaveforms(e, { nStations: 6 });
      if (myToken !== token || currentEvent?.id !== e.id) return; // superseded
      waveforms = w;
      if (!w.stations.length) {
        const detail = w.errors?.length
          ? `\n${w.errors.map(e => `  ${e.nslc}: ${e.error}`).join('\n')}`
          : '';
        setStatus(`no waveforms returned (${w.errors?.length ?? 0} errors)${detail}`,
                  'error');
        exportBar.classList.add('hidden');
      } else if (w.errors?.length) {
        setStatus(`${w.stations.length} stations OK · ${w.errors.length} unavailable`, 'info');
        exportBar.classList.remove('hidden'); pickBar.classList.remove('hidden');
      } else {
        setStatus(null);
        exportBar.classList.remove('hidden'); pickBar.classList.remove('hidden');
      }
      draw();
    } catch (err) {
      if (myToken !== token) return;
      setStatus(`fetch failed: ${(err as Error).message}`, 'error');
    }
  }

  return {
    setEvent,
    destroy() {
      ro.disconnect();
      root.remove();
    },
  };
}

/** Pick a clean tick spacing for an axis of the given total span. */
function niceStep(span: number, targetTicks: number): number {
  const raw = span / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  const nice = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  return nice * pow;
}
