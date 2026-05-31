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
    </header>
    <div class="rs-body">
      <canvas></canvas>
      <div class="rs-status muted">no event selected</div>
    </div>
  `;
  parent.appendChild(root);

  const canvas = root.querySelector('canvas') as HTMLCanvasElement;
  const info   = root.querySelector('.info')   as HTMLElement;
  const status = root.querySelector('.rs-status') as HTMLElement;
  const ctx = canvas.getContext('2d')!;

  let waveforms: EventWaveforms | null = null;
  let currentEvent: SeismicEvent | null = null;
  let token = 0; // race-guard for overlapping fetches

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

      // Right-side margin: a small "row scale" hint.
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
    });

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

  async function setEvent(e: SeismicEvent | null): Promise<void> {
    currentEvent = e;
    waveforms = null;
    if (!e) {
      info.textContent = '';
      setStatus('no event selected');
      draw();
      return;
    }
    info.textContent =
      `M${e.mag?.toFixed(1) ?? '?'} · ${e.place} · ${e.depthKm.toFixed(0)} km depth`;
    setStatus('fetching nearest stations + TauP arrivals…');
    draw();
    const myToken = ++token;
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
      } else if (w.errors?.length) {
        setStatus(`${w.stations.length} stations OK · ${w.errors.length} unavailable`, 'info');
      } else {
        setStatus(null);
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
