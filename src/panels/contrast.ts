/** Contrast-limited histogram equalization for spectrogram heat-maps.
 *
 *  A linear min..max (or percentile) stretch maps dB values straight onto
 *  the colormap. That wastes most of the colormap when the value
 *  histogram is lopsided — which is the normal case for seismic PSD: a
 *  dense, narrow noise floor plus a sparse tail of energetic bins. The
 *  noise floor ends up as one flat colour and real structure stays
 *  washed out.
 *
 *  Histogram equalization instead maps each value through the cumulative
 *  distribution function (CDF), so the colormap spends its range in
 *  proportion to how many cells actually sit there — pulling apart the
 *  crowded noise floor and revealing detail. The "contrast-limited"
 *  refinement (à la CLAHE) caps each histogram bin before building the
 *  CDF and redistributes the excess, so a single dominant bin (the noise
 *  floor) can't over-stretch and blow out the rest. */

export interface Equalizer {
  /** Map a value to [0,1] for colormap lookup. */
  norm(v: number): number;
  /** Trimmed value range actually mapped (for the dB readout). */
  lo: number;
  hi: number;
}

export interface EqualizeOpts {
  /** Number of CDF bins (resolution of the mapping). */
  bins?: number;
  /** Fraction trimmed from each tail before equalizing (outlier guard). */
  trim?: number;
  /** Per-bin cap as a multiple of the mean bin count; excess is spread
   *  uniformly. Lower = gentler (closer to a linear stretch), higher =
   *  more aggressive equalization. Infinity disables the limit. */
  clipLimit?: number;
}

const IDENTITY: Equalizer = { norm: () => 0.5, lo: -1, hi: 1 };

/** Build a histogram-equalized contrast mapping over a set of columns
 *  (each column is an array of values, e.g. dB per frequency bin). */
export function equalizeColumns(
  columns: ReadonlyArray<ArrayLike<number>>,
  opts: EqualizeOpts = {},
): Equalizer {
  const bins = opts.bins ?? 256;
  const trim = opts.trim ?? 0.02;
  const clipLimit = opts.clipLimit ?? 4;

  const colLen = columns[0]?.length ?? 0;
  const total = columns.length * colLen;
  if (!total) return IDENTITY;

  // Sub-sample to bound the sort + histogram work regardless of ring size.
  const stride = Math.max(1, Math.floor(total / 8192));
  const samples: number[] = [];
  let i = 0;
  for (const col of columns) {
    for (let b = 0; b < col.length; b++) {
      if (i++ % stride === 0) samples.push(col[b]);
    }
  }
  if (!samples.length) return IDENTITY;

  // Trimmed range — keeps a few extreme cells from defining the whole scale.
  samples.sort((a, b) => a - b);
  let lo = samples[Math.floor(samples.length * trim)];
  let hi = samples[Math.floor((samples.length - 1) * (1 - trim))];
  if (!(hi > lo)) { lo -= 0.5; hi += 0.5; }
  const span = hi - lo;

  // Histogram of the (clamped) subsample over [lo, hi].
  const hist = new Float64Array(bins);
  const scale = bins / span;
  for (const v of samples) {
    let bi = ((v - lo) * scale) | 0;
    if (bi < 0) bi = 0; else if (bi >= bins) bi = bins - 1;
    hist[bi]++;
  }

  // Contrast limit: cap each bin, redistribute the clipped excess evenly.
  if (Number.isFinite(clipLimit)) {
    const cap = clipLimit * (samples.length / bins);
    let excess = 0;
    for (let b = 0; b < bins; b++) {
      if (hist[b] > cap) { excess += hist[b] - cap; hist[b] = cap; }
    }
    const add = excess / bins;
    if (add > 0) for (let b = 0; b < bins; b++) hist[b] += add;
  }

  // CDF, normalized so the first populated level maps to 0 and the top to 1.
  const cdf = new Float64Array(bins);
  let acc = 0;
  for (let b = 0; b < bins; b++) { acc += hist[b]; cdf[b] = acc; }
  const cdfMin = cdf[0];
  const denom = Math.max(1e-9, acc - cdfMin);
  for (let b = 0; b < bins; b++) cdf[b] = (cdf[b] - cdfMin) / denom;

  return {
    lo,
    hi,
    norm(v: number): number {
      let bi = ((v - lo) * scale) | 0;
      if (bi < 0) bi = 0; else if (bi >= bins) bi = bins - 1;
      const n = cdf[bi];
      return n < 0 ? 0 : n > 1 ? 1 : n;
    },
  };
}
