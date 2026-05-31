/** Types + fetch helper for event waveform bundles produced by the
 *  server-side /api/event/waveforms endpoint (workers/event_fetch.py). */

import type { SeismicEvent } from './events';

export interface EventStationWaveform {
  nslc: string;
  lat: number;
  lon: number;
  distKm: number;
  distDeg: number;
  /** Seconds from origin; null if TauP didn't produce one. */
  pArrivalS: number | null;
  sArrivalS: number | null;
  /** Unix ms of the first sample. */
  t0Ms: number;
  sr: number;
  decimateBy: number;
  data: number[];
}

export interface EventWaveforms {
  eventId: string;
  originTimeMs: number;
  depthKm: number;
  lat: number;
  lon: number;
  windowSecs: [number, number];
  stations: EventStationWaveform[];
  errors?: Array<{ nslc: string; error: string }>;
  taupError?: string;
}

export async function fetchEventWaveforms(
  e: SeismicEvent, opts: { nStations?: number } = {}
): Promise<EventWaveforms> {
  const body = {
    eventId: e.id,
    lat: e.lat, lon: e.lon,
    depthKm: e.depthKm,
    timeMs: e.timeMs,
    nStations: opts.nStations ?? 6,
  };
  const r = await fetch('/api/event/waveforms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}
