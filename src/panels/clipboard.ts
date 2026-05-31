import type { PanelDef } from './registry';
import { COLOR_LABEL, plotBounds, drawTimeAxisSecondsBack } from './axes';

/** Wave clipboard — a scratch workbench (à la Swarm). Pin the current
 *  station's live trace, switch station/time, pin another, and compare
 *  them stacked. Each pinned row is a frozen snapshot labelled with its
 *  station + capture time; each auto-scales independently.
 *
 *  Pins live in a module store fed by the topbar "📌 Pin" button (which
 *  captures the latest raw-scope frame for the current station). */

export interface PinnedTrace {
  id: number;
  station: string;
  capturedMs: number;
  windowS: number;
  unit: string;
  data: number[];
}

let nextId = 1;
const pinned: PinnedTrace[] = [];
const MAX_PINS = 8;

export function pinTrace(p: Omit<PinnedTrace, 'id'>): void {
  pinned.unshift({ ...p, id: nextId++ });
  if (pinned.length > MAX_PINS) pinned.length = MAX_PINS;
}
export function clearClipboard(): void { pinned.length = 0; }
export function removePin(id: number): void {
  const i = pinned.findIndex((p) => p.id === id);
  if (i >= 0) pinned.splice(i, 1);
}
export function pinnedCount(): number { return pinned.length; }

export const clipboard: PanelDef = {
  id: 'clipboard',
  label: 'Wave clipboard',
  category: 'live',
  serverWorker: 'panels.raw_scope',
  render(ctx, canvas, _frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    if (!pinned.length) {
      ctx.fillStyle = '#8a8a8a';
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('empty — use “📌 Pin” in the topbar to capture the current trace',
                   w / 2, h / 2);
      return;
    }

    const pb = plotBounds(w, h);
    const rowH = pb.height / pinned.length;
    const maxWin = Math.max(...pinned.map((p) => p.windowS), 1);

    pinned.forEach((p, i) => {
      const top = pb.top + i * rowH;
      const mid = top + rowH / 2;
      if (i > 0) {
        ctx.strokeStyle = '#161b1e';
        ctx.beginPath(); ctx.moveTo(pb.left, top); ctx.lineTo(pb.right, top); ctx.stroke();
      }
      // Symmetric auto-scale per row.
      let m = 0;
      for (const v of p.data) { const a = Math.abs(v); if (a > m) m = a; }
      if (m === 0) m = 1;
      const amp = (rowH * 0.40) / m;
      // Right-align each trace to the common time axis by its own window.
      const n = p.data.length;
      const x0frac = 1 - p.windowS / maxWin; // left inset if shorter window
      ctx.strokeStyle = '#7ad';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const x = pb.left + (x0frac + (1 - x0frac) * (k / (n - 1))) * pb.width;
        const y = mid - p.data[k] * amp;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // Label: station + capture time + unit.
      const tlabel = new Date(p.capturedMs).toUTCString().slice(17, 25);
      ctx.fillStyle = COLOR_LABEL;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`${p.station}  ${tlabel}Z  ±${fmt(m)} ${p.unit}`, pb.left + 3, top + 3);
    });

    drawTimeAxisSecondsBack(ctx, w, h, maxWin, { ticks: 5 });
    ctx.strokeStyle = '#3a4248';
    ctx.lineWidth = 1;
    ctx.strokeRect(pb.left, pb.top, pb.width, pb.height);
    ctx.fillStyle = '#cfd2d4';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(`${pinned.length} pinned`, pb.right - 4, pb.top + 2);
  },
};

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 10) return `${v.toFixed(0)}`;
  return `${v.toFixed(1)}`;
}
