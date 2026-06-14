/** Panel registry. Each panel is a self-contained module that knows how
 *  to render its frame onto a canvas. Add new panels by importing them
 *  here. */

import { helicorder } from './helicorder';
import { spectrogram } from './spectrogram';
import { rawScope } from './raw-scope';
import { psd } from './psd';
import { drum } from './drum';
import { rsam } from './rsam';
import { staLta } from './sta-lta';
import { particleMotion } from './particle-motion';
import { ppsd } from './ppsd';
import { spectrum } from './spectrum';
import { threeComp } from './three-comp';
import { hv } from './hv';
import { network } from './network';
import { qc } from './qc';

export type PanelCategory = 'live' | 'event';

export interface PanelDef {
  id: string;
  label: string;
  category: PanelCategory;
  /** Python worker module that produces this panel's frames. */
  serverWorker: string;
  render(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    frame: unknown
  ): void;
}

export const panelRegistry: Record<string, PanelDef> = Object.fromEntries(
  [drum, rsam, helicorder, spectrogram, spectrum, rawScope, threeComp, hv, psd, staLta, particleMotion, ppsd, network, qc].map((p) => [p.id, p])
);
