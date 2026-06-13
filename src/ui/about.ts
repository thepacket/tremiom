/** About dialog — surfaced from the topbar's About button (after Help).
 *  Shows the app icon, name, version, a short description, the GitHub
 *  link, the authorship line, and the copyright / licence notice.
 *  Mirrors the sibling Quantiom app's About modal. */

import { APP_VERSION } from '../version';

const GITHUB_URL = 'https://github.com/thepacket/tremiom';

export function openAbout(): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal about">
      <header>
        <span class="title">About</span>
        <button class="modal-close" title="Close">✕</button>
      </header>
      <div class="about-body">
        <img class="about-logo" src="/icon.svg" alt="Tremiom logo" />
        <div class="about-name">Tremiom</div>
        <div class="about-version">v${APP_VERSION}</div>

        <p>A browser-based, real-time and historical <b>seismology</b>
          workstation. It streams live waveforms from global broadband
          stations, runs scientific DSP server-side, and lets you browse,
          analyze, and pick earthquakes — all in the browser, with no install
          and no account.</p>

        <p>Built with an AI-assisted workflow, so new panels and features can
          be added quickly on demand.</p>

        <p><a href="${GITHUB_URL}" target="_blank" rel="noreferrer">${GITHUB_URL.replace('https://', '')}</a></p>

        <hr />

        <p class="muted">Developed by Claude Code in collaboration with Andre Paquette.</p>
        <p class="muted">© 2026 Andre Paquette · MIT License</p>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', esc); };
  function esc(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  backdrop.querySelector('.modal-close')!.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', esc);

  // Gracefully hide the logo if the asset isn't present.
  const logo = backdrop.querySelector('.about-logo') as HTMLImageElement;
  logo.addEventListener('error', () => { logo.style.display = 'none'; });
}
