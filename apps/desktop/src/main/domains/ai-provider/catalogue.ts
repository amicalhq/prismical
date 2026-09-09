/**
 * Provider defaults + the live model catalogue fetch. Pure
 * over an injected fetch so the listing rules are unit-testable without a
 * network; AiProviderLive caches the results briefly.
 */
import type { AiModelListing, AiProviderKind } from '@prismical/desktop-contracts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderDefaults {
  /** The endpoint when the setting's `baseUrl` is null (null = the SDK's own default). */
  readonly baseUrl: string | null;
  /** The model when the setting's `model` is null (null = the user must pick one). */
  readonly model: string | null;
  /** Whether a run is impossible without a stored API key. */
  readonly needsKey: boolean;
  /** Whether a run is impossible without a base URL (the provider has no public default). */
  readonly needsBaseUrl: boolean;
}

export const PROVIDER_DEFAULTS: Record<AiProviderKind, ProviderDefaults> = {
  openai: { baseUrl: null, model: 'gpt-5', needsKey: true, needsBaseUrl: false },
  anthropic: { baseUrl: null, model: 'claude-opus-5', needsKey: true, needsBaseUrl: false },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    needsKey: true,
    needsBaseUrl: false,
  },
  'openai-compatible': { baseUrl: null, model: null, needsKey: false, needsBaseUrl: true },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: null, needsKey: false, needsBaseUrl: false },
};

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
export const OPENAI_API_URL = 'https://api.openai.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

/** Trailing slashes off; a bare Ollama host gains the OpenAI-compatible `/v1` suffix for chat. */
export const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');

/** Ollama speaks OpenAI's chat protocol under `/v1`; its own API (tags) lives at the root. */
export const ollamaChatBaseUrl = (host: string): string => {
  const base = normalizeBaseUrl(host);
  return base.endsWith('/v1') ? base : `${base}/v1`;
};
export const ollamaHost = (host: string): string => normalizeBaseUrl(host).replace(/\/v1$/, '');

/**
 * OpenAI's `/v1/models` lists everything the key can reach — embeddings,
 * audio, image, moderation and realtime models included, none of which can
 * run a chat with tools. Keep the chat families, drop the modality suffixes.
 */
const OPENAI_CHAT_FAMILY = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_NON_CHAT =
  /(audio|realtime|tts|transcribe|embedding|image|moderation|instruct|search|dall-e|whisper|codex)/;
export const isOpenAiChatModel = (id: string): boolean =>
  OPENAI_CHAT_FAMILY.test(id) && !OPENAI_NON_CHAT.test(id);

const asIds = (value: unknown, key: 'id' | 'name'): string[] => {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (entry !== null && typeof entry === 'object') {
      const id = (entry as Record<string, unknown>)[key];
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  return ids;
};

export const CATALOGUE_TIMEOUT_MS = 8_000;

/**
 * Fetch a provider's model ids. Never throws: every failure folds to an empty
 * list with a reason the settings card can show. The key is sent ONLY to the
 * provider's own endpoint and never appears in the result or in any error.
 */
export async function fetchModelListing(args: {
  readonly provider: AiProviderKind;
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
  readonly fetchFn: FetchLike;
}): Promise<AiModelListing> {
  const { provider, apiKey } = args;
  const defaults = PROVIDER_DEFAULTS[provider];
  if (defaults.needsKey && !apiKey) return { models: [], error: 'not-configured' };
  if (defaults.needsBaseUrl && !args.baseUrl) return { models: [], error: 'not-configured' };

  let url: string;
  let headers: Record<string, string>;
  let idKey: 'id' | 'name' = 'id';
  let pick = (ids: string[]): string[] => ids;
  switch (provider) {
    case 'openai':
      url = `${normalizeBaseUrl(args.baseUrl ?? OPENAI_API_URL)}/models`;
      headers = { Authorization: `Bearer ${apiKey}` };
      pick = ids => ids.filter(isOpenAiChatModel);
      break;
    case 'anthropic':
      url = `${normalizeBaseUrl(args.baseUrl ?? ANTHROPIC_API_URL)}/v1/models?limit=100`;
      headers = { 'x-api-key': apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION };
      break;
    case 'openrouter':
    case 'openai-compatible':
      url = `${normalizeBaseUrl(args.baseUrl ?? defaults.baseUrl ?? '')}/models`;
      headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      break;
    case 'ollama':
      url = `${ollamaHost(args.baseUrl ?? defaults.baseUrl ?? '')}/api/tags`;
      headers = {};
      idKey = 'name';
      break;
  }

  let response: Response;
  try {
    response = await args.fetchFn(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
    });
  } catch {
    return { models: [], error: 'network' };
  }
  if (response.status === 401 || response.status === 403) {
    return { models: [], error: 'unauthorized' };
  }
  if (!response.ok) return { models: [], error: 'network' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { models: [], error: 'network' };
  }
  const list =
    body !== null && typeof body === 'object'
      ? ((body as Record<string, unknown>)[provider === 'ollama' ? 'models' : 'data'] ?? [])
      : [];
  const ids = pick(asIds(list, idKey)).sort((a, b) => a.localeCompare(b));
  return { models: ids, error: null };
}
