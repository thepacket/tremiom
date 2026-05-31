import { FILTER_PRESETS, type FilterSpec, DEFAULT_FILTER } from '../data/filters';

/** Tiny dropdown next to the station picker that picks a server-side
 *  filter. Each change fires `onChange(spec)`; the caller pipes it to
 *  the WS multiplexer via `client.setFilter(station, spec)`. */
export function mountFilterPicker(
  parent: HTMLElement,
  initial: FilterSpec | null,
  onChange: (spec: FilterSpec) => void,
): { setFilter(spec: FilterSpec): void } {
  const wrap = document.createElement('span');
  wrap.className = 'filter-picker';
  wrap.innerHTML = `<select class="filter-select" title="Time-domain filter applied server-side">${
    FILTER_PRESETS.map((p, i) => `<option value="${i}">${p.label}</option>`).join('')
  }</select>`;
  parent.appendChild(wrap);

  const select = wrap.querySelector('select') as HTMLSelectElement;
  let current = initial ?? DEFAULT_FILTER;
  setFilter(current);

  function setFilter(spec: FilterSpec) {
    current = spec;
    const idx = FILTER_PRESETS.findIndex(
      (p) => p.kind === spec.kind && p.low === spec.low && p.high === spec.high,
    );
    select.value = String(Math.max(0, idx));
  }

  select.addEventListener('change', () => {
    const next = FILTER_PRESETS[+select.value] ?? DEFAULT_FILTER;
    if (next === current) return;
    current = next;
    onChange(next);
  });

  return { setFilter };
}
