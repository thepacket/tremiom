import type { PanelDef } from './registry';
import { plotBounds } from './axes';

/** Station QC — operator-grade health readout for the current station:
 *  real-time data latency, 1-minute availability, buffer fill, recent
 *  RMS amplitude, sample rate. Each metric is color-coded green/yellow/
 *  red so a glance tells you whether the stream is healthy. */

interface QcFrame {
  sr: number;
  fillPct: number;
  latencyS: number | null;
  rms: number | null;
  availPct: number;
  bufferSecs: number;
}

export const qc: PanelDef = {
  id: 'qc',
  label: 'Station QC',
  category: 'live',
  serverWorker: 'panels.qc',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as QcFrame | null;
    if (!f) {
      ctx.fillStyle = '#8a8a8a';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('waiting for data…', w / 2, h / 2);
      return;
    }

    const pb = plotBounds(w, h);
    const rows: Array<{ label: string; value: string; color: string }> = [
      {
        label: 'Latency',
        value: f.latencyS == null ? '—' : `${f.latencyS.toFixed(1)} s`,
        color: f.latencyS == null ? '#888'
             : f.latencyS <= 15 ? '#7cb342' : f.latencyS <= 60 ? '#fdd835' : '#e53935',
      },
      {
        label: 'Availability (1 min)',
        value: `${f.availPct.toFixed(0)} %`,
        color: f.availPct >= 95 ? '#7cb342' : f.availPct >= 70 ? '#fdd835' : '#e53935',
      },
      {
        label: 'Buffer',
        value: `${f.bufferSecs.toFixed(0)} s (${f.fillPct.toFixed(0)} %)`,
        color: f.fillPct >= 50 ? '#7cb342' : f.fillPct >= 10 ? '#fdd835' : '#888',
      },
      {
        label: 'Sample rate',
        value: `${f.sr.toFixed(0)} Hz`,
        color: '#cfd2d4',
      },
      {
        label: 'RMS (1 min)',
        value: f.rms == null ? '—' : fmt(f.rms),
        color: '#cfd2d4',
      },
    ];

    const rowH = Math.min(38, pb.height / rows.length);
    const fontSize = Math.max(11, Math.min(16, rowH * 0.42));
    rows.forEach((r, i) => {
      const y = pb.top + rowH * (i + 0.5);
      ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#8a8a8a';
      ctx.textAlign = 'left';
      ctx.fillText(r.label, pb.left + 4, y);
      // Status dot.
      ctx.fillStyle = r.color;
      ctx.beginPath();
      ctx.arc(pb.right - 6, y, 4, 0, Math.PI * 2);
      ctx.fill();
      // Value.
      ctx.textAlign = 'right';
      ctx.fillStyle = r.color;
      ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillText(r.value, pb.right - 16, y);
    });
  },
};

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 10) return `${v.toFixed(0)}`;
  return `${v.toFixed(2)}`;
}
