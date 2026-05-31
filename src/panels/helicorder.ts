import type { PanelDef } from './registry';

/** Helicorder — the classic drum-recorder display. One row per minute (or
 *  configurable interval), traces drawn left-to-right with time wrapping
 *  down the rows. v0.1 just shows the latest N seconds as a single trace
 *  until the server hands us proper paginated rows. */
export const helicorder: PanelDef = {
  id: 'helicorder',
  label: 'Helicorder',
  category: 'live',
  serverWorker: 'panels.helicorder',
  render(ctx, canvas, frame) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    const f = frame as { data?: number[] } | null;
    if (!f?.data?.length) {
      drawPlaceholder(ctx, w, h, 'waiting for frames…');
      return;
    }

    const data = f.data;
    let min = Infinity, max = -Infinity;
    for (const v of data) { if (v < min) min = v; if (v > max) max = v; }
    const span = Math.max(1e-9, max - min);

    ctx.strokeStyle = '#ff8c1a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((data[i] - min) / span) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};

function drawPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}
