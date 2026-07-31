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
- Do not make an authoritative public-safety determination. Do not invent measurements. Refer to the exact plot or catalog fields supporting material claims.
- Prefer compact answers that directly address the request.

Input grammar:
SESSION_CONTEXT has mode, selectedStation, selectedEvent, availableEvents, availableStations, visiblePlots, processing, and compact plotSummaries. Arrays are summarized and never contain full-resolution waveforms.

Output grammar:
Return exactly one JSON object matching this schema: ${responseSchemaForPrompt()}
- message is the user-facing part. Markdown is the preferred format for all non-grammar content. Use GitHub-style Markdown tables when comparison helps. Write equations in LaTeX using $...$ or \\(...\\) for inline math and $$...$$ or \\[...\\] for display math.
- actions are optional session-local UI instructions. Use only IDs and choices present in SESSION_CONTEXT. The action value is: mode name, event ID, station NSLC, filter ID, or units name respectively.
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
      const recent = conversation.slice(-10);
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
      for (const action of parsed.actions) {
        const result = deps.applyInstruction(action);
        appendMessage('notice', result);
      }
      if (completion.usage?.total_tokens != null) {
        const usage = document.createElement('div');
        usage.className = 'ai-usage';
        usage.textContent = `${completion.model} · ${completion.usage.total_tokens.toLocaleString()} tokens`;
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
  clear.addEventListener('click', () => {
    conversation = [];
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

function clampHeight(height: number): number {
  return Math.max(MIN_HEIGHT, Math.min(window.innerHeight * 0.72, Math.round(height)));
}

function parseResponse(raw: string): ParsedResponse {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown; actions?: unknown };
    if (typeof parsed.message !== 'string') throw new Error('missing message');
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.filter(isInstruction).slice(0, 8)
      : [];
    return { message: parsed.message, actions };
  } catch {
    // Models without structured-output support occasionally answer directly.
    // Render that answer safely rather than discarding a useful completion.
    return { message: raw, actions: [] };
  }
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
  return {
    contextKind: 'current-session',
    generatedAt: new Date().toISOString(),
    request,
    mode: snapshot.mode,
    selectedStation: snapshot.selectedStation,
    selectedEvent,
    availableEvents: snapshot.availableEvents.slice(0, 25).map(compactEvent),
    availableStations: snapshot.availableStations,
    visiblePlots: snapshot.visiblePlots,
    processing: { units: snapshot.units, filter: snapshot.filter },
    availableFilters: [
      'raw', 'dc-removed', 'local-quake', 'regional', 'teleseismic-body',
      'microseism', 'surface-waves', 'slow-signal',
    ],
    availableUnits: ['counts', 'velocity', 'displacement', 'acceleration', 'wood-anderson'],
    plotSummaries: Object.fromEntries(
      Object.entries(snapshot.plotFrames)
        .filter(([id]) => snapshot.visiblePlots.includes(id))
        .map(([id, frame]) => [id, summarizeFrame(id, frame)]),
    ),
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
  for (const key of [
    'station', 't', 'startMs', 'endMs', 'windowS', 'sr', 'unit', 'fMinHz', 'fMaxHz',
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
  return summary;
}

function numericStats(values: unknown[]): {
  count: number;
  minimum: number | null;
  maximum: number | null;
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
    count,
    minimum: count ? minimum : null,
    maximum: count ? maximum : null,
    mean: count ? sum / count : null,
    rms: count ? Math.sqrt(sumSq / count) : null,
    peakIndex: count ? peakIndex : null,
  };
}
