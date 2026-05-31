/** Shared axis helpers for the panel canvases. All coordinates and
 *  drawing happen in CSS pixels — the ResizeObserver in mountPanel
 *  already applied the device-pixel-ratio transform.
 */

export const AXIS_PAD = { top: 6, right: 8, bottom: 14, left: 50 };
/** Horizontal position (CSS px) where the rotated Y-axis caption sits. */
export const Y_CAPTION_X = 8;
/** Right edge of tick labels — kept inside the padding with a clear gap
 *  from the caption to the left and the plot area to the right. */
export const Y_TICK_LABEL_RIGHT_OFFSET = 6; // labels end at left - this
export const COLOR_GRID  = '#1a2025';
export const COLOR_AXIS  = '#3a4248';
export const COLOR_LABEL = '#8a8a8a';

export function niceStep(span: number, targetTicks: number): number {
  if (span <= 0) return 1;
  const raw = span / Math.max(1, targetTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  const nice = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  return nice * pow;
}

/** Format an amplitude value compactly — engineering notation past ±1000. */
export function fmtAmp(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 10)  return `${v.toFixed(0)}`;
  if (a >= 1)   return `${v.toFixed(1)}`;
  return `${v.toFixed(2)}`;
}

/** Draw a Y-axis (amplitude or frequency) with grid lines and labels. */
export function drawYAxis(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  yMin: number, yMax: number,
  opts: { unit?: string; ticks?: number; format?: (v: number) => string } = {},
) {
  const { top, bottom, left, right } = AXIS_PAD;
  const plotW = Math.max(10, w - left - right);
  const plotH = Math.max(10, h - top - bottom);
  const span = Math.max(1e-9, yMax - yMin);
  const step = niceStep(span, opts.ticks ?? 4);
  const fmt = opts.format ?? fmtAmp;

  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';

  // textBaseline 'middle' centers labels on the tick y; without clamp,
  // a label at the very top/bottom of the plot extends past the frame
  // and gets clipped by the panel's overflow:hidden. Keep labels inside.
  const labelHalfHeight = 5;
  const yTopClamp    = top + labelHalfHeight;
  const yBottomClamp = top + plotH - labelHalfHeight;
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) {
    const y = top + ((yMax - v) / span) * plotH;
    ctx.strokeStyle = COLOR_GRID;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = COLOR_LABEL;
    ctx.textAlign = 'right';
    const labelY = Math.max(yTopClamp, Math.min(yBottomClamp, y));
    ctx.fillText(fmt(v), left - Y_TICK_LABEL_RIGHT_OFFSET, labelY);
  }

  if (opts.unit) drawYCaption(ctx, h, opts.unit);
}

/** Draw a rotated unit caption (e.g. "counts", "Hz", "dB") on the
 *  far-left side of the plot area. Kept far enough from the tick
 *  labels that they never touch. */
export function drawYCaption(
  ctx: CanvasRenderingContext2D, h: number, unit: string,
) {
  const { top, bottom } = AXIS_PAD;
  const plotH = Math.max(10, h - top - bottom);
  ctx.save();
  ctx.translate(Y_CAPTION_X, top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = COLOR_LABEL;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(unit, 0, 0);
  ctx.restore();
}

/** Draw an X-axis with seconds-back tick labels (0 at the right edge,
 *  negative seconds going left). Used by helicorder + raw scope where
 *  the right edge is "now". */
export function drawTimeAxisSecondsBack(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  totalSeconds: number,
  opts: { ticks?: number } = {},
) {
  const { top, bottom, left, right } = AXIS_PAD;
  const plotW = Math.max(10, w - left - right);
  const plotH = Math.max(10, h - top - bottom);
  const step = niceStep(totalSeconds, opts.ticks ?? 5);

  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR_LABEL;

  // Ticks at 0, -step, -2*step, ... ≥ -totalSeconds.
  for (let sBack = 0; sBack <= totalSeconds + 1e-9; sBack += step) {
    const x = left + plotW - (sBack / totalSeconds) * plotW;
    ctx.strokeStyle = COLOR_GRID;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + plotH);
    ctx.stroke();
    const label = sBack === 0 ? 'now' : `-${sBack.toFixed(sBack < 10 && step < 1 ? 1 : 0)}s`;
    ctx.fillStyle = COLOR_LABEL;
    ctx.fillText(label, x, top + plotH + 2);
  }
}

/** Frame the plot area with a faint border. */
export function drawFrame(
  ctx: CanvasRenderingContext2D, w: number, h: number,
) {
  const { top, bottom, left, right } = AXIS_PAD;
  ctx.strokeStyle = COLOR_AXIS;
  ctx.lineWidth = 1;
  ctx.strokeRect(left, top, w - left - right, h - top - bottom);
}

/** Map a "seconds back from now" value to a canvas X coordinate. */
export function xForSecondsBack(
  w: number, totalSeconds: number, sBack: number,
): number {
  const { left, right } = AXIS_PAD;
  const plotW = Math.max(10, w - left - right);
  return left + plotW - (sBack / totalSeconds) * plotW;
}

/** The plot area bounds in CSS pixels. */
export function plotBounds(w: number, h: number) {
  const { top, bottom, left, right } = AXIS_PAD;
  return {
    left, top,
    right: w - right, bottom: h - bottom,
    width:  Math.max(10, w - left - right),
    height: Math.max(10, h - top  - bottom),
  };
}
