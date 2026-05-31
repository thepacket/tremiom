/** Perceptually-uniform colormap for spectrogram / PPSD heatmaps.
 *
 *  A simple 5-stop "viridis-like" gradient. Every equal step along the
 *  0…1 input produces a similarly-distinguishable color change — unlike
 *  the previous black-body ramp, which crammed half the range into
 *  shades of red and made low-contrast data look like a solid block.
 *
 *  Stops chosen to land near (in CIELAB terms): dark navy → blue →
 *  teal → green → yellow. Output is `rgb(r,g,b)`.
 */

const STOPS: Array<[number, number, number]> = [
  [ 68,   1,  84],  // 0.00 — dark purple
  [ 59,  82, 139],  // 0.25 — blue
  [ 33, 145, 140],  // 0.50 — teal
  [ 94, 201,  98],  // 0.75 — green
  [253, 231,  37],  // 1.00 — bright yellow
];

export function viridis(n: number): string {
  if (!isFinite(n)) return 'rgb(0,0,0)';
  if (n <= 0) return `rgb(${STOPS[0][0]},${STOPS[0][1]},${STOPS[0][2]})`;
  if (n >= 1) return `rgb(${STOPS[4][0]},${STOPS[4][1]},${STOPS[4][2]})`;
  const seg = n * (STOPS.length - 1);
  const lo = Math.floor(seg);
  const t = seg - lo;
  const a = STOPS[lo], b = STOPS[lo + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}
