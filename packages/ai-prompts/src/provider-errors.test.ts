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
