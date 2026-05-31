/** Bandpass / lowpass / highpass filter presets for the topbar picker.
 *  The server applies these to the time-domain panels (raw scope,
 *  helicorder strip, STA/LTA) and the spectrogram. Drum + PSD stay
 *  unfiltered — drum is a 24-h overview, PSD is the spectrum itself. */

export type FilterKind = 'none' | 'bandpass' | 'lowpass' | 'highpass';

export interface FilterSpec {
  kind: FilterKind;
  low?:  number;  // Hz; meaning depends on kind
  high?: number;  // Hz
  label: string;  // dropdown label
}

export const FILTER_PRESETS: FilterSpec[] = [
  { kind: 'none',     label: 'Raw — no filter' },
  { kind: 'highpass', low: 0.01, label: 'DC removed (>0.01 Hz)' },
  { kind: 'bandpass', low: 1,    high: 20,  label: 'Local quake (1 – 20 Hz)' },
  { kind: 'bandpass', low: 0.5,  high: 5,   label: 'Regional (0.5 – 5 Hz)' },
  { kind: 'bandpass', low: 0.5,  high: 2,   label: 'Teleseismic body (0.5 – 2 Hz)' },
  { kind: 'bandpass', low: 0.05, high: 0.3, label: 'Microseism (0.05 – 0.3 Hz)' },
  { kind: 'bandpass', low: 0.02, high: 0.1, label: 'Surface waves (0.02 – 0.1 Hz)' },
  { kind: 'lowpass',  high: 1,   label: 'Slow signal (<1 Hz)' },
];

export const DEFAULT_FILTER: FilterSpec = FILTER_PRESETS[0];

/** Compact 1-line summary used in panel headers / status, e.g. "1–20 Hz". */
export function filterShortLabel(f: FilterSpec): string {
  if (f.kind === 'none') return 'raw';
  if (f.kind === 'bandpass') return `${f.low}–${f.high} Hz`;
  if (f.kind === 'lowpass')  return `< ${f.high} Hz`;
  if (f.kind === 'highpass') return `> ${f.low} Hz`;
  return f.label;
}
