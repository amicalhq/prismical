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
// Punctuation-tolerant on purpose. Google's transcription 429 opens with "You exceeded your
// current quota, please check your plan and billing details" — which BILLING_429_WORDS matches —
// and only reveals itself as a per-MINUTE limit through `"code":"too_many_requests"`, a
// `docs/rate-limits` link, and "Please retry in 26.8s" (verified against the live API). Matching
// only the space-separated spellings read that as an exhausted balance and returned
// PROVIDER_QUOTA_EXCEEDED, which is session-level: a burst limit that clears in half a minute
// killed the whole recording and told the user to check their billing.
const RATE_WINDOW_WORDS =
  /per[ _-](?:minute|second|hour|day)|RESOURCE_EXHAUSTED|rate[ _-]?limit|too[ _-]?many[ _-]?requests|retry in \d/i;
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
// A rejected key is a 401 nearly everywhere, and the 401 arm above catches it. Google is the
// exception: the Generative Language API answers a bad or expired key with 400 INVALID_ARGUMENT
// and `reason: API_KEY_INVALID` (verified against the live API). Without this it falls to the 4xx
// arm as PROVIDER_REJECTED — which the transcription lane's `sessionOnly` collapse then rewrites
// into a RETRYABLE 502, so the chunk uploader retries every chunk of the recording instead of
// halting the session on a key the user has to fix. Deliberately narrow: it must match the key
// being invalid, not any request Google happens to call an invalid argument.
const KEY_INVALID_400_WORDS =
  /API_KEY_INVALID|API key not valid|API key expired|invalid[_ ]api[_ ]key/i;
// The other Google 400 that no retry can clear: the key is real, but this caller may not use the
// API at all - an unsupported region, or a project state that forbids the call. Same failure mode
// as the bad key above and the same fix: without a rule here it lands in the generic 4xx arm as
// PROVIDER_REJECTED, and the transcription lane's `sessionOnly` collapse rewrites that into a
// RETRYABLE 502 - so every chunk of the recording burns three attempts and is dropped under a
// generic message, for a condition that is deterministic per key. The sibling wording "free tier
// is not available in your country. Please enable billing" already classifies correctly, but only
// because it happens to contain "billing".
const UNAVAILABLE_FOR_CALLER_400_WORDS = /FAILED_PRECONDITION|User location is not supported/i;
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

/**
 * Some providers put the wait in the BODY instead of a `retry-after` header — Google says
 * "Please retry in 26.812788644s" and sends no such header at all, so a header-only reader returns
 * undefined for the one error this rule exists to describe.
 */
function retryAfterMsFromBody(text: string): number | undefined {
  // Composite durations are the ones that matter. OpenAI's per-DAY body says "Please try again in
  // 1h22m30s" and sends no `retry-after` header, and Google can answer "retry in 1m30s". Reading
  // only the bare-seconds form left those undefined, so the long-wait rule below never fired and a
  // day-long exhaustion stayed retryable - the exact runaway that rule exists to stop.
  const m = /(?:retry|try again) in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/**
 * A 429 the caller can never wait out, so it must halt the session rather than be retried.
 *
 * `limit: 0` is Google's way of saying this key has NO allocation for this model — a free-tier key
 * on a model with no free tier, or a paid key whose project never picked up its paid quota.
 * Google reuses ONE 429 template for every case, so the body reads exactly like a transient
 * per-minute limit; only the number distinguishes "wait a moment" from "this will never work".
 * The negative lookahead keeps `limit: 0.5`-style values out.
 */
const DEAD_QUOTA_WORDS = /\blimit:\s*0\b(?!\.\d)|insufficient[_ ]quota/i;

/**
 * Above this, a "rate limit" is a per-DAY cap wearing a per-minute costume: no recording can wait
 * it out, and retrying every chunk for the rest of the session only burns the user's quota further.
 * Ten minutes is comfortably longer than any real burst window and far shorter than the tens of
 * thousands of seconds a daily exhaustion reports.
 */
const RATE_WINDOW_MAX_MS = 10 * 60 * 1000;

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
    const waitMs = retryAfterMs(err.responseHeaders) ?? retryAfterMsFromBody(text);
    // A 429 nobody can wait out is a dead key, not load. Checked FIRST because Google's single
    // 429 template makes "you have no quota at all" and "you sent one request too many" read
    // identically — without this, a key with no allocation retries every chunk for the whole
    // recording, produces an empty transcript, and never tells the user why.
    if (DEAD_QUOTA_WORDS.test(text) || (waitMs !== undefined && waitMs > RATE_WINDOW_MAX_MS)) {
      return fixed(AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, status);
    }
    // OpenAI reports an exhausted balance as 429 `insufficient_quota`; that is billing, not load.
    // Gemini's "Quota exceeded ... per minute" is load: a minute's wait works, a top-up does not.
    if (BILLING_429_WORDS.test(text) && !RATE_WINDOW_WORDS.test(text)) {
      return fixed(AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, status);
    }
    return {
      code: AI_ERROR_CODES.PROVIDER_RATE_LIMITED,
      http: 429,
      retryable: true,
      retryAfterMs: waitMs,
      statusCode: status,
    };
  }
  if (status === 413 || (status >= 400 && status < 500 && CONTEXT_WORDS.test(text))) {
    return fixed(AI_ERROR_CODES.PROVIDER_CONTEXT_TOO_LONG, status);
  }
  if (status >= 400 && status < 500) {
    // Anthropic-style 400 "credit balance is too low" (also passed through by OpenRouter).
    if (QUOTA_WORDS.test(text)) return fixed(AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, status);
    // Before the generic rejection: Google reports a bad key as a 400, not a 401.
    if (KEY_INVALID_400_WORDS.test(text))
      return fixed(AI_ERROR_CODES.PROVIDER_KEY_INVALID, status);
    // Not the key's validity but the caller's eligibility - session-level for the same reason.
    if (UNAVAILABLE_FOR_CALLER_400_WORDS.test(text))
      return fixed(AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, status);
    if (TOOL_WORDS.test(text)) return fixed(AI_ERROR_CODES.PROVIDER_TOOLS_UNSUPPORTED, status);
    if (MODEL_MISSING_WORDS.test(text))
      return fixed(AI_ERROR_CODES.PROVIDER_MODEL_NOT_FOUND, status);
    return fixed(AI_ERROR_CODES.PROVIDER_REJECTED, status);
  }
  return unavailable(status);
}
