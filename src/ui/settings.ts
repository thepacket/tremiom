/** Settings modal: shows the running instance's auth state, lets the
 *  user sign out (which clears the server-set cookie), and lets the
 *  operator pick SeedLink upstream servers (the "where do live samples
 *  come from" choice). When the instance is open (no TREMIOM_TOKEN
 *  configured), the panel says so and the sign-out button is hidden —
 *  there's nothing to sign out from.
 */

import { APP_VERSION } from '../version';
import {
  cachedOpenRouterModels,
  clearOpenRouterSettings,
  getOpenRouterSettings,
  loadOpenRouterModels,
  modelSupportsText,
  setOpenRouterSettings,
  type OpenRouterModel,
} from '../ai/openrouter';

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
        <div class="setting-section-title">AI · OpenRouter</div>
        <div class="setting-help">
          The API key is kept in this tab's browser <code>sessionStorage</code>
          and sent directly to <code>openrouter.ai</code>. Tremiom's server
          never receives it. Closing the tab clears the key, selected model,
          and AI conversation.
        </div>
        <div class="setting-row">
          <div class="setting-label">API key</div>
          <div class="setting-value">
            <input type="password" id="or-api-key" placeholder="sk-or-v1-…"
                   spellcheck="false" autocomplete="off" class="sl-input">
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label">Model</div>
          <div class="setting-value ai-model-setting">
            <select id="or-model" class="sl-input" disabled>
              <option value="">Load OpenRouter models…</option>
            </select>
            <button type="button" id="or-load-models" class="secondary">Refresh models</button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label"></div>
          <div class="setting-value">
            <button type="button" id="or-save" class="primary">Save AI settings</button>
            <button type="button" id="or-clear" class="secondary">Clear</button>
            <span id="or-status" class="muted"></span>
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

  // ── OpenRouter browser-session config ──────────────────────────────
  const orKey    = backdrop.querySelector('#or-api-key') as HTMLInputElement;
  const orModel  = backdrop.querySelector('#or-model') as HTMLSelectElement;
  const orLoad   = backdrop.querySelector('#or-load-models') as HTMLButtonElement;
  const orSave   = backdrop.querySelector('#or-save') as HTMLButtonElement;
  const orClear  = backdrop.querySelector('#or-clear') as HTMLButtonElement;
  const orStatus = backdrop.querySelector('#or-status') as HTMLElement;
  const savedOpenRouter = getOpenRouterSettings();
  orKey.value = savedOpenRouter.apiKey;

  function setOrStatus(text: string, cls: 'ok' | 'bad' | 'muted' = 'muted'): void {
    orStatus.className = cls;
    orStatus.textContent = text;
  }

  function modelLabel(model: OpenRouterModel): string {
    const context = model.context_length ? ` · ${Math.round(model.context_length / 1000)}k` : '';
    const prompt = Number(model.pricing?.prompt);
    const completion = Number(model.pricing?.completion);
    const pricing = Number.isFinite(prompt) && Number.isFinite(completion)
      ? ` · $${(prompt * 1_000_000).toFixed(2)}/$${(completion * 1_000_000).toFixed(2)} per M`
      : '';
    const nonText = modelSupportsText(model) ? '' : ' · non-text';
    return `${model.name} — ${model.id}${context}${pricing}${nonText}`;
  }

  function populateModels(models: OpenRouterModel[], selected: string): void {
    orModel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a text model…';
    orModel.appendChild(placeholder);
    const byProvider = new Map<string, OpenRouterModel[]>();
    for (const model of models) {
      const provider = model.id.split('/')[0] || 'other';
      const group = byProvider.get(provider) || [];
      group.push(model); byProvider.set(provider, group);
    }
    for (const [provider, group] of [...byProvider].sort(([a], [b]) => a.localeCompare(b))) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = provider;
      for (const model of group) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = modelLabel(model);
        option.disabled = !modelSupportsText(model);
        option.title = model.description || model.id;
        optgroup.appendChild(option);
      }
      orModel.appendChild(optgroup);
    }
    orModel.disabled = false;
    if (selected && models.some((model) => model.id === selected && modelSupportsText(model))) {
      orModel.value = selected;
    } else {
      orModel.value = '';
    }
    setOrStatus(`${models.length} models loaded`, 'ok');
  }

  async function refreshModels(force = false): Promise<void> {
    orLoad.disabled = true;
    orModel.disabled = true;
    setOrStatus('loading model catalog…');
    try {
      const models = await loadOpenRouterModels(orKey.value.trim(), { force });
      populateModels(models, getOpenRouterSettings().modelId);
    } catch (error) {
      setOrStatus((error as Error).message, 'bad');
    } finally {
      orLoad.disabled = false;
    }
  }

  orLoad.addEventListener('click', () => void refreshModels(true));
  orSave.addEventListener('click', () => {
    const apiKey = orKey.value.trim();
    const modelId = orModel.value;
    if (!apiKey) { setOrStatus('API key is required', 'bad'); return; }
    if (!modelId) { setOrStatus('load and select a text model', 'bad'); return; }
    setOpenRouterSettings({ apiKey, modelId });
    setOrStatus('saved for this browser tab', 'ok');
  });
  orClear.addEventListener('click', () => {
    clearOpenRouterSettings();
    orKey.value = '';
    orModel.innerHTML = '<option value="">Load OpenRouter models…</option>';
    orModel.disabled = true;
    setOrStatus('AI settings cleared for this tab');
  });

  const cachedModels = cachedOpenRouterModels();
  if (cachedModels.length) populateModels(cachedModels, savedOpenRouter.modelId);
  else void refreshModels();

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
