/** Curated list of well-known IRIS-network broadband stations.
 *
 *  These are GSN (Global Seismographic Network) and partner stations
 *  that stream BH? channels reliably and have geographic spread for a
 *  varied first impression. Format is the FDSN N.S.L.C string we
 *  pass through to the SeedLink worker.
 *
 *  Source: IRIS GSN station list, https://ds.iris.edu/gmap/#network=_GSN
 *
 *  Add more (or wire up FDSN station service search) in v0.2.
 */

export interface StationPreset {
  /** N.S.L.C — what we send on the wire. */
  nslc: string;
  /** Human-readable label for the picker. */
  label: string;
  /** Approximate latitude, for a future map view. */
  lat: number;
  /** Approximate longitude, for a future map view. */
  lon: number;
}

export const STATION_PRESETS: StationPreset[] = [
  { nslc: 'IU.ANMO.00.BHZ', label: 'ANMO — Albuquerque, NM, USA',     lat:  34.95, lon: -106.46 },
  { nslc: 'IU.HRV.00.BHZ',  label: 'HRV — Harvard, MA, USA',           lat:  42.51, lon:  -71.56 },
  { nslc: 'IU.COLA.00.BHZ', label: 'COLA — College, AK, USA',          lat:  64.87, lon: -147.86 },
  { nslc: 'IU.KIP.00.BHZ',  label: 'KIP — Kipapa, Hawaii, USA',        lat:  21.42, lon: -158.01 },
  { nslc: 'IU.KONO.00.BHZ', label: 'KONO — Kongsberg, Norway',         lat:  59.65, lon:    9.60 },
  { nslc: 'IU.PMSA.00.BHZ', label: 'PMSA — Palmer Station, Antarctica',lat: -64.77, lon:  -64.05 },
  { nslc: 'IU.RAR.00.BHZ',  label: 'RAR — Rarotonga, Cook Islands',    lat: -21.21, lon: -159.77 },
  { nslc: 'IU.GUMO.00.BHZ', label: 'GUMO — Guam',                      lat:  13.59, lon:  144.87 },
  { nslc: 'IU.WAKE.00.BHZ', label: 'WAKE — Wake Island',               lat:  19.28, lon:  166.65 },
  { nslc: 'II.AAK.00.BHZ',  label: 'AAK — Ala-Archa, Kyrgyzstan',      lat:  42.64, lon:   74.49 },
  { nslc: 'II.BFO.00.BHZ',  label: 'BFO — Black Forest, Germany',      lat:  48.33, lon:    8.33 },
  { nslc: 'II.MSEY.00.BHZ', label: 'MSEY — Mahé, Seychelles',          lat:  -4.67, lon:   55.48 },
  { nslc: 'II.SUR.00.BHZ',  label: 'SUR — Sutherland, South Africa',   lat: -32.38, lon:   20.81 },
  { nslc: 'G.SSB.00.BHZ',   label: 'SSB — Saint-Sauveur-Badole, FR',   lat:  45.28, lon:    4.54 },
  { nslc: 'GE.STU.00.BHZ',  label: 'STU — Stuttgart, Germany',         lat:  48.77, lon:    9.19 },
];

export const DEFAULT_STATION = 'IU.ANMO.00.BHZ';

/** Loose validation for an N.S.L.C string. Location may be empty. */
export function isValidNslc(s: string): boolean {
  if (!s) return false;
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  const [net, sta, _loc, cha] = parts;
  if (!/^[A-Z0-9]{1,8}$/.test(net)) return false;
  if (!/^[A-Z0-9]{1,8}$/.test(sta)) return false;
  if (!/^[A-Z0-9]{2,3}$/.test(cha)) return false;
  return true;
}
