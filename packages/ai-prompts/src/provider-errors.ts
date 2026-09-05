import { AI_ERROR_CODES, type AiErrorCode } from '@prismical/api-contracts';

/**
 * Classify a provider-side failure into a stable {@link AiErrorCode}.
 *
 * Structural on purpose: this package has no `ai` dependency (it is vendored into the Electron
 * main process), so the AI SDK's `APICallError` is recognised by its shape — `name`, `statusCode`,
 * `responseBody`, `responseHeaders` — rather than by `instanceof`. One function can therefore
 * serve language calls (Skills, Ask), `transcribe()` calls (Deepgram, Groq), and the desktop's
 * local BYOK lane. Today core's skill runs use it; Ask, transcription and the desktop lane are
 * the follow-up slices of the error-message cleanup.
 *
 * Only the CODE and a retry hint leave here. Response bodies are matched for classification and
 * never returned: a client renders copy from the code, not from provider prose.
 *
 * Advisory by design: a caller that uses a provider rejection as a *signal* (the desktop lane
 * steps down its tool-support ladder on a tool-shape rejection) must run its own logic first and
 * classify only what it gives up on.
 */
export type ProviderErrorCode = Extract<
  AiErrorCode,
  | 'PROVIDER_KEY_INVALID'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_MODEL_NOT_FOUND'
  | 'PROVIDER_CONTEXT_TOO_LONG'
  | 'PROVIDER_TOOLS_UNSUPPORTED'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
>;

export interface ClassifiedProviderError {
  code: ProviderErrorCode;
  /**
   * The HTTP status the API should answer with. User-fixable causes are 422 (a 4xx that clients
   * treat as permanent — they must NOT retry a bad key); rate limits are 429; outages are 502.
   */
  http: 422 | 429 | 502;
  retryable: boolean;
  /** Present for rate limits when the provider sent `retry-after`. */
  retryAfterMs?: number;
  /** The provider's own status, for logs. */
  statusCode?: number;
}

interface ApiCallErrorLike {
  name?: unknown;
  message?: unknown;
  statusCode?: unknown;
  responseBody?: unknown;
  responseHeaders?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The AI SDK's `APICallError` (any version), by shape. */
export function isApiCallErrorLike(err: unknown): err is ApiCallErrorLike {
  if (!isRecord(err)) return false;
  if (err.name === 'AI_APICallError') return true;
  return typeof err.statusCode === 'number' && 'responseBody' in err;
}

const QUOTA_WORDS =
  /insufficient[_ ]quota|exceeded your current quota|billing|credit balance|out of credits?|payment required|quota exceeded|hard limit|spending limit/i;
// A 429 whose body names BILLING is an exhausted balance; one that names a per-minute/day quota
// (Gemini's "Quota exceeded for quota metric ... requests per minute", RESOURCE_EXHAUSTED) is load.
const BILLING_429_WORDS =
  /insufficient[_ ]quota|exceeded your current quota|billing|credit balance|out of credits?|payment required|hard limit|spending limit/i;
const RATE_WINDOW_WORDS =
  /per (?:minute|second|hour|day)|RESOURCE_EXHAUSTED|rate limit|too many requests/i;
const CONTEXT_WORDS =
  /context[_ ]length|maximum context|too many tokens|prompt is too long|input is too long|exceeds the maximum|reduce the length|token limit/i;
const TOOL_TERMS = String.raw`\b(tools?|tool_choice|tool[ _-]?calls?|function[ _-]?call(?:ing|s)?|functions?)\b`;
// Deliberately NOT `invalid` / `cannot`: OpenAI's strict-mode "Invalid schema for function
// 'submit_output'" and Anthropic's "tool_use … is invalid" are OUR request being rejected by a
// model that supports tools fine — telling the user to pick another model would be wrong, and the
// 422 would make a transient schema bug read as permanent.
const UNSUPPORTED_TERMS = String.raw`\b(not supported|unsupported|does not support|doesn't support)\b`;
const TOOL_WORDS = new RegExp(
  `${TOOL_TERMS}[^.]{0,80}${UNSUPPORTED_TERMS}|${UNSUPPORTED_TERMS}[^.]{0,80}${TOOL_TERMS}`,
  'i'
);
const MODEL_MISSING_WORDS =
  /model[^.]{0,60}(not found|does not exist|doesn't exist|unknown|not available|decommissioned|deprecated|retired)|no such model|invalid model/i;
const NETWORK_WORDS =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network/i;

function headerValue(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name && typeof v === 'string') return v;
  }
  return undefined;
}

/** `retry-after` seconds or HTTP-date → milliseconds from now. */
function retryAfterMs(headers: unknown): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

const fixed = (code: ProviderErrorCode, statusCode?: number): ClassifiedProviderError => ({
  code,
  http: 422,
  retryable: false,
  statusCode,
});

const unavailable = (statusCode?: number): ClassifiedProviderError => ({
  code: AI_ERROR_CODES.PROVIDER_UNAVAILABLE,
  http: 502,
  retryable: true,
  statusCode,
});

export function classifyProviderError(err: unknown): ClassifiedProviderError | null {
  if (!isRecord(err)) return null;
  const name = typeof err.name === 'string' ? err.name : '';
  const message = typeof err.message === 'string' ? err.message : '';

  // The AI SDK retries 5xx/429 itself and, when every attempt fails, throws a `RetryError` whose
  // `lastError` is the provider's final answer. Classify THAT — the wrapper carries no status.
  if (name === 'AI_RetryError' || (isRecord(err.lastError) && 'errors' in err)) {
    const inner = classifyProviderError(err.lastError);
    if (inner) return inner;
  }

  // A timeout / abort of the provider call (AbortSignal.timeout, undici timeouts) — the provider
  // never answered. Callers that abort on their OWN behalf (client disconnect) must bail before
  // classifying; this is for deadlines the server set.
  if (name === 'TimeoutError' || name === 'AbortError') return unavailable();

  if (!isApiCallErrorLike(err)) {
    // Node/undici network faults surface as TypeError('fetch failed') with a `cause`.
    if (name === 'TypeError' && NETWORK_WORDS.test(message)) return unavailable();
    // Anything else that wrapped a provider error (`cause` chains).
    const cause = (err as Record<string, unknown>).cause;
    if (isRecord(cause) && cause !== err) return classifyProviderError(cause);
    return null;
  }

  const status = typeof err.statusCode === 'number' ? err.statusCode : undefined;
  const body = typeof err.responseBody === 'string' ? err.responseBody : '';
  const text = `${body}\n${message}`;

  if (status === undefined) return NETWORK_WORDS.test(text) ? unavailable() : null;

  if (status === 401) return fixed(AI_ERROR_CODES.PROVIDER_KEY_INVALID, status);
  if (status === 402) return fixed(AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, status);
  if (status === 403) {
    return fixed(
      QUOTA_WORDS.test(text)
        ? AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED
        : AI_ERROR_CODES.PROVIDER_KEY_INVALID,
      status
    );
  }
  if (status === 404) return fixed(AI_ERROR_CODES.PROVIDER_MODEL_NOT_FOUND, status);
  if (status === 429) {
    // OpenAI reports an exhausted balance as 429 `insufficient_quota`; that is billing, not load.
    // Gemini's "Quota exceeded ... per minute" is load: a minute's wait works, a top-up does not.
    if (BILLING_429_WORDS.test(text) && !RATE_WINDOW_WORDS.test(text)) {
      return fixed(AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, status);
    }
    return {
      code: AI_ERROR_CODES.PROVIDER_RATE_LIMITED,
      http: 429,
      retryable: true,
      retryAfterMs: retryAfterMs(err.responseHeaders),
      statusCode: status,
    };
  }
  if (status === 413 || (status >= 400 && status < 500 && CONTEXT_WORDS.test(text))) {
    return fixed(AI_ERROR_CODES.PROVIDER_CONTEXT_TOO_LONG, status);
  }
  if (status >= 400 && status < 500) {
    // Anthropic-style 400 "credit balance is too low" (also passed through by OpenRouter).
    if (QUOTA_WORDS.test(text)) return fixed(AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, status);
    if (TOOL_WORDS.test(text)) return fixed(AI_ERROR_CODES.PROVIDER_TOOLS_UNSUPPORTED, status);
    if (MODEL_MISSING_WORDS.test(text))
      return fixed(AI_ERROR_CODES.PROVIDER_MODEL_NOT_FOUND, status);
    return fixed(AI_ERROR_CODES.PROVIDER_REJECTED, status);
  }
  return unavailable(status);
}
