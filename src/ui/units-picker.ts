/** Topbar dropdown to choose the physical output units. The server
 *  removes the instrument response (via ObsPy + StationXML) and converts
 *  raw counts to the chosen quantity. "Counts" is the raw default and
 *  needs no response. */

export interface UnitOption { value: string; label: string; }

export const UNIT_OPTIONS: UnitOption[] = [
  { value: 'counts',        label: 'Counts (raw)' },
  { value: 'velocity',      label: 'Velocity (m/s)' },
  { value: 'displacement',  label: 'Displacement (m)' },
  { value: 'acceleration',  label: 'Acceleration (m/s²)' },
  { value: 'wood-anderson', label: 'Wood-Anderson (mm)' },
];

export const DEFAULT_UNITS = 'counts';

export function mountUnitsPicker(
  parent: HTMLElement,
  initial: string,
  onChange: (units: string) => void,
): { setUnits(u: string): void } {
  const wrap = document.createElement('span');
  wrap.className = 'units-picker';
  wrap.innerHTML = `<select class="units-select" title="Physical units (instrument response removed server-side)">${
    UNIT_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')
  }</select>`;
  parent.appendChild(wrap);

  const select = wrap.querySelector('select') as HTMLSelectElement;
  select.value = initial;

  select.addEventListener('change', () => onChange(select.value));

  return {
    setUnits(u: string) { select.value = u; },
  };
}
