/** Station groups for the multi-station Network panel. A group is just a
 *  list of NSLCs the Network panel watches simultaneously (one RSAM row
 *  each). The default is a geographically-spread subset of the curated
 *  GSN broadbands — enough to demonstrate a "network overview" without
 *  opening 15 simultaneous SeedLink streams. */

import { STATION_PRESETS } from './stations';

export const DEFAULT_GROUP: string[] = [
  'IU.ANMO.00.BHZ', // New Mexico, USA
  'IU.COLA.00.BHZ', // Alaska
  'IU.HRV.00.BHZ',  // Massachusetts
  'IU.KIP.00.BHZ',  // Hawaii
  'II.BFO.00.BHZ',  // Germany
  'IU.RAR.00.BHZ',  // Cook Islands
];

/** Lookup a preset's human label for a NSLC, falling back to the NSLC. */
export function groupLabel(nslc: string): string {
  const p = STATION_PRESETS.find((s) => s.nslc === nslc);
  if (!p) return nslc;
  // Short label: just the station code portion of the curated label.
  const m = /^([A-Z0-9]+)\b/.exec(p.label);
  return m ? p.label : nslc;
}
