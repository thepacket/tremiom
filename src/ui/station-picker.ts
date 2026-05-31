import { STATION_PRESETS, isValidNslc } from '../data/stations';
import { openStationSearch } from './station-search';

/** Inline station picker for the topbar.
 *
 *  Two controls side-by-side:
 *    - <select> with curated GSN presets
 *    - <input type="text"> for free-form N.S.L.C entry (e.g. Raspberry
 *      Shake stations not in the curated list)
 *
 *  Either one fires the `onChange` callback. The caller (app.ts) is
 *  responsible for unsubscribing the old station and subscribing the
 *  new one.
 */
export function mountStationPicker(
  parent: HTMLElement,
  initial: string,
  onChange: (nslc: string) => void,
): { setStation(nslc: string): void } {
  const wrap = document.createElement('span');
  wrap.className = 'station-picker';

  const select = document.createElement('select');
  select.className = 'station-select';
  select.innerHTML = STATION_PRESETS.map(
    (s) => `<option value="${s.nslc}">${s.label}</option>`
  ).join('') + '<option value="__custom__">— custom NSLC —</option>';
  wrap.appendChild(select);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'station-input';
  input.placeholder = 'NET.STA.LOC.CHA';
  input.size = 18;
  input.spellcheck = false;
  input.autocapitalize = 'characters';
  wrap.appendChild(input);

  const browse = document.createElement('button');
  browse.type = 'button';
  browse.className = 'station-browse';
  browse.textContent = 'Browse…';
  browse.title = 'Search the FDSN station catalog (500+ stations)';
  browse.addEventListener('click', () => {
    openStationSearch(null, (nslc) => {
      onChange(nslc);
      setStation(nslc);
    });
  });
  wrap.appendChild(browse);

  parent.appendChild(wrap);

  let current = initial;
  function setStation(nslc: string) {
    current = nslc;
    const preset = STATION_PRESETS.find((s) => s.nslc === nslc);
    if (preset) {
      select.value = nslc;
      input.value = '';
    } else {
      select.value = '__custom__';
      input.value = nslc;
    }
  }
  setStation(initial);

  select.addEventListener('change', () => {
    const v = select.value;
    if (v === '__custom__') {
      input.focus();
      input.select();
      return;
    }
    if (v !== current) {
      current = v;
      onChange(v);
    }
  });

  function commitInput() {
    const v = input.value.trim().toUpperCase();
    input.value = v;
    if (!isValidNslc(v)) {
      input.classList.add('bad');
      return;
    }
    input.classList.remove('bad');
    if (v !== current) {
      current = v;
      // If it happens to match a preset, snap the dropdown.
      const preset = STATION_PRESETS.find((s) => s.nslc === v);
      select.value = preset ? v : '__custom__';
      onChange(v);
    }
  }

  input.addEventListener('change', commitInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitInput();
    }
  });

  return { setStation };
}
