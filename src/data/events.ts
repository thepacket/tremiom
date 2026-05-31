/** USGS earthquake feed types and helpers.
 *
 *  The USGS publishes static GeoJSON summary feeds that update at most
 *  once per minute. We proxy them through our Node server so the
 *  browser can poll without hitting USGS directly (CORS + caching).
 *
 *  Reference: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
 */

/** USGS naming: numeric magnitude thresholds are bare (`2.5_day`),
 *  not `M`-prefixed. `significant_*` and `all_*` use words. */
export const USGS_FEEDS = [
  // Last hour
  'significant_hour', '4.5_hour', '2.5_hour', '1.0_hour', 'all_hour',
  // Last day (default scope)
  'significant_day', '4.5_day', '2.5_day', '1.0_day', 'all_day',
  // Last week
  'significant_week', '4.5_week', '2.5_week', '1.0_week', 'all_week',
  // Last month
  'significant_month', '4.5_month', '2.5_month', 'all_month',
] as const;

export type UsgsFeed = (typeof USGS_FEEDS)[number];

export const DEFAULT_FEED: UsgsFeed = '2.5_day';

/** Parsed event row we render in the sidebar. */
export interface SeismicEvent {
  id: string;          // USGS event id (e.g. "us7000abcd")
  mag: number | null;
  place: string;       // human label (e.g. "12 km NNW of Honshu, Japan")
  timeMs: number;      // unix milliseconds, event origin time
  depthKm: number;
  lat: number;
  lon: number;
  url: string;         // USGS event page
  tsunami: boolean;
  alert: string | null; // "green"|"yellow"|"orange"|"red"
  felt: number | null; // number of DYFI felt reports
  cdi: number | null;  // max reported (community) intensity, MMI scale
  mmi: number | null;  // max estimated instrumental intensity, MMI scale
  sig: number | null;  // USGS "significance" score
}

interface UsgsGeoJSON {
  features: Array<{
    id: string;
    properties: {
      mag: number | null;
      place: string | null;
      time: number;
      url: string;
      tsunami: number;
      alert: string | null;
      felt: number | null;
      cdi: number | null;
      mmi: number | null;
      sig: number | null;
    };
    geometry: { coordinates: [number, number, number] }; // [lon, lat, depthKm]
  }>;
}

export function parseUsgs(json: UsgsGeoJSON): SeismicEvent[] {
  return json.features.map((f) => ({
    id: f.id,
    mag: f.properties.mag,
    place: f.properties.place ?? '(unknown location)',
    timeMs: f.properties.time,
    depthKm: f.geometry.coordinates[2],
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    url: f.properties.url,
    tsunami: !!f.properties.tsunami,
    alert: f.properties.alert,
    felt: f.properties.felt ?? null,
    cdi: f.properties.cdi ?? null,
    mmi: f.properties.mmi ?? null,
    sig: f.properties.sig ?? null,
  }));
}

/** Roman-numeral MMI intensity (I–XII) for a CDI/MMI decimal value. */
export function mmiRoman(v: number | null): string {
  if (v == null || v <= 0) return '';
  const r = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  return r[Math.min(12, Math.round(v))] || '';
}

/** USGS ShakeMap intensity color for an MMI value. */
export function intensityColor(v: number | null): string {
  if (v == null || v <= 0) return '#555';
  if (v >= 9) return '#a50026';
  if (v >= 8) return '#d73027';
  if (v >= 7) return '#f46d43';
  if (v >= 6) return '#fdae61';
  if (v >= 5) return '#fee08b';
  if (v >= 4) return '#d9ef8b';
  if (v >= 3) return '#a6d96a';
  return '#66bd63';
}

/** Color bucket for a magnitude. Used for the mag badge in the list. */
export function magColor(m: number | null): string {
  if (m == null) return '#555';
  if (m >= 6.0) return '#e53935';
  if (m >= 5.0) return '#fb8c00';
  if (m >= 4.0) return '#fdd835';
  if (m >= 2.5) return '#7cb342';
  return '#546e7a';
}

/** "12 min ago" / "3 h ago" / "5 d ago" for a unix-ms timestamp. */
export function ago(timeMs: number, now = Date.now()): string {
  const s = Math.max(0, (now - timeMs) / 1000);
  if (s < 60) return `${s.toFixed(0)}s ago`;
  if (s < 3600) return `${(s / 60).toFixed(0)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(0)} h ago`;
  return `${(s / 86400).toFixed(0)} d ago`;
}
