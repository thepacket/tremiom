/** Minimal, dependency-free Markdown → HTML renderer for notes panels.
 *  Supports: headings, bold/italic/code, links, unordered/ordered lists,
 *  blockquotes, horizontal rules, fenced code blocks, and paragraphs.
 *  All output is escaped first, so user text can't inject HTML. */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}

/** Inline spans: code, bold, italic, links. Operates on already-escaped text. */
function inline(s: string): string {
  // Inline code first (so its contents aren't further formatted).
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // Links [text](url) — only http(s)/relative, escaped already.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
    const safe = /^(https?:|\/|#|mailto:)/.test(u) ? u : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  // Bold then italic.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  return s;
}

export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src ?? '').split('\n');
  const out: string[] = [];
  let i = 0;
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (/^```/.test(line)) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    // Horizontal rule.
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue; }
    // Heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    // Blockquote.
    if (/^>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    // Unordered list item.
    if (/^\s*[-*+]\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`); i++; continue;
    }
    // Ordered list item.
    if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`); i++; continue;
    }
    // Blank line.
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }
    // Paragraph (gather consecutive non-blank, non-special lines).
    closeList();
    const buf: string[] = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
           !/^(#{1,6}\s|>|```|---|\*\*\*|___|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  closeList();
  return out.join('\n');
}
