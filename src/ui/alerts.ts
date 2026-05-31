/** STA/LTA trigger alerts. When enabled, watches incoming STA/LTA panel
 *  frames for the active station; if the ratio crosses the threshold, it
 *  fires a browser Notification (if permitted) + an in-app banner, with a
 *  cooldown so a single sustained trigger doesn't spam. Config persists
 *  to localStorage.
 *
 *  Leverages the server-side STA/LTA that already runs — the app ensures
 *  the "sta-lta" stream is subscribed whenever alerts are on, even if the
 *  panel isn't on the dashboard. */

const STORAGE_KEY = 'tremiom-alerts-v1';

export interface AlertConfig {
  enabled: boolean;
  threshold: number;
}

interface AlertState extends AlertConfig {
  lastFiredAt: number;
}

const COOLDOWN_MS = 60_000;

function load(): AlertConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { enabled: false, threshold: 3.0, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { enabled: false, threshold: 3.0 };
}

const state: AlertState = { ...load(), lastFiredAt: 0 };

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY,
      JSON.stringify({ enabled: state.enabled, threshold: state.threshold }));
  } catch { /* ignore */ }
}

export const alerts = {
  get config(): AlertConfig { return { enabled: state.enabled, threshold: state.threshold }; },
  isEnabled() { return state.enabled; },
  setEnabled(on: boolean) {
    state.enabled = on;
    persist();
    if (on && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  },
  setThreshold(t: number) { state.threshold = t; persist(); },

  /** Feed an STA/LTA frame. Fires an alert if the peak crosses the
   *  threshold and the cooldown has elapsed. */
  feed(station: string, peak: number) {
    if (!state.enabled) return;
    if (peak < state.threshold) return;
    const now = Date.now();
    if (now - state.lastFiredAt < COOLDOWN_MS) return;
    state.lastFiredAt = now;
    fire(station, peak, state.threshold);
  },
};

function fire(station: string, peak: number, threshold: number) {
  const title = `Tremiom — trigger on ${station}`;
  const bodyText = `STA/LTA ${peak.toFixed(1)} ≥ ${threshold.toFixed(1)} at ${new Date().toUTCString()}`;
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body: bodyText, tag: 'tremiom-trigger' }); } catch { /* ignore */ }
  }
  showBanner(`⚠ ${title} — ${bodyText}`);
}

let bannerTimer: number | null = null;
function showBanner(text: string) {
  let el = document.getElementById('tremiom-alert-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tremiom-alert-banner';
    el.className = 'alert-banner';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  if (bannerTimer) window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => el!.classList.remove('show'), 12_000);
}
