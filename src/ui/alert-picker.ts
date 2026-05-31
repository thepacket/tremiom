import { alerts } from './alerts';

/** Topbar 🔔 control: toggle STA/LTA trigger alerts + set the threshold.
 *  Calls onToggle so the app can ensure the sta-lta stream is subscribed
 *  while alerts are active. */
export function mountAlertPicker(
  parent: HTMLElement,
  onToggle: (enabled: boolean) => void,
): void {
  const wrap = document.createElement('span');
  wrap.className = 'alert-picker';
  const cfg = alerts.config;
  wrap.innerHTML = `
    <button class="alert-btn${cfg.enabled ? ' on' : ''}" title="STA/LTA trigger alerts">🔔</button>
    <input class="alert-thr" type="number" min="1.1" max="20" step="0.1"
           value="${cfg.threshold}" title="Trigger threshold (STA/LTA)" />
  `;
  parent.appendChild(wrap);

  const btn = wrap.querySelector('.alert-btn') as HTMLButtonElement;
  const thr = wrap.querySelector('.alert-thr') as HTMLInputElement;

  btn.addEventListener('click', () => {
    const next = !alerts.isEnabled();
    alerts.setEnabled(next);
    btn.classList.toggle('on', next);
    onToggle(next);
  });
  thr.addEventListener('change', () => {
    const v = parseFloat(thr.value);
    if (isFinite(v) && v >= 1.1) alerts.setThreshold(v);
  });
}
