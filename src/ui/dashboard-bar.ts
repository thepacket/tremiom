import type { DashboardHandle } from './dashboard';

/** Topbar dashboard controls: a selector listing all dashboards (one
 *  shown at a time), plus new / rename / delete, an "+ Notes" button to
 *  add an editable markdown panel, and "⤓ PDF" to print the current
 *  dashboard. */
export function mountDashboardBar(parent: HTMLElement, dash: DashboardHandle): void {
  const wrap = document.createElement('span');
  wrap.className = 'dashboard-bar';
  wrap.innerHTML = `
    <select class="dash-select" title="Dashboard"></select>
    <button class="dash-btn" data-act="new"    title="New dashboard">+</button>
    <button class="dash-btn" data-act="rename" title="Rename dashboard">✎</button>
    <button class="dash-btn" data-act="delete" title="Delete dashboard">🗑</button>
    <button class="dash-btn" data-act="notes"  title="Add a markdown notes panel">+ Notes</button>
    <button class="dash-btn" data-act="pdf"    title="Print dashboard to PDF">⤓ PDF</button>
  `;
  parent.appendChild(wrap);

  const sel = wrap.querySelector('.dash-select') as HTMLSelectElement;

  function refresh() {
    const list = dash.listDashboards();
    const cur = dash.currentId();
    sel.innerHTML = list
      .map((d) => `<option value="${d.id}"${d.id === cur ? ' selected' : ''}>${escapeHtml(d.name)}</option>`)
      .join('');
    // Disable delete when only one dashboard remains.
    (wrap.querySelector('[data-act="delete"]') as HTMLButtonElement).disabled = list.length <= 1;
  }
  refresh();

  sel.addEventListener('change', () => { dash.selectDashboard(sel.value); refresh(); });

  wrap.querySelectorAll('.dash-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const act = (b as HTMLElement).dataset.act!;
      if (act === 'new') {
        const name = prompt('New dashboard name:', 'Dashboard');
        if (name != null) { dash.createDashboard(name.trim() || 'Untitled'); refresh(); }
      } else if (act === 'rename') {
        const list = dash.listDashboards();
        const curName = list.find((d) => d.id === dash.currentId())?.name ?? '';
        const name = prompt('Rename dashboard:', curName);
        if (name != null && name.trim()) { dash.renameDashboard(dash.currentId(), name.trim()); refresh(); }
      } else if (act === 'delete') {
        const list = dash.listDashboards();
        if (list.length <= 1) return;
        const curName = list.find((d) => d.id === dash.currentId())?.name ?? 'this dashboard';
        if (confirm(`Delete dashboard "${curName}"? This cannot be undone.`)) {
          dash.deleteDashboard(dash.currentId()); refresh();
        }
      } else if (act === 'notes') {
        dash.addPanel('markdown');
      } else if (act === 'pdf') {
        dash.printPdf();
      }
    }));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}
