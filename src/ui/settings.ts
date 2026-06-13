/** Settings modal: shows the running instance's auth state, lets the
 *  user sign out (which clears the server-set cookie), and lets the
 *  operator pick SeedLink upstream servers (the "where do live samples
 *  come from" choice). When the instance is open (no TREMIOM_TOKEN
 *  configured), the panel says so and the sign-out button is hidden —
 *  there's nothing to sign out from.
 */

import { APP_VERSION } from '../version';

interface AuthStatus {
  required: boolean;
  authenticated: boolean;
}

interface SeedlinkUpstreams {
  default: string;
  networks: Record<string, string>;
}

interface SeedlinkConfigResponse {
  current: SeedlinkUpstreams;
  builtinDefaults: SeedlinkUpstreams;
}

export function openSettings(): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal settings">
      <header>
        <span class="title">Settings</span>
        <button class="modal-close" title="Close">✕</button>
      </header>
      <section class="settings-body">
        <div class="setting-row">
          <div class="setting-label">Version</div>
          <div class="setting-value" id="set-version">${APP_VERSION}</div>
        </div>
        <div class="setting-row">
          <div class="setting-label">Access token</div>
          <div class="setting-value" id="auth-state">checking…</div>
        </div>
        <div class="setting-row hidden" id="auth-actions">
          <div class="setting-label"></div>
          <div class="setting-value">
            <form method="POST" action="/api/auth/logout" id="signout-form">
              <button type="submit" class="danger">Sign out</button>
            </form>
          </div>
        </div>
        <div class="setting-row hidden" id="auth-relogin">
          <div class="setting-label">Re-authenticate</div>
          <div class="setting-value">
            <form method="POST" action="/api/auth/login" autocomplete="on" class="relogin-form">
              <input type="password" name="token" placeholder="New access token"
                     autocomplete="current-password" spellcheck="false">
              <button type="submit">Apply</button>
            </form>
          </div>
        </div>
        <hr class="settings-sep">
        <div class="setting-section-title">SeedLink upstreams</div>
        <div class="setting-help">
          Where the worker fetches live waveforms from. Changes apply
          immediately; stations whose upstream changed reconnect within
          a few seconds. Format: <code>host:port</code> (default port 18000).
          Per-network rows override the default for that network code only.
        </div>
        <div class="setting-row">
          <div class="setting-label">Default</div>
          <div class="setting-value">
            <input type="text" id="sl-default" placeholder="host:port"
                   spellcheck="false" autocomplete="off" class="sl-input">
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label">Per network</div>
          <div class="setting-value">
            <div id="sl-networks"></div>
            <button type="button" id="sl-add-network" class="sl-add">+ Add network override</button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label"></div>
          <div class="setting-value">
            <button type="button" id="sl-save" class="primary">Save SeedLink config</button>
            <button type="button" id="sl-reset" class="secondary" title="Restore the built-in defaults">Reset to built-ins</button>
            <span id="sl-status" class="muted"></span>
          </div>
        </div>
      </section>
    </div>
  `;
  document.body.appendChild(backdrop);

  function close() { backdrop.remove(); document.removeEventListener('keydown', esc); }
  function esc(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  backdrop.querySelector('.modal-close')!.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', esc);

  const stateEl    = backdrop.querySelector('#auth-state') as HTMLElement;
  const actionsEl  = backdrop.querySelector('#auth-actions') as HTMLElement;
  const reloginEl  = backdrop.querySelector('#auth-relogin') as HTMLElement;

  void fetch('/api/auth/status', { credentials: 'same-origin' })
    .then((r) => r.json() as Promise<AuthStatus>)
    .then((s) => {
      if (!s.required) {
        stateEl.innerHTML =
          '<span class="ok">open instance</span> ' +
          '<span class="muted">— TREMIOM_TOKEN not set on the server</span>';
      } else if (s.authenticated) {
        stateEl.innerHTML =
          '<span class="ok">signed in</span> ' +
          '<span class="muted">— cookie valid</span>';
        actionsEl.classList.remove('hidden');
        reloginEl.classList.remove('hidden');
      } else {
        // Realistically unreachable: if the gate let us load this code,
        // we're already authenticated. But the server could change state
        // (e.g. the operator rotated the secret) — surface that cleanly.
        stateEl.innerHTML = '<span class="bad">not signed in</span>';
        reloginEl.classList.remove('hidden');
      }
    })
    .catch((e) => {
      stateEl.innerHTML = `<span class="bad">status check failed:</span> ${escapeHtml(String(e))}`;
    });

  // ── SeedLink upstream config ────────────────────────────────────────
  const slDefault  = backdrop.querySelector('#sl-default') as HTMLInputElement;
  const slNetworks = backdrop.querySelector('#sl-networks') as HTMLElement;
  const slAdd      = backdrop.querySelector('#sl-add-network') as HTMLButtonElement;
  const slSave     = backdrop.querySelector('#sl-save') as HTMLButtonElement;
  const slReset    = backdrop.querySelector('#sl-reset') as HTMLButtonElement;
  const slStatus   = backdrop.querySelector('#sl-status') as HTMLElement;
  let slBuiltinDefaults: SeedlinkUpstreams | null = null;

  function renderNetworkRows(networks: Record<string, string>): void {
    slNetworks.innerHTML = '';
    const entries = Object.entries(networks);
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = '(no overrides — every network uses the default)';
      slNetworks.appendChild(empty);
      return;
    }
    for (const [net, up] of entries) addNetworkRow(net, up);
  }

  function addNetworkRow(net = '', up = ''): void {
    // First row: clear the "(no overrides)" placeholder if present.
    const placeholder = slNetworks.querySelector('.muted');
    if (placeholder) placeholder.remove();
    const row = document.createElement('div');
    row.className = 'sl-net-row';
    row.innerHTML = `
      <input type="text" class="sl-net" placeholder="NET" maxlength="3"
             spellcheck="false" autocomplete="off">
      <input type="text" class="sl-up"  placeholder="host:port"
             spellcheck="false" autocomplete="off">
      <button type="button" class="sl-rm" title="Remove">×</button>
    `;
    (row.querySelector('.sl-net') as HTMLInputElement).value = net;
    (row.querySelector('.sl-up')  as HTMLInputElement).value = up;
    row.querySelector('.sl-rm')!.addEventListener('click', () => {
      row.remove();
      if (slNetworks.children.length === 0) renderNetworkRows({});
    });
    slNetworks.appendChild(row);
  }

  function collectNetworks(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of slNetworks.querySelectorAll('.sl-net-row')) {
      const net = ((row.querySelector('.sl-net') as HTMLInputElement).value || '')
        .trim().toUpperCase();
      const up  = ((row.querySelector('.sl-up')  as HTMLInputElement).value || '').trim();
      if (net && up) out[net] = up;
    }
    return out;
  }

  function setStatus(text: string, cls: 'ok' | 'bad' | 'muted' = 'muted'): void {
    slStatus.className = cls;
    slStatus.textContent = text;
  }

  slAdd.addEventListener('click', () => addNetworkRow('', ''));

  slReset.addEventListener('click', () => {
    if (!slBuiltinDefaults) return;
    slDefault.value = slBuiltinDefaults.default;
    renderNetworkRows(slBuiltinDefaults.networks);
    setStatus('reverted form to built-ins — click Save to apply', 'muted');
  });

  slSave.addEventListener('click', async () => {
    const def = slDefault.value.trim();
    if (!def) { setStatus('default upstream cannot be empty', 'bad'); return; }
    const body = { default: def, networks: collectNetworks() };
    setStatus('saving…', 'muted');
    slSave.disabled = true;
    try {
      const r = await fetch('/api/config/seedlink', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const j = await r.json() as { ok?: boolean; error?: string; current?: SeedlinkUpstreams };
      if (!r.ok || !j.ok) {
        setStatus(j.error || `save failed (HTTP ${r.status})`, 'bad');
      } else {
        setStatus('saved — worker reconfigured', 'ok');
        if (j.current) {
          slDefault.value = j.current.default;
          renderNetworkRows(j.current.networks);
        }
      }
    } catch (e) {
      setStatus(`save failed: ${String(e)}`, 'bad');
    } finally {
      slSave.disabled = false;
    }
  });

  void fetch('/api/config/seedlink', { credentials: 'same-origin' })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('non-JSON response');
      return await r.json() as SeedlinkConfigResponse;
    })
    .then((j) => {
      if (!j?.current || typeof j.current.default !== 'string') {
        throw new Error('malformed response');
      }
      slBuiltinDefaults = j.builtinDefaults;
      slDefault.value = j.current.default;
      renderNetworkRows(j.current.networks || {});
    })
    .catch((e) => {
      setStatus(`load failed: ${String(e?.message ?? e)}`, 'bad');
    });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}
