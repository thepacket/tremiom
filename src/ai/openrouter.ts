export const OPENROUTER_SETTINGS_EVENT = 'tremiom:openrouter-settings';

const KEY_STORAGE = 'tremiom-openrouter-key';
const MODEL_STORAGE = 'tremiom-openrouter-model';
const MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=all';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
  };
  supported_parameters?: string[];
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[] | null;
    default_effort?: string;
  };
}

export interface OpenRouterSettings {
  apiKey: string;
  modelId: string;
}

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterCompletion {
  content: string;
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

let modelsCache: OpenRouterModel[] | null = null;

function sessionGet(key: string): string {
  try { return sessionStorage.getItem(key) || ''; }
  catch { return ''; }
}

function sessionSet(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* storage disabled — settings remain unavailable after the modal closes */ }
}

export function getOpenRouterSettings(): OpenRouterSettings {
  return {
    apiKey: sessionGet(KEY_STORAGE),
    modelId: sessionGet(MODEL_STORAGE),
  };
}

export function setOpenRouterSettings(settings: OpenRouterSettings): void {
  sessionSet(KEY_STORAGE, settings.apiKey.trim());
  sessionSet(MODEL_STORAGE, settings.modelId.trim());
  window.dispatchEvent(new CustomEvent(OPENROUTER_SETTINGS_EVENT));
}

export function clearOpenRouterSettings(): void {
  sessionSet(KEY_STORAGE, '');
  sessionSet(MODEL_STORAGE, '');
  modelsCache = null;
  window.dispatchEvent(new CustomEvent(OPENROUTER_SETTINGS_EVENT));
}

function attributionHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-OpenRouter-Title': 'Tremiom',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (location.origin.startsWith('http')) headers['HTTP-Referer'] = location.origin;
  return headers;
}

export function modelSupportsText(model: OpenRouterModel): boolean {
  const outputs = model.architecture?.output_modalities;
  return !outputs?.length || outputs.includes('text');
}

export function modelSupportsStructuredOutput(model: OpenRouterModel | undefined): boolean {
  const params = model?.supported_parameters || [];
  // `response_format` can mean JSON-object mode only. OpenRouter advertises
  // JSON Schema compatibility separately as `structured_outputs`.
  return params.includes('structured_outputs');
}

export async function loadOpenRouterModels(
  apiKey: string,
  opts: { force?: boolean } = {},
): Promise<OpenRouterModel[]> {
  if (modelsCache && !opts.force) return modelsCache;
  const r = await fetch(MODELS_URL, {
    headers: attributionHeaders(apiKey.trim()),
  });
  const body = await r.json().catch(() => ({})) as {
    data?: OpenRouterModel[];
    error?: { message?: string };
  };
  if (!r.ok) throw new Error(body.error?.message || `OpenRouter models HTTP ${r.status}`);
  if (!Array.isArray(body.data)) throw new Error('OpenRouter returned a malformed model catalog');
  modelsCache = body.data
    .filter((m) => typeof m?.id === 'string' && typeof m?.name === 'string')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return modelsCache;
}

export function cachedOpenRouterModels(): OpenRouterModel[] {
  return modelsCache ? [...modelsCache] : [];
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'actions'],
  properties: {
    message: {
      type: 'string',
      description: 'User-facing Markdown. Use Markdown tables and LaTeX equations when useful.',
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'reason', 'value'],
        properties: {
          type: {
            enum: ['set-mode', 'select-event', 'select-station', 'set-filter', 'set-units'],
          },
          reason: { type: 'string' },
          value: {
            type: ['string', 'null'],
            description: 'Instruction value, or null when the instruction does not need one.',
          },
        },
      },
    },
  },
} as const;

export async function requestOpenRouterCompletion(args: {
  apiKey: string;
  model: OpenRouterModel;
  messages: OpenRouterMessage[];
  signal?: AbortSignal;
}): Promise<OpenRouterCompletion> {
  const structured = modelSupportsStructuredOutput(args.model);
  const supported = new Set(args.model.supported_parameters || []);
  const jsonObjectMode = !structured && supported.has('response_format');
  const requestBody: Record<string, unknown> = {
    model: args.model.id,
    messages: args.messages,
    stream: false,
  };
  const reasoningEfforts = args.model.reasoning?.supported_efforts;
  const reasoningEffort = supported.has('reasoning')
    ? (reasoningEfforts == null || reasoningEfforts.includes('low') ? 'low'
      : reasoningEfforts?.includes('minimal') ? 'minimal' : null)
    : null;
  if (reasoningEffort) {
    requestBody.reasoning = { effort: reasoningEffort, exclude: true };
  }
  // Structured Markdown with equations and tables needs enough room for the
  // closing JSON envelope. Providers may otherwise return an unusable partial
  // object even though most of the prose was generated.
  const outputLimit = reasoningEffort ? 3200 : 2400;
  if (supported.has('max_completion_tokens')) requestBody.max_completion_tokens = outputLimit;
  else if (supported.has('max_tokens')) requestBody.max_tokens = outputLimit;
  if (structured) {
    requestBody.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'tremiom_session_response',
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    };
    requestBody.provider = { require_parameters: true };
  } else if (jsonObjectMode) {
    // Some models support JSON-object mode but not JSON Schema. The system
    // prompt still supplies the exact Tremiom grammar for those models.
    requestBody.response_format = { type: 'json_object' };
  }
  const r = await fetch(CHAT_URL, {
    method: 'POST',
    headers: attributionHeaders(args.apiKey),
    body: JSON.stringify(requestBody),
    signal: args.signal,
  });
  const body = await r.json().catch(() => ({})) as {
    model?: string;
    choices?: Array<{
      finish_reason?: string;
      native_finish_reason?: string;
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
        reasoning?: string;
      };
    }>;
    usage?: OpenRouterCompletion['usage'];
    error?: {
      message?: string;
      code?: number | string;
      metadata?: Record<string, unknown>;
    };
    error_type?: string;
  };
  if (!r.ok || body.error) throw new Error(formatOpenRouterError(body, r.status));
  const choice = body.choices?.[0];
  const raw = choice?.message?.content;
  const content = typeof raw === 'string'
    ? raw
    : Array.isArray(raw) ? raw.map((part) => part.text || '').join('') : '';
  if (!content) {
    const finish = choice?.finish_reason || choice?.native_finish_reason;
    const reason = finish ? ` (finish reason: ${finish})` : '';
    throw new Error(`OpenRouter returned no final answer${reason}. Try again or choose a lower-reasoning model.`);
  }
  const finish = choice?.finish_reason || choice?.native_finish_reason;
  if (finish === 'length' || finish === 'max_tokens') {
    throw new Error('OpenRouter truncated the AI response at its output limit. Try again or request a shorter answer.');
  }
  return { content, model: body.model || args.model.id, usage: body.usage };
}

function formatOpenRouterError(body: {
  error?: { message?: string; code?: number | string; metadata?: Record<string, unknown> };
  error_type?: string;
}, status: number): string {
  const error = body.error;
  const message = error?.message || `OpenRouter chat HTTP ${status}`;
  const metadata = error?.metadata;
  const provider = typeof metadata?.provider_name === 'string' ? metadata.provider_name : '';
  const raw = metadata?.raw ?? metadata?.provider_error;
  let detail = '';
  if (typeof raw === 'string') detail = raw;
  else if (raw && typeof raw === 'object') {
    try { detail = JSON.stringify(raw); } catch { /* ignore malformed provider metadata */ }
  }
  const qualifiers = [
    body.error_type || '',
    provider ? `provider: ${provider}` : '',
    detail ? detail.slice(0, 500) : '',
  ].filter(Boolean);
  return qualifiers.length ? `${message} (${qualifiers.join(' · ')})` : message;
}

export function responseSchemaForPrompt(): string {
  return JSON.stringify(RESPONSE_SCHEMA);
}
