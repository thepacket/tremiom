import type { SeismicEvent } from '../data/events';
import type { FilterSpec } from '../data/filters';
import {
  OPENROUTER_SETTINGS_EVENT,
  cachedOpenRouterModels,
  getOpenRouterSettings,
  loadOpenRouterModels,
  modelSupportsText,
  requestOpenRouterCompletion,
  responseSchemaForPrompt,
  type OpenRouterMessage,
} from '../ai/openrouter';
import { openSettings } from './settings';

const HEIGHT_KEY = 'tremiom-ai-terminal-height';
const COLLAPSED_KEY = 'tremiom-ai-terminal-collapsed';
const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 170;

export interface AiInstruction {
  type: 'set-mode' | 'select-event' | 'select-station' | 'set-filter' | 'set-units';
  value?: string;
  reason: string;
}

export interface AiSessionSnapshot {
  mode: 'live' | 'event' | 'history';
  selectedStation: string;
  selectedEvent: SeismicEvent | null;
  availableEvents: SeismicEvent[];
  availableStations: Array<{ nslc: string; lat: number; lon: number }>;
  visiblePlots: string[];
  filter: FilterSpec;
  units: string;
  plotFrames: Record<string, unknown>;
}

interface TerminalDeps {
  getSessionSnapshot(): AiSessionSnapshot;
  applyInstruction(instruction: AiInstruction): string;
}

interface ParsedResponse {
  message: string;
  actions: AiInstruction[];
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const EXAMPLE_PROMPTS = [
  ['Interpretation', 'Summarize the visible plots and identify the most scientifically significant features.'],
  ['Interpretation', 'What do the visible plots imply about the dominant signal and its likely source? State the uncertainty.'],
  ['Interpretation', 'If an event is selected, assess whether the visible evidence is consistent with its expected arrivals.'],
  ['Quality', 'Assess the current station’s data quality, including gaps, latency, noise, clipping, and artifacts visible in this session.'],
  ['Quality', 'Which conclusions are supported by the current data, and which would require additional plots or measurements?'],
  ['Processing', 'Evaluate the current filter and units. Would another setting make the signal easier to interpret?'],
  ['Processing', 'Recommend the most useful next Tremiom view or setting for investigating this signal, and explain why.'],
  ['Explanation', 'Explain the relevant seismological relationships using a concise Markdown table and LaTeX equations.'],
] as const;

const SYSTEM_PROMPT = `You are Tremiom's session-scoped AI seismology assistant.

Scope and scientific conduct:
- The SESSION_CONTEXT object supplied with each user turn is your entire observable world. Never imply access to events, stations, waveforms, plots, picks, servers, files, prior sessions, or upstream data that are absent.
- Tremiom/ObsPy measurements are evidence; your prose is interpretation. State uncertainty, data-quality limitations, and plausible alternatives. Predicted arrivals are not observed picks.
- Predicted P/S times describe a travel-time model only. Do not claim observed arrival alignment or moveout unless the context contains observed picks or onset times. A peak index is the location of a numeric maximum, not an event count or phase pick.
- selectedStation is the current UI control selection. It need not be the station used by every plot; use each plot summary's station or nslc as the authority for that plot and describe any difference explicitly.
- Global processing describes the current controls. When a plot summary has its own processing field, that plot-level field is authoritative. Counts are instrument units, but filtered counts are not raw/unfiltered data; reserve "raw" for filter kind none.
- Treat STA/LTA excursions as candidate detector activity requiring waveform confirmation. thresholdExcursion.crossingSegments counts contiguous above-threshold runs, which may be fragments of one signal and are not necessarily independent triggers or arrivals.
- Do not infer polarization from component RMS alone or a site resonance from one H/V peak alone. Comparable component RMS values neither establish an arrival nor count as evidence consistent with one.
- Spectral min/max range does not establish broadband energy. A spectral peak from raw counts describes the window's instrument-weighted spectrum, not necessarily ground-motion energy or an event phase. Approximately 0.1-0.3 Hz is conventionally the secondary microseism band, not the primary microseism band; do not attribute a peak there to surface waves without time-localized evidence.
- A spectrogram's single maximum bin gives only its time/frequency coordinate. It does not establish temporal concentration, bandwidth, duration, a transient, or correspondence with another detector unless the context supplies those measurements.
- All-positive samples and a large mean support a possible DC/baseline offset. Do not claim clipping or saturation without rail/plateau evidence. A predicted direct P or S outside the window does not prove samples are noise or exclude other phases and signals.
- Do not make an authoritative public-safety determination. Do not invent measurements. Refer to the exact plot or catalog fields supporting material claims.
- Prefer compact answers that directly address the request.

Input grammar:
SESSION_CONTEXT has mode, selectedStation, selectedEvent, visiblePlots, processing, and compact plotSummaries. Event and station catalogs are included only when relevant to the request. Arrays are summarized and never contain full-resolution waveforms.

Output grammar:
Return exactly one JSON object matching this schema: ${responseSchemaForPrompt()}
- message is the user-facing part. Markdown is the preferred format for all non-grammar content. Use GitHub-style Markdown tables when comparison helps. Write equations in LaTeX using $...$ or \\(...\\) for inline math and $$...$$ or \\[...\\] for display math.
- Because message is a JSON string, escape every LaTeX backslash as two JSON backslashes. Prefer $...$ and $$...$$ delimiters; for example, emit $$\\\\mathrm{RMS}=\\\\sqrt{N^{-1}\\\\sum_i x_i^2}$$ in the JSON source.
- actions are optional session-local UI instructions. Emit an action only when the user explicitly asks to change, apply, open, or select something; recommendations belong in message only. Use only IDs and choices present in SESSION_CONTEXT. The action value is: mode name, event ID, station NSLC, filter ID, or units name respectively.
- Never wrap the JSON object in Markdown fences. Do not place prose outside it.`;

export function mountAiTerminal(parent: HTMLElement, deps: TerminalDeps): void {
  const terminal = document.createElement('section');
  terminal.className = 'ai-terminal';
  terminal.innerHTML = `
    <div class="ai-terminal-splitter" title="Drag to resize AI terminal" aria-hidden="true"></div>
    <header class="ai-terminal-header">
      <button type="button" class="ai-collapse" title="Collapse AI terminal" aria-label="Collapse AI terminal">⌄</button>
      <span class="ai-terminal-title">AI</span>
      <span class="ai-terminal-model muted">OpenRouter not configured</span>
      <span class="ai-terminal-spacer"></span>
      <button type="button" class="ai-terminal-tool ai-copy" title="Copy the last prompt and AI reply as text" disabled>Copy text</button>
      <button type="button" class="ai-terminal-tool ai-copy-png" title="Copy the last AI reply as a PNG image" disabled>Copy PNG</button>
      <button type="button" class="ai-terminal-tool ai-clear" title="Clear this session's conversation">Clear</button>
      <button type="button" class="ai-terminal-tool ai-settings" title="Open AI settings">⚙</button>
    </header>
    <div class="ai-transcript" role="log" aria-live="polite"></div>
    <form class="ai-composer">
      <select class="ai-prompt-examples" aria-label="Choose an example AI prompt">
        <option value="">Example prompts…</option>
      </select>
      <textarea rows="2" placeholder="Ask about the current Tremiom session…" aria-label="Message Tremiom AI"></textarea>
      <button type="submit" class="ai-send">Send</button>
      <button type="button" class="ai-stop hidden">Stop</button>
    </form>`;
  parent.appendChild(terminal);

  const splitter = terminal.querySelector('.ai-terminal-splitter') as HTMLElement;
  const collapse = terminal.querySelector('.ai-collapse') as HTMLButtonElement;
  const modelLabel = terminal.querySelector('.ai-terminal-model') as HTMLElement;
  const transcript = terminal.querySelector('.ai-transcript') as HTMLElement;
  const form = terminal.querySelector('.ai-composer') as HTMLFormElement;
  const examples = terminal.querySelector('.ai-prompt-examples') as HTMLSelectElement;
  const input = terminal.querySelector('textarea') as HTMLTextAreaElement;
  const send = terminal.querySelector('.ai-send') as HTMLButtonElement;
  const stop = terminal.querySelector('.ai-stop') as HTMLButtonElement;
  const copy = terminal.querySelector('.ai-copy') as HTMLButtonElement;
  const copyPng = terminal.querySelector('.ai-copy-png') as HTMLButtonElement;
  const clear = terminal.querySelector('.ai-clear') as HTMLButtonElement;
  const settings = terminal.querySelector('.ai-settings') as HTMLButtonElement;

  const promptGroups = new Map<string, HTMLOptGroupElement>();
  for (const [groupName, prompt] of EXAMPLE_PROMPTS) {
    let group = promptGroups.get(groupName);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = groupName;
      promptGroups.set(groupName, group);
      examples.appendChild(group);
    }
    const option = document.createElement('option');
    option.value = prompt;
    option.textContent = prompt;
    group.appendChild(option);
  }

  let conversation: ConversationTurn[] = [];
  let lastExchange: { prompt: string; reply: string } | null = null;
  let controller: AbortController | null = null;
  let expandedHeight = clampHeight(Number(sessionStorage.getItem(HEIGHT_KEY)) || DEFAULT_HEIGHT);
  let collapsed = sessionStorage.getItem(COLLAPSED_KEY) === 'true';

  function applyLayout(): void {
    terminal.classList.toggle('collapsed', collapsed);
    collapse.textContent = collapsed ? '⌃' : '⌄';
    collapse.title = collapsed ? 'Expand AI terminal' : 'Collapse AI terminal';
    collapse.setAttribute('aria-label', collapse.title);
    const height = collapsed ? 34 : expandedHeight;
    document.documentElement.style.setProperty('--ai-terminal-h', `${height}px`);
    sessionStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }

  function refreshModelLabel(): void {
    const config = getOpenRouterSettings();
    if (!config.apiKey) modelLabel.textContent = 'OpenRouter not configured';
    else if (!config.modelId) modelLabel.textContent = 'Choose a model in Settings';
    else {
      const model = cachedOpenRouterModels().find((m) => m.id === config.modelId);
      modelLabel.textContent = model?.name || config.modelId;
      modelLabel.title = config.modelId;
    }
  }

  function appendMessage(role: 'user' | 'assistant' | 'notice' | 'error', content: string): HTMLElement {
    const row = document.createElement('article');
    row.className = `ai-message ${role}`;
    const label = document.createElement('div');
    label.className = 'ai-message-role';
    label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'AI' : role === 'error' ? 'Error' : 'Tremiom';
    const body = document.createElement('div');
    body.className = 'ai-message-body';
    if (role === 'assistant') {
      body.textContent = 'Rendering…';
      void import('../ai/markdown')
        .then(({ renderAiMarkdown }) => body.replaceChildren(renderAiMarkdown(content)))
        .catch(() => { body.textContent = content; });
    } else body.textContent = content;
    row.append(label, body);
    transcript.appendChild(row);
    transcript.scrollTop = transcript.scrollHeight;
    return row;
  }

  function setBusy(busy: boolean): void {
    input.disabled = busy;
    examples.disabled = busy;
    send.classList.toggle('hidden', busy);
    stop.classList.toggle('hidden', !busy);
  }

  async function submit(text: string): Promise<void> {
    const config = getOpenRouterSettings();
    if (!config.apiKey || !config.modelId) {
      appendMessage('notice', 'Add an OpenRouter API key and choose a model in Settings first.');
      openSettings();
      return;
    }
    appendMessage('user', text);
    conversation.push({ role: 'user', content: text });
    setBusy(true);
    controller = new AbortController();
    const waiting = appendMessage('notice', 'Analyzing the current session…');
    try {
      let models = cachedOpenRouterModels();
      if (!models.length) models = await loadOpenRouterModels(config.apiKey);
      const model = models.find((m) => m.id === config.modelId);
      if (!model) throw new Error('The selected model is no longer in OpenRouter’s catalog');
      if (!modelSupportsText(model)) throw new Error('The selected model does not produce text');

      const snapshot = compactSessionSnapshot(deps.getSessionSnapshot(), text);
      const recent = conversation.slice(-3);
      const messages: OpenRouterMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recent.slice(0, -1),
        {
          role: 'user',
          content: `${text}\n\nSESSION_CONTEXT:\n${JSON.stringify(snapshot)}`,
        },
      ];
      const completion = await requestOpenRouterCompletion({
        apiKey: config.apiKey,
        model,
        messages,
        signal: controller.signal,
      });
      waiting.remove();
      const parsed = parseResponse(completion.content);
      appendMessage('assistant', parsed.message);
      conversation.push({ role: 'assistant', content: parsed.message });
      lastExchange = { prompt: text, reply: parsed.message };
      copy.disabled = false;
      copyPng.disabled = false;
      for (const action of parsed.actions) {
        const result = deps.applyInstruction(action);
        appendMessage('notice', result);
      }
      if (completion.usage?.total_tokens != null) {
        const usage = document.createElement('div');
        usage.className = 'ai-usage';
        const parts = [
          completion.usage.prompt_tokens != null
            ? `${completion.usage.prompt_tokens.toLocaleString()} in` : '',
          completion.usage.completion_tokens != null
            ? `${completion.usage.completion_tokens.toLocaleString()} out` : '',
        ].filter(Boolean).join(' + ');
        usage.textContent = `${completion.model} · ${completion.usage.total_tokens.toLocaleString()} tokens${parts ? ` (${parts})` : ''}`;
        transcript.appendChild(usage);
      }
      transcript.scrollTop = transcript.scrollHeight;
    } catch (error) {
      waiting.remove();
      if ((error as Error).name !== 'AbortError') appendMessage('error', (error as Error).message);
      else appendMessage('notice', 'Request stopped.');
    } finally {
      controller = null;
      setBusy(false);
      input.focus();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || controller) return;
    input.value = '';
    void submit(text);
  });
  examples.addEventListener('change', () => {
    if (!examples.value) return;
    input.value = examples.value;
    examples.value = '';
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  stop.addEventListener('click', () => controller?.abort());
  settings.addEventListener('click', openSettings);
  copy.addEventListener('click', () => {
    if (!lastExchange) return;
    const text = `Prompt:\n${lastExchange.prompt}\n\nAI reply:\n${lastExchange.reply}`;
    void copyTextToClipboard(text).then((copied) => {
      if (!copied) {
        appendMessage('error', 'Could not access the clipboard. Check this site’s browser permissions.');
        return;
      }
      copy.textContent = 'Copied';
      window.setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
    });
  });
  copyPng.addEventListener('click', () => {
    if (!lastExchange) return;
    const original = copyPng.textContent;
    copyPng.disabled = true;
    copyPng.textContent = 'Rendering…';
    void copyMarkdownPngToClipboard(lastExchange.reply)
      .then(() => {
        copyPng.textContent = 'PNG copied';
        window.setTimeout(() => { copyPng.textContent = original; }, 1400);
      })
      .catch((error) => {
        copyPng.textContent = original;
        appendMessage('error', (error as Error).message);
      })
      .finally(() => { copyPng.disabled = false; });
  });
  clear.addEventListener('click', () => {
    conversation = [];
    lastExchange = null;
    copy.disabled = true;
    copyPng.disabled = true;
    transcript.innerHTML = '';
    appendMessage('notice', 'Conversation cleared. The current Tremiom session data is unchanged.');
  });
  collapse.addEventListener('click', () => { collapsed = !collapsed; applyLayout(); });
  window.addEventListener(OPENROUTER_SETTINGS_EVENT, refreshModelLabel);

  let dragging = false;
  splitter.addEventListener('pointerdown', (event) => {
    if (collapsed) return;
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
    document.body.style.userSelect = 'none';
  });
  splitter.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    expandedHeight = clampHeight(window.innerHeight - event.clientY - 24);
    document.documentElement.style.setProperty('--ai-terminal-h', `${expandedHeight}px`);
  });
  const stopDragging = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    sessionStorage.setItem(HEIGHT_KEY, String(expandedHeight));
    try { splitter.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
  };
  splitter.addEventListener('pointerup', stopDragging);
  splitter.addEventListener('pointercancel', stopDragging);

  appendMessage('notice', 'This assistant can use only compact data summaries from the current browser session. Configure OpenRouter in Settings to begin.');
  applyLayout();
  refreshModelLabel();
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

async function copyMarkdownPngToClipboard(markdown: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('This browser does not support copying PNG images to the clipboard.');
  }
  const blob = await renderMarkdownPng(markdown);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** Render the fully formatted Markdown/KaTeX reply through an SVG foreign
 * object, then rasterize it. Computed styles are inlined so the clipboard
 * image keeps Tremiom's table, code, and math appearance. */
async function renderMarkdownPng(markdown: string): Promise<Blob> {
  const { renderAiMarkdown } = await import('../ai/markdown');
  const stage = document.createElement('div');
  stage.className = 'ai-message-body ai-png-stage';
  stage.replaceChildren(renderAiMarkdown(markdown));
  document.body.appendChild(stage);
  try {
    await document.fonts?.ready;
    await nextAnimationFrame();

    const wideContent = [...stage.querySelectorAll<HTMLElement>('table, pre, .ai-math-block')]
      .reduce((width, element) => Math.max(width, element.scrollWidth + 48), 0);
    const width = Math.ceil(Math.min(1600, Math.max(760, 1100, wideContent)));
    stage.style.width = `${width}px`;
    await nextAnimationFrame();
    const height = Math.ceil(stage.scrollHeight);
    if (!height || height > 30_000) {
      throw new Error('The AI reply is too tall to copy as one PNG image.');
    }

    const clone = stage.cloneNode(true) as HTMLElement;
    inlineComputedStyles(stage, clone);
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    clone.style.position = 'static';
    clone.style.left = 'auto';
    clone.style.top = 'auto';
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;
    clone.style.overflow = 'hidden';

    const serialized = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const sourcePixels = width * height;
      const scale = Math.max(1, Math.min(2, Math.sqrt(24_000_000 / sourcePixels)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create the PNG drawing surface.');
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, width, height);
      return await canvasPngBlob(canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    stage.remove();
  }
}

function inlineComputedStyles(source: HTMLElement, target: HTMLElement): void {
  const computed = getComputedStyle(source);
  for (const property of computed) {
    target.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
  }
  const sourceChildren = source.children;
  const targetChildren = target.children;
  for (let i = 0; i < sourceChildren.length; i++) {
    const sourceChild = sourceChildren[i];
    const targetChild = targetChildren[i];
    if (sourceChild instanceof HTMLElement && targetChild instanceof HTMLElement) {
      inlineComputedStyles(sourceChild, targetChild);
    }
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error('The browser could not encode the AI reply as PNG.'));
  }, 'image/png'));
}

function clampHeight(height: number): number {
  return Math.max(MIN_HEIGHT, Math.min(window.innerHeight * 0.72, Math.round(height)));
}

export function parseResponse(raw: string): ParsedResponse {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Read the message with a small JSON-string scanner before JSON.parse.
  // Some providers emit single LaTeX backslashes inside the nested JSON
  // string. Sequences such as \frac and \right then become JSON control
  // escapes (or make JSON invalid), destroying otherwise valid equations.
  const recoveredMessage = extractJsonMessage(trimmed);
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown; actions?: unknown };
    if (typeof parsed.message !== 'string') throw new Error('missing message');
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.filter(isInstruction).slice(0, 8)
      : [];
    return { message: recoveredMessage ?? parsed.message, actions };
  } catch {
    if (recoveredMessage != null) return { message: recoveredMessage, actions: [] };
    if (/^\s*\{\s*"message"\s*:/.test(trimmed)) {
      throw new Error('The AI returned an incomplete structured response. Try again or request a shorter answer.');
    }
    // Models without structured-output support occasionally answer directly.
    // Render that answer safely rather than discarding a useful completion.
    return { message: raw, actions: [] };
  }
}

/** Decode the top-level JSON message while preserving improperly unescaped
 * LaTeX commands. Correct JSON escapes continue to decode normally. */
function extractJsonMessage(raw: string): string | null {
  const match = /"message"\s*:\s*"/.exec(raw);
  if (!match) return null;
  let i = match.index + match[0].length;
  let result = '';
  let inMath = false;
  while (i < raw.length) {
    const char = raw[i];
    if (char === '"') return result;
    if (char === '$') {
      if (raw[i + 1] === '$') {
        inMath = !inMath;
        result += '$$';
        i += 2;
      } else {
        inMath = !inMath;
        result += '$';
        i++;
      }
      continue;
    }
    if (char !== '\\') {
      result += char;
      i++;
      continue;
    }

    const escaped = raw[i + 1];
    if (escaped == null) return null;
    if (escaped === '\\') {
      const delimiter = raw[i + 2];
      if (delimiter === '[' || delimiter === '(') inMath = true;
      else if (delimiter === ']' || delimiter === ')') inMath = false;
      result += '\\';
      i += 2;
      continue;
    }
    if (escaped === '[' || escaped === '(') {
      inMath = true;
      result += `\\${escaped}`;
      i += 2;
      continue;
    }
    if (escaped === ']' || escaped === ')') {
      inMath = false;
      result += `\\${escaped}`;
      i += 2;
      continue;
    }
    // Within math, a single slash followed by a command name is the common
    // malformed-provider case. Preserve it instead of interpreting \frac as
    // JSON's form-feed escape, \right as carriage return, and so on.
    if (inMath && /[A-Za-z]/.test(escaped) && /[A-Za-z]/.test(raw[i + 2] || '')) {
      result += `\\${escaped}`;
      i += 2;
      continue;
    }
    if (escaped === '"' || escaped === '/' ) result += escaped;
    else if (escaped === 'b') result += '\b';
    else if (escaped === 'f') result += '\f';
    else if (escaped === 'n') result += '\n';
    else if (escaped === 'r') result += '\r';
    else if (escaped === 't') result += '\t';
    else if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
      result += String.fromCharCode(Number.parseInt(raw.slice(i + 2, i + 6), 16));
      i += 6;
      continue;
    } else {
      // Preserve any other invalid escape. It is more likely a LaTeX command
      // than an intentional character deletion in an AI Markdown response.
      result += `\\${escaped}`;
    }
    i += 2;
  }
  return null;
}

function isInstruction(value: unknown): value is AiInstruction {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return typeof a.type === 'string' &&
    ['set-mode', 'select-event', 'select-station', 'set-filter', 'set-units'].includes(a.type) &&
    typeof a.reason === 'string' &&
    (a.value == null || typeof a.value === 'string');
}

function compactSessionSnapshot(snapshot: AiSessionSnapshot, request: string): Record<string, unknown> {
  const selectedEvent = snapshot.selectedEvent ? compactEvent(snapshot.selectedEvent) : null;
  const includeEventCatalog = /\b(available|catalog|list|sequence|cluster|compare|choose|select|open|other)\b.*\b(events?|earthquakes?)\b|\b(events?|earthquakes?)\b.*\b(available|catalog|list|sequence|cluster|compare|choose|select|open|other)\b/i.test(request);
  const includeStationCatalog = /\b(available|catalog|list|compare|choose|select|change|switch|other)\b.*\bstations?\b|\bstations?\b.*\b(available|catalog|list|compare|choose|select|change|switch|other)\b/i.test(request);
  const includeProcessingChoices = /\b(filters?|units?|processing|band.?pass|velocity|displacement|acceleration|wood.?anderson)\b/i.test(request);
  return {
    contextKind: 'current-session',
    generatedAt: new Date().toISOString(),
    mode: snapshot.mode,
    selectedStation: snapshot.selectedStation,
    selectedEvent,
    availableEventCount: snapshot.availableEvents.length,
    ...(includeEventCatalog ? {
      availableEvents: snapshot.availableEvents.slice(0, 10).map(compactCatalogEvent),
    } : {}),
    availableStationCount: snapshot.availableStations.length,
    ...(includeStationCatalog ? { availableStations: snapshot.availableStations } : {}),
    visiblePlots: snapshot.visiblePlots,
    processing: { units: snapshot.units, filter: snapshot.filter },
    ...(includeProcessingChoices ? {
      availableFilters: [
        'raw', 'dc-removed', 'local-quake', 'regional', 'teleseismic-body',
        'microseism', 'surface-waves', 'slow-signal',
      ],
      availableUnits: ['counts', 'velocity', 'displacement', 'acceleration', 'wood-anderson'],
    } : {}),
    plotSummaries: Object.fromEntries(
      Object.entries(snapshot.plotFrames)
        .filter(([id]) => snapshot.visiblePlots.includes(id))
        .map(([id, frame]) => [id, summarizeFrame(id, frame)]),
    ),
  };
}

function compactCatalogEvent(event: SeismicEvent): Record<string, unknown> {
  return {
    id: event.id,
    magnitude: event.mag,
    place: event.place,
    originTime: new Date(event.timeMs).toISOString(),
    depthKm: event.depthKm,
  };
}

function compactEvent(event: SeismicEvent): Record<string, unknown> {
  return {
    id: event.id,
    magnitude: event.mag,
    place: event.place,
    originTime: new Date(event.timeMs).toISOString(),
    depthKm: event.depthKm,
    latitudeDeg: event.lat,
    longitudeDeg: event.lon,
    feltReports: event.felt,
    communityIntensityMmi: event.cdi,
    instrumentalIntensityMmi: event.mmi,
    tsunamiFlag: event.tsunami,
    alertLevel: event.alert,
  };
}

function summarizeFrame(plotId: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return { status: 'unavailable' };
  const frame = value as Record<string, unknown>;
  const summary: Record<string, unknown> = { status: 'ready' };
  if (frame.processing && typeof frame.processing === 'object') {
    summary.processing = frame.processing;
  }
  for (const key of [
    'station', 'nslc', 'eventId', 'component', 't', 't0Ms', 'originTimeMs',
    'startMs', 'endMs', 'windowS', 'durS', 'binMs', 'depthKm', 'sr', 'unit', 'fMinHz', 'fMaxHz',
    'threshold', 'staWinS', 'ltaWinS', 'peakHz', 'latencyS', 'availPct', 'fillPct',
    'bufferSecs', 'rms', 'binS', 'bucketS', 'rows', 'cols', 'chN', 'chE',
  ]) {
    const v = frame[key];
    if (typeof v === 'string' || typeof v === 'number' || v === null) summary[key] = v;
  }
  if (Array.isArray(frame.data)) {
    const stats = numericStats(frame.data);
    Object.assign(summary, stats);
    if (['spectrum', 'psd', 'spectrogram'].includes(plotId) && stats.peakIndex != null &&
        typeof frame.fMinHz === 'number' && typeof frame.fMaxHz === 'number') {
      summary.peakFrequencyHz = frame.fMinHz +
        (stats.peakIndex / Math.max(1, frame.data.length - 1)) * (frame.fMaxHz - frame.fMinHz);
    }
    if (plotId === 'sta-lta' && typeof frame.threshold === 'number') {
      let aboveN = 0, crossingSegments = 0, above = false;
      for (const value of frame.data) {
        const next = typeof value === 'number' && Number.isFinite(value) && value >= frame.threshold;
        if (next) aboveN++;
        if (next && !above) crossingSegments++;
        above = next;
      }
      summary.thresholdExcursion = {
        aboveN,
        crossingSegments,
        fraction: compactNumber(aboveN / Math.max(1, frame.data.length)),
      };
    }
  }
  if (Array.isArray(frame.components)) {
    summary.components = frame.components.slice(0, 3).map((component) => {
      const c = component as { label?: unknown; data?: unknown };
      return { label: c.label, ...numericStats(Array.isArray(c.data) ? c.data : []) };
    });
  }
  if (Array.isArray(frame.n) && Array.isArray(frame.e)) {
    summary.north = numericStats(frame.n);
    summary.east = numericStats(frame.e);
  }
  if (Array.isArray(frame.min) && Array.isArray(frame.max)) {
    summary.minimumEnvelope = numericStats(frame.min);
    summary.maximumEnvelope = numericStats(frame.max);
  }
  if (Array.isArray(frame.columns)) {
    const columns = frame.columns.filter(Array.isArray) as unknown[][];
    const matrix = numericStats(columns.flat());
    summary.matrix = matrix;
    summary.matrixColumns = columns.length;
    summary.matrixBins = columns[0]?.length || 0;
    if (matrix.peakIndex != null && columns.length && columns[0]?.length) {
      const bins = columns[0].length;
      const peakColumn = Math.floor(matrix.peakIndex / bins);
      const peakBin = matrix.peakIndex % bins;
      summary.matrixPeak = {
        column: peakColumn,
        bin: peakBin,
        timeFraction: compactNumber(peakColumn / Math.max(1, columns.length - 1)),
        frequencyHz: typeof frame.fMinHz === 'number' && typeof frame.fMaxHz === 'number'
          ? compactNumber(frame.fMinHz + peakBin / Math.max(1, bins - 1) *
            (frame.fMaxHz - frame.fMinHz))
          : null,
      };
    }
  }
  if (plotId === 'record-section' && Array.isArray(frame.stations)) {
    summary.windowSecs = frame.windowSecs;
    summary.stationCount = frame.stations.length;
    summary.unavailableStationCount = Array.isArray(frame.errors) ? frame.errors.length : 0;
    summary.stations = frame.stations.slice(0, 6).map((value) => {
      const station = value as Record<string, unknown>;
      const window = Array.isArray(frame.windowSecs) ? frame.windowSecs : [];
      const pre = typeof window[0] === 'number' ? window[0] : null;
      const post = typeof window[1] === 'number' ? window[1] : null;
      const predictedP = typeof station.pArrivalS === 'number' ? station.pArrivalS : null;
      const predictedS = typeof station.sArrivalS === 'number' ? station.sArrivalS : null;
      return {
        nslc: station.nslc,
        distKm: station.distKm,
        distDeg: station.distDeg,
        predictedPS: predictedP,
        predictedPInWindow: predictedP != null && pre != null && post != null
          ? predictedP >= pre && predictedP <= post : null,
        predictedSS: predictedS,
        predictedSInWindow: predictedS != null && pre != null && post != null
          ? predictedS >= pre && predictedS <= post : null,
        start: typeof station.t0Ms === 'number' ? new Date(station.t0Ms).toISOString() : null,
        srHz: station.sr,
        waveform: numericStats(Array.isArray(station.data) ? station.data : []),
      };
    });
  }
  return summary;
}

function numericStats(values: unknown[]): {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
  peakIndex: number | null;
} {
  let count = 0, sum = 0, sumSq = 0, minimum = Infinity, maximum = -Infinity, peakIndex = -1;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    count++; sum += value; sumSq += value * value;
    if (value < minimum) minimum = value;
    if (value > maximum) { maximum = value; peakIndex = i; }
  }
  return {
    n: count,
    min: count ? compactNumber(minimum) : null,
    max: count ? compactNumber(maximum) : null,
    mean: count ? compactNumber(sum / count) : null,
    rms: count ? compactNumber(Math.sqrt(sumSq / count)) : null,
    peakIndex: count ? peakIndex : null,
  };
}

function compactNumber(value: number): number {
  return Number(value.toPrecision(6));
}
