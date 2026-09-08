import { describe, expect, it } from 'vitest';
import { classifyProviderError } from './provider-errors.js';

// The AI SDK's APICallError, by shape (this package cannot import `ai`).
const apiCall = (
  statusCode: number | undefined,
  responseBody = '',
  headers?: Record<string, string>
) => ({
  name: 'AI_APICallError',
  message: `Failed with status ${statusCode ?? 'n/a'}`,
  statusCode,
  responseBody,
  responseHeaders: headers,
});

describe('classifyProviderError - 429 billing vs load', () => {
  it("Gemini's per-minute quota 429 is a rate limit, OpenAI's insufficient_quota is billing", () => {
    const gemini = classifyProviderError({
      name: 'AI_APICallError',
      message: 'Quota exceeded',
      statusCode: 429,
      responseBody:
        '{"error":{"code":429,"message":"Quota exceeded for quota metric \'Generate Content API requests per minute\'","status":"RESOURCE_EXHAUSTED"}}',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent',
      requestBodyValues: {},
    });
    expect(gemini?.code).toBe('PROVIDER_RATE_LIMITED');
    expect(gemini?.retryable).toBe(true);
    const openai = classifyProviderError({
      name: 'AI_APICallError',
      message: 'insufficient_quota',
      statusCode: 429,
      responseBody:
        '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}',
      url: 'https://api.openai.com/v1/chat/completions',
      requestBodyValues: {},
    });
    expect(openai?.code).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(openai?.http).toBe(422);
  });

  it('a 400 that names an exhausted credit balance (Anthropic via OpenRouter) is billing', () => {
    const c = classifyProviderError({
      name: 'AI_APICallError',
      message: 'bad request',
      statusCode: 400,
      responseBody:
        '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: {},
    });
    expect(c?.code).toBe('PROVIDER_QUOTA_EXCEEDED');
  });
});

describe('classifyProviderError', () => {
  it('maps auth failures to a user-fixable key error', () => {
    expect(
      classifyProviderError(apiCall(401, '{"error":{"message":"Incorrect API key"}}'))
    ).toMatchObject({
      code: 'PROVIDER_KEY_INVALID',
      http: 422,
      retryable: false,
    });
    expect(classifyProviderError(apiCall(403, 'forbidden'))).toMatchObject({
      code: 'PROVIDER_KEY_INVALID',
    });
  });

  it('tells billing apart from load on 429 and 403', () => {
    expect(
      classifyProviderError(
        apiCall(
          429,
          '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}'
        )
      )
    ).toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED', http: 422 });
    expect(classifyProviderError(apiCall(403, 'Your credit balance is too low'))).toMatchObject({
      code: 'PROVIDER_QUOTA_EXCEEDED',
    });
    expect(classifyProviderError(apiCall(402, ''))).toMatchObject({
      code: 'PROVIDER_QUOTA_EXCEEDED',
    });
    expect(
      classifyProviderError(apiCall(429, 'Rate limit reached', { 'Retry-After': '7' }))
    ).toEqual({
      code: 'PROVIDER_RATE_LIMITED',
      http: 429,
      retryable: true,
      retryAfterMs: 7000,
      statusCode: 429,
    });
  });

  it('classifies model, context and tool rejections from 4xx bodies', () => {
    expect(classifyProviderError(apiCall(404, 'The model `gpt-9` does not exist'))).toMatchObject({
      code: 'PROVIDER_MODEL_NOT_FOUND',
    });
    expect(
      classifyProviderError(apiCall(400, "This model's maximum context length is 8192 tokens"))
    ).toMatchObject({
      code: 'PROVIDER_CONTEXT_TOO_LONG',
    });
    expect(classifyProviderError(apiCall(413, ''))).toMatchObject({
      code: 'PROVIDER_CONTEXT_TOO_LONG',
    });
    expect(classifyProviderError(apiCall(400, 'llama3 does not support tools'))).toMatchObject({
      code: 'PROVIDER_TOOLS_UNSUPPORTED',
    });
    expect(
      classifyProviderError(apiCall(400, 'tool_choice is not supported by this model'))
    ).toMatchObject({
      code: 'PROVIDER_TOOLS_UNSUPPORTED',
    });
    expect(classifyProviderError(apiCall(400, 'model "foo" not found'))).toMatchObject({
      code: 'PROVIDER_MODEL_NOT_FOUND',
    });
    expect(classifyProviderError(apiCall(422, 'temperature must be <= 2'))).toMatchObject({
      code: 'PROVIDER_REJECTED',
      http: 422,
    });
    // A rejected TOOL SCHEMA is our bug on a model that supports tools — never "pick another model".
    expect(
      classifyProviderError(
        apiCall(400, "Invalid schema for function 'submit_output': schema must be a JSON Schema")
      )
    ).toMatchObject({ code: 'PROVIDER_REJECTED' });
    expect(
      classifyProviderError(apiCall(400, 'messages.1.content.0.tool_use.input is invalid'))
    ).toMatchObject({ code: 'PROVIDER_REJECTED' });
  });

  it('treats outages, timeouts and network faults as retryable unavailability', () => {
    expect(classifyProviderError(apiCall(503, 'overloaded'))).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      http: 502,
      retryable: true,
    });
    expect(classifyProviderError(apiCall(undefined, '', undefined))).toBeNull();
    expect(
      classifyProviderError({
        name: 'TimeoutError',
        message: 'The operation was aborted due to timeout',
      })
    ).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(classifyProviderError(new TypeError('fetch failed'))).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('unwraps the AI SDK RetryError and cause chains to the provider error inside', () => {
    const retry = {
      name: 'AI_RetryError',
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiCall(503, 'overloaded')],
      lastError: apiCall(503, 'overloaded'),
    };
    expect(classifyProviderError(retry)).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', http: 502 });
    const wrapped = new Error('wrapped', { cause: apiCall(401, 'bad key') });
    expect(classifyProviderError(wrapped)).toMatchObject({ code: 'PROVIDER_KEY_INVALID' });
  });

  it('leaves non-provider errors alone', () => {
    expect(classifyProviderError(new Error('boom'))).toBeNull();
    expect(classifyProviderError(null)).toBeNull();
    expect(classifyProviderError('nope')).toBeNull();
  });
});

describe('classifyProviderError - a rejected key that is not a 401', () => {
  // Google answers a rejected key with 400 INVALID_ARGUMENT, not 401 (verified live). The
  // generic 4xx arm would call that PROVIDER_REJECTED, which the transcription lane's `sessionOnly`
  // collapse then rewrites into a RETRYABLE 502 — so the chunk uploader would retry every chunk of
  // the recording instead of halting the session on a key only the user can fix.
  const geminiBadKey = (body: string) =>
    classifyProviderError({
      name: 'AI_APICallError',
      message: 'gemini transcription 400',
      statusCode: 400,
      responseBody: body,
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      requestBodyValues: {},
    });

  it('classifies a Gemini 400 API_KEY_INVALID as a user-fixable key error', () => {
    // Verbatim from the wire, including the top-level ARRAY this endpoint wraps errors in.
    const c = geminiBadKey(
      '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com"}]}}]'
    );
    expect(c?.code).toBe('PROVIDER_KEY_INVALID');
    expect(c?.http).toBe(422);
    expect(c?.retryable).toBe(false);
  });

  it('leaves an unrelated Gemini 400 as a plain rejection', () => {
    // The other 400 this lane can produce: sending vocabulary alongside diarization. It is our
    // request shape, not the user's key, and must NOT halt the session.
    const c = geminiBadKey(
      '[{"error":{"code":400,"message":"custom_vocabulary is incompatible with diarization.","status":"INVALID_ARGUMENT"}}]'
    );
    expect(c?.code).toBe('PROVIDER_REJECTED');
  });

  it('still prefers billing over the key rule when a 400 names both', () => {
    const c = geminiBadKey('{"error":{"message":"API key not valid; credit balance is too low"}}');
    expect(c?.code).toBe('PROVIDER_QUOTA_EXCEEDED');
  });

  it('reads a per-minute limit dressed up as a billing message as a RATE limit', () => {
    // Verbatim from the live API. It opens with "exceeded your current quota … plan and billing
    // details", which reads as an exhausted balance, and only says otherwise through
    // `too_many_requests`, a `rate-limits` link and "Please retry in 26.8s". Getting this wrong is
    // not cosmetic: PROVIDER_QUOTA_EXCEEDED is session-level, so a burst limit that clears in half
    // a minute would kill the whole recording and tell the user to check their billing.
    const c = classifyProviderError({
      name: 'AI_APICallError',
      message: 'gemini transcription 429',
      statusCode: 429,
      responseBody:
        '{"error":{"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 3, model: gemini-3.5-transcribe\\nPlease retry in 26.812788644s.","code":"too_many_requests"}}',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      requestBodyValues: {},
    });
    expect(c?.code).toBe('PROVIDER_RATE_LIMITED');
    expect(c?.http).toBe(429);
    expect(c?.retryable).toBe(true);
  });

  it('still calls a genuinely exhausted balance billing', () => {
    // OpenAI's real insufficient_quota body, verbatim. It carries a docs URL, which is exactly the
    // shape that would trip an over-broad rate rule — an invented body without one would let a
    // regression through.
    const c = classifyProviderError({
      name: 'AI_APICallError',
      message: 'insufficient_quota',
      statusCode: 429,
      responseBody:
        '{"error":{"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}',
      url: 'https://api.openai.com/v1/chat/completions',
      requestBodyValues: {},
    });
    expect(c?.code).toBe('PROVIDER_QUOTA_EXCEEDED');
  });

  it('halts on a key with NO allocation, which Google reports as limit: 0', () => {
    // Google uses ONE 429 template for everything, so "you have no quota at all" is byte-identical
    // to "you sent one request too many" apart from the number. Retrying this never succeeds: it
    // burns every chunk of the recording and leaves an empty transcript with no explanation.
    const c = classifyProviderError({
      name: 'AI_APICallError',
      message: 'gemini transcription 429',
      statusCode: 429,
      responseBody:
        '{"error":{"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. \\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.5-transcribe\\nPlease retry in 41.8s.","code":"too_many_requests"}}',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      requestBodyValues: {},
    });
    expect(c?.code).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(c?.retryable).toBe(false);
  });

  it('halts when the provider asks for a wait no recording can sit out', () => {
    // A per-DAY cap wearing a per-minute costume. Same template again; only the delay betrays it.
    const c = classifyProviderError({
      name: 'AI_APICallError',
      message: 'gemini transcription 429',
      statusCode: 429,
      responseBody:
        '{"error":{"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 250, model: gemini-3.5-transcribe. Please retry in 23456.7s.","code":"too_many_requests"}}',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      requestBodyValues: {},
    });
    expect(c?.code).toBe('PROVIDER_QUOTA_EXCEEDED');
  });

  it('halts on a 400 the caller can never satisfy, not just an invalid key', () => {
    // FAILED_PRECONDITION is deterministic per key (unsupported region, or a project state that
    // forbids the call). Left in the generic 4xx arm it becomes PROVIDER_REJECTED, which the
    // transcription lane's sessionOnly collapse rewrites into a retryable 502 - so every chunk
    // burns three attempts for a condition no retry can clear.
    const c = classifyProviderError({
      name: 'AI_APICallError',
      message: 'gemini transcription 400',
      statusCode: 400,
      responseBody:
        '[{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}]',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      requestBodyValues: {},
    });
    expect(c?.code).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(c?.retryable).toBe(false);
  });

  it('understands a composite wait, so a per-day limit is not read as a burst', () => {
    // OpenAI's per-DAY body quotes "1h22m30s" and sends no retry-after header. Parsing only bare
    // seconds left this undefined, so the long-wait rule never fired and a day-long exhaustion
    // stayed retryable for the whole recording.
    const c = classifyProviderError({
      name: 'AI_APICallError',
      message: 'rate limit',
      statusCode: 429,
      responseBody:
        '{"error":{"message":"Rate limit reached for gpt-4o. Please try again in 1h22m30s.","type":"requests"}}',
      url: 'https://api.openai.com/v1/chat/completions',
      requestBodyValues: {},
    });
    expect(c?.code).toBe('PROVIDER_QUOTA_EXCEEDED');
  });

  it('keeps a short composite wait retryable, with the wait passed through', () => {
    const c = classifyProviderError({
      name: 'AI_APICallError',
      message: 'gemini transcription 429',
      statusCode: 429,
      responseBody:
        '{"error":{"message":"Quota exceeded. Please retry in 1m30s.","code":"too_many_requests"}}',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      requestBodyValues: {},
    });
    expect(c?.code).toBe('PROVIDER_RATE_LIMITED');
    expect(c?.retryAfterMs).toBe(90_000);
  });

  it('reads the retry delay out of the BODY, since Google sends no retry-after header', () => {
    // Observed live: a real recording produced this exact shape 900 times. The header-only reader
    // returned undefined for the one error the rate rule exists to describe.
    const c = classifyProviderError({
      name: 'AI_APICallError',
      message: 'gemini transcription 429',
      statusCode: 429,
      responseBody:
        '{"error":{"message":"You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 25, model: gemini-3.5-transcribe. Please retry in 7.078078732s.","code":"too_many_requests"}}',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      requestBodyValues: {},
    });
    expect(c?.code).toBe('PROVIDER_RATE_LIMITED');
    expect(c?.retryable).toBe(true);
    expect(c?.retryAfterMs).toBe(7078);
  });
});
