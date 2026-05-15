// Per-model request-body cleanup for the openai-compatible adapter path.
//
// The native @ai-sdk/openai / @ai-sdk/anthropic providers already know each
// model's capabilities and strip unsupported params (emitting an "AI SDK
// Warning" the caller can observe). The gap is the openai-compatible path —
// Groq, Ollama-via-/v1, and generic openai-style proxies reach the upstream
// without the SDK knowing which model family it's hitting. Reasoning models
// (gpt-5, o3, deepseek-r1, qwen3, ...) 400 when handed `temperature: 0.1` or
// `top_p`; newer OpenAI chat models reject `max_tokens` in favour of
// `max_completion_tokens`.
//
// This classifier + transform lives only on the openai-compatible factory.
// Native providers (added in t-02/t-03/t-15) handle this themselves.

export interface ModelCapabilities {
  supportsTemperature: boolean;
  supportsTopP: boolean;
  supportsFrequencyPenalty: boolean;
  supportsPresencePenalty: boolean;
  isReasoning: boolean;
  paramRenames: Record<string, string>;
}

const DEFAULT_CAPS: ModelCapabilities = {
  supportsTemperature: true,
  supportsTopP: true,
  supportsFrequencyPenalty: true,
  supportsPresencePenalty: true,
  isReasoning: false,
  paramRenames: {},
};

// Reasoning models: no sampling knobs, must use `max_completion_tokens`.
// Conservative — every known reasoning family today follows this contract.
const REASONING_CAPS: ModelCapabilities = {
  supportsTemperature: false,
  supportsTopP: false,
  supportsFrequencyPenalty: false,
  supportsPresencePenalty: false,
  isReasoning: true,
  paramRenames: { max_tokens: "max_completion_tokens" },
};

// First match wins. Patterns kept loose on purpose — every vendor names
// reasoning variants slightly differently, and a false positive here just
// means we drop sampling knobs the server would have ignored anyway.
const REASONING_PATTERNS: readonly RegExp[] = [
  /^o[1-9](-|$)/i, // OpenAI o-series: o1, o3, o3-mini, o4-mini
  /^gpt-5(\.|-|$)/i, // gpt-5 family is reasoning by default
  /^gpt-oss/i, // OpenAI gpt-oss-*
  /deepseek-r1/i, // DeepSeek R1 + distills
  /^qwen-?qwq/i, // qwen-qwq-32b
  /\bqwen3\b/i, // Qwen3 reasoning variants
  /claude.*thinking/i, // Older Anthropic thinking variants on compat path
];

// Non-reasoning OpenAI chat ids that still need the `max_tokens` rename to
// match the Responses API's `max_completion_tokens`. Other compat upstreams
// (Groq, Ollama) accept `max_tokens` as-is — but they also accept the
// renamed key, so applying the rename for any `gpt-*` id is safe.
const OPENAI_CHAT_RENAME_ONLY = /^(gpt-4|gpt-3\.5)/i;

export function classifyOpenAICompatibleModel(
  modelId: string,
): ModelCapabilities {
  for (const pattern of REASONING_PATTERNS) {
    if (pattern.test(modelId)) return REASONING_CAPS;
  }
  if (OPENAI_CHAT_RENAME_ONLY.test(modelId)) {
    return { ...DEFAULT_CAPS, paramRenames: { max_tokens: "max_completion_tokens" } };
  }
  return DEFAULT_CAPS;
}

/**
 * `transformRequestBody` hook for `createOpenAICompatible` that strips
 * disallowed sampling knobs and applies param renames declaratively. The
 * adapter passes the body as a record before sending to the upstream — we
 * mutate the shape so the upstream sees a valid request.
 */
export function compatCapabilityTransform(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const modelId = typeof body.model === "string" ? body.model : "";
  const caps = classifyOpenAICompatibleModel(modelId);

  const out: Record<string, unknown> = { ...body };
  if (!caps.supportsTemperature) delete out.temperature;
  if (!caps.supportsTopP) delete out.top_p;
  if (!caps.supportsFrequencyPenalty) delete out.frequency_penalty;
  if (!caps.supportsPresencePenalty) delete out.presence_penalty;

  for (const [from, to] of Object.entries(caps.paramRenames)) {
    if (from in out) {
      out[to] = out[from];
      delete out[from];
    }
  }
  return out;
}
