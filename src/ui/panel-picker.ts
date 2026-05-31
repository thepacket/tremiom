/** Topbar "+ Panel" control that lists every registered panel and lets
 *  the user toggle them on/off in the dashboard. Layout changes flow
 *  through onAdd / onRemove; the popover doesn't track state itself —
 *  it asks the dashboard each time it opens. */

import { panelRegistry } from '../panels/registry';

interface PanelPickerOpts {
  isActive(id: string): boolean;
  onAdd(id: string): void;
  onRemove(id: string): void;
  onReset(): void;
}

export function mountPanelPicker(parent: HTMLElement, opts: PanelPickerOpts): void {
  const wrap = document.createElement('span');
  wrap.className = 'panel-picker-wrap';
  wrap.innerHTML = `
    <button class="panel-picker-btn" title="Add or remove panels">+ Panel</button>
  `;
  parent.appendChild(wrap);

  const btn = wrap.querySelector('.panel-picker-btn') as HTMLButtonElement;
  let pop: HTMLElement | null = null;

  function close() {
    pop?.remove();
    pop = null;
    document.removeEventListener('click', maybeClose);
  }
  function maybeClose(e: MouseEvent) {
    if (!pop) return;
    if (pop.contains(e.target as Node) || btn.contains(e.target as Node)) return;
    close();
  }
  function render() {
    if (!pop) return;
    const ids = Object.keys(panelRegistry).sort();
    pop.innerHTML = `
      <div class="panel-picker-list">
        ${ids.map((id) => {
          const p = panelRegistry[id];
          const on = opts.isActive(id);
          return `
            <button class="panel-picker-row${on ? ' on' : ''}" data-id="${id}">
              <span class="check">${on ? '✓' : ''}</span>
              <span class="label">${escapeHtml(p.label)}</span>
              <span class="muted small">${escapeHtml(id)}</span>
            </button>`;
        }).join('')}
      </div>
      <footer>
        <button class="panel-picker-reset" title="Reset dashboard to default layout">
          Reset layout
        </button>
      </footer>
    `;
    pop.querySelector('.panel-picker-reset')!.addEventListener('click', () => {
      opts.onReset();
      render();
    });
    for (const row of pop.querySelectorAll('.panel-picker-row')) {
      row.addEventListener('click', () => {
        const id = (row as HTMLElement).dataset.id!;
        if (opts.isActive(id)) opts.onRemove(id);
        else opts.onAdd(id);
        render();
      });
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop) { close(); return; }
    pop = document.createElement('div');
    pop.className = 'panel-picker-pop';
    wrap.appendChild(pop);
    render();
    // Close on outside click.
    setTimeout(() => document.addEventListener('click', maybeClose), 0);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}
