import type { PanelDef } from './registry';
import { COLOR_LABEL, plotBounds } from './axes';
import { DEFAULT_GROUP } from '../data/groups';

/** Network panel — a live multi-station overview. One row per group
 *  station showing its 24-h RSAM (mean-|amplitude|) as a sparkline plus
 *  the current level as a bar. This is the observatory "watch the whole
 *  network at once" view (GeoNet drums / Swarm monitor): a sustained
 *  rise on any row flags activity at that station.
 *
 *  Data arrives out-of-band via feedNetwork() — the app routes RSAM
 *  frames for *every* group station here (not just the globally-selected
 *  one), keyed by NSLC. */

interface RsamLike {
  startMs: number;
  binS: number;
  data: Array<number | null>;
}

const rows = new Map<string, RsamLike>();

export function feedNetwork(station: string, frame: RsamLike): void {
  rows.set(station, frame);
}
export function resetNetwork(): void { rows.clear(); }
export function networkGroup(): string[] { return DEFAULT_GROUP; }

export const network: PanelDef = {
  id: 'network',
  label: 'Network (multi-station RSAM)',
  category: 'live',
  serverWorker: 'panels.rsam',
  render(ctx, canvas, _frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const group = DEFAULT_GROUP;
    const pb = plotBounds(w, h);
    const labelW = 96;            // left gutter for station labels
    const barW = 56;              // right gutter for the current-level bar
    const sparkLeft = pb.left + labelW;
    const sparkRight = pb.right - barW - 8;
    const sparkW = Math.max(20, sparkRight - sparkLeft);
    const rowH = pb.height / group.length;

    // Shared amplitude scale across all rows so they're comparable:
    // max finite value over the whole group.
    let gMax = 0;
    for (const nslc of group) {
      const r = rows.get(nslc);
      if (!r) continue;
      for (const v of r.data) if (v != null && isFinite(v) && v > gMax) gMax = v;
    }
    if (gMax <= 0) gMax = 1;

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    group.forEach((nslc, i) => {
      const top = pb.top + i * rowH;
      const mid = top + rowH / 2;

      // Row separator.
      if (i > 0) {
        ctx.strokeStyle = '#161b1e';
        ctx.beginPath(); ctx.moveTo(pb.left, top); ctx.lineTo(pb.right, top); ctx.stroke();
      }

      // Station label (sta code only — compact).
      const sta = nslc.split('.')[1] || nslc;
      ctx.fillStyle = COLOR_LABEL;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(sta, pb.left + 2, mid);

      const r = rows.get(nslc);
      if (!r || !r.data.length) {
        ctx.fillStyle = '#555';
        ctx.textAlign = 'left';
        ctx.fillText('…', sparkLeft, mid);
        return;
      }

      // Sparkline of the 24-h RSAM, baseline at row bottom.
      const n = r.data.length;
      ctx.strokeStyle = '#ff8c1a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < n; k++) {
        const v = r.data[k];
        if (v == null || !isFinite(v)) { started = false; continue; }
        const x = sparkLeft + (k / (n - 1)) * sparkW;
        const y = top + rowH - 3 - (v / gMax) * (rowH - 6);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Current level (last finite bin) as a bar + value on the right.
      let cur = 0;
      for (let k = n - 1; k >= 0; k--) {
        const v = r.data[k];
        if (v != null && isFinite(v)) { cur = v; break; }
      }
      const frac = Math.min(1, cur / gMax);
      const bx = sparkRight + 8;
      ctx.fillStyle = barColor(frac);
      ctx.fillRect(bx, mid - 4, frac * barW, 8);
      ctx.strokeStyle = '#2a2a2a';
      ctx.strokeRect(bx, mid - 4, barW, 8);
    });

    // Frame + caption.
    ctx.strokeStyle = '#3a4248';
    ctx.lineWidth = 1;
    ctx.strokeRect(pb.left, pb.top, pb.width, pb.height);
    ctx.fillStyle = '#cfd2d4';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${group.length} stations · 24 h RSAM · shared scale`,
                 pb.right - 4, pb.top + 2);
  },
};

/** Green → yellow → red as the current level approaches the group max. */
function barColor(frac: number): string {
  if (frac >= 0.8) return '#e53935';
  if (frac >= 0.5) return '#fb8c00';
  if (frac >= 0.25) return '#fdd835';
  return '#7cb342';
}
