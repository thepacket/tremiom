/** Focal-mechanism "beachball" renderer. Given a nodal plane
 *  (strike, dip, rake in degrees), draws the lower-hemisphere
 *  equal-area projection of the P-wave radiation pattern: compressional
 *  quadrants filled, dilatational white. The standard at-a-glance
 *  depiction of an earthquake's faulting style.
 *
 *  Method: convert strike/dip/rake to a moment tensor (Aki & Richards
 *  1980 convention, x=North, y=East, z=Down), then for each pixel in
 *  the unit disk back-project through the equal-area (Lambert/Schmidt)
 *  projection to a ray direction and evaluate the P radiation
 *  u = γ·M·γ. Sign of u sets the color.
 */

function deg2rad(d: number): number { return (d * Math.PI) / 180; }

/** Moment tensor (6 unique components) in North-East-Down from SDR. */
function sdrToMT(strikeDeg: number, dipDeg: number, rakeDeg: number) {
  const s = deg2rad(strikeDeg), d = deg2rad(dipDeg), r = deg2rad(rakeDeg);
  const sin = Math.sin, cos = Math.cos;
  const sd = sin(d), cd = cos(d), sr = sin(r), cr = cos(r);
  const s2d = sin(2 * d), c2d = cos(2 * d);
  const ss = sin(s), cs = cos(s), s2s = sin(2 * s), c2s = cos(2 * s);

  // Aki & Richards (1980), eqns 4.83 — x=N, y=E, z=Down.
  const Mxx = -(sd * cr * s2s + s2d * sr * ss * ss);
  const Mxy =  (sd * cr * c2s + 0.5 * s2d * sr * s2s);
  const Mxz = -(cd * cr * cs + c2d * sr * ss);
  const Myy =  (sd * cr * s2s - s2d * sr * cs * cs);
  const Myz = -(cd * cr * ss - c2d * sr * cs);
  const Mzz =  (s2d * sr);
  return { Mxx, Mxy, Mxz, Myy, Myz, Mzz };
}

export function drawBeachball(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  strike: number, dip: number, rake: number,
  opts: { fill?: string; bg?: string; stroke?: string } = {},
) {
  const fill   = opts.fill   ?? '#cfd2d4';
  const bg     = opts.bg     ?? '#0d0d0d';
  const stroke = opts.stroke ?? '#3a4248';
  const M = sdrToMT(strike, dip, rake);

  // White background disk.
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // Per-pixel fill of compressional quadrants. radius is small (a panel
  // corner), so an O(r²) loop is cheap.
  const r2 = radius * radius;
  const img = ctx.getImageData(cx - radius, cy - radius, radius * 2, radius * 2);
  const data = img.data;
  const fillRGB = hexToRgb(fill);
  const W = radius * 2;
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const dx = px - radius + 0.5;
      const dy = py - radius + 0.5;
      const rr = dx * dx + dy * dy;
      if (rr > r2) continue; // outside disk
      // Equal-area (Schmidt) inverse: disk radius ρ∈[0,1] maps to
      // takeoff angle i (from vertical-down) via ρ = √2·sin(i/2).
      const rho = Math.sqrt(rr) / radius;
      const iAng = 2 * Math.asin(Math.min(1, rho / Math.SQRT2));
      // Azimuth: screen x=East, y=North(up). az measured from North,
      // clockwise (toward East).
      const az = Math.atan2(dx, -dy);
      const si = Math.sin(iAng), ci = Math.cos(iAng);
      // Ray direction γ in (N, E, Down). Lower hemisphere: down +.
      const gN = si * Math.cos(az);
      const gE = si * Math.sin(az);
      const gD = ci;
      // P radiation u = γ·M·γ.
      const u =
        M.Mxx * gN * gN + M.Myy * gE * gE + M.Mzz * gD * gD +
        2 * (M.Mxy * gN * gE + M.Mxz * gN * gD + M.Myz * gE * gD);
      if (u >= 0) {
        const o = (py * W + px) * 4;
        data[o] = fillRGB.r; data[o + 1] = fillRGB.g; data[o + 2] = fillRGB.b; data[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, cx - radius, cy - radius);

  // Outline.
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return { r: 207, g: 210, b: 212 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
