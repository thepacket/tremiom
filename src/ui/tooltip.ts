/** Lightweight custom tooltips with a fixed show delay. The browser's
 *  native `title` tooltip delay can't be tuned, so we suppress the native
 *  one (moving its text to `data-tip`) and render our own after SHOW_DELAY.
 *  Works for any element with a `title` — including dynamically-added
 *  panels, popovers, and modals — via document-level event delegation. */

const SHOW_DELAY_MS = 500;

let tip: HTMLDivElement | null = null;
let timer: number | undefined;
let target: HTMLElement | null = null;

export function initTooltips(): void {
  if (tip) return;
  tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('mousedown', hide, true);
  window.addEventListener('scroll', hide, true);
}

/** Nearest ancestor (incl. self) that carries tooltip text. */
function tipEl(start: EventTarget | null): HTMLElement | null {
  let el = start as HTMLElement | null;
  while (el && el !== document.body) {
    if (el.hasAttribute?.('title') || el.dataset?.tip != null) return el;
    el = el.parentElement;
  }
  return null;
}

function onOver(e: MouseEvent): void {
  const el = tipEl(e.target);
  if (!el || el === target) return;
  // Move native title → data-tip the first time, so the OS tooltip stays hidden.
  const t = el.getAttribute('title');
  if (t != null) { el.dataset.tip = t; el.removeAttribute('title'); }
  const text = el.dataset.tip;
  if (!text) return;
  target = el;
  clearTimeout(timer);
  timer = window.setTimeout(() => show(el, text), SHOW_DELAY_MS);
}

function onOut(e: MouseEvent): void {
  if (!target) return;
  const related = e.relatedTarget as Node | null;
  if (related && target.contains(related)) return; // still inside the target
  hide();
}

function show(el: HTMLElement, text: string): void {
  if (!tip) return;
  tip.textContent = text;
  const r = el.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - tr.width - 4));
  let top = r.bottom + 6;
  if (top + tr.height > window.innerHeight - 4) top = r.top - tr.height - 6;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.classList.add('show');
}

function hide(): void {
  clearTimeout(timer);
  target = null;
  tip?.classList.remove('show');
}
