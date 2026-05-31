/** Panel registry. Same pattern as Radiom: each panel is a self-contained
 *  module that knows how to render its frame onto a canvas. Add new
 *  panels by importing them here. */

import { helicorder } from './helicorder';
import { spectrogram } from './spectrogram';
import { rawScope } from './raw-scope';
import { psd } from './psd';
import { drum } from './drum';
import { staLta } from './sta-lta';

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
  [drum, helicorder, spectrogram, rawScope, psd, staLta].map((p) => [p.id, p])
);
