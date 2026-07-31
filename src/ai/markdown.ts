import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

function protectMath(markdown: string): string {
  const block = (tex: string) =>
    `<div class="ai-math-block" data-ai-math="${encodeURIComponent(tex.trim())}"></div>`;
  const inline = (tex: string) =>
    `<span class="ai-math-inline" data-ai-math="${encodeURIComponent(tex.trim())}"></span>`;

  // Accept both Markdown-style dollar delimiters and conventional LaTeX
  // delimiters. Protect them before Marked parses the surrounding prose.
  const withBlocks = markdown
    .replace(/\$\$([\s\S]+?)\$\$/g, (_all, latex: string) => block(latex))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_all, latex: string) => block(latex));
  return withBlocks
    .replace(/\\\(([^\n]+?)\\\)/g, (_all, latex: string) => inline(latex))
    .replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_all, prefix: string, latex: string) =>
      `${prefix}${inline(latex)}`);
}

export function renderAiMarkdown(markdown: string): DocumentFragment {
  const template = document.createElement('template');
  const parsed = marked.parse(protectMath(markdown), { async: false }) as string;
  template.innerHTML = DOMPurify.sanitize(parsed, {
    ADD_ATTR: ['data-ai-math'],
  });

  for (const el of template.content.querySelectorAll<HTMLElement>('[data-ai-math]')) {
    const encoded = el.dataset.aiMath || '';
    let tex = '';
    try { tex = decodeURIComponent(encoded); } catch { tex = encoded; }
    try {
      katex.render(tex, el, {
        displayMode: el.classList.contains('ai-math-block'),
        throwOnError: false,
        strict: 'warn',
        trust: false,
      });
    } catch {
      el.textContent = tex;
    }
  }

  for (const link of template.content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    try {
      const u = new URL(link.href, location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        link.removeAttribute('href');
      }
    } catch { link.removeAttribute('href'); }
  }
  return template.content;
}
