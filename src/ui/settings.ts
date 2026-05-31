/** Settings modal: shows the running instance's auth state, lets the
 *  user sign out (which clears the server-set cookie). When the
 *  instance is open (no TREMIOM_TOKEN configured), the panel says so
 *  and the sign-out button is hidden — there's nothing to sign out
 *  from.
 */

interface AuthStatus {
  required: boolean;
  authenticated: boolean;
}

declare const __APP_VERSION__: string;

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
          <div class="setting-value" id="set-version">${__APP_VERSION__}</div>
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
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}
