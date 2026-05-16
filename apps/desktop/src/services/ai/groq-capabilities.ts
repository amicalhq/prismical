// Groq's @ai-sdk/groq defaults to `structuredOutputs: true` and
// `strictJsonSchema: true`. That matches the newer models (Llama 4,
// Kimi K2, gpt-oss, qwen3) but 400s on older Groq inventory like
// gemma2-9b-it that only supports `json_object`.
//
// Rather than maintain the catalog filter the plan recommends, we
// opt out per-call: if the resolved Groq model isn't in this prefix
// allow-list, the skill runner attaches
// `providerOptions.groq.structuredOutputs: false` and relies on the
// always-on extractJsonMiddleware (from t-05) to parse the loose
// json_object response. Cost: lost strict decoding on those models;
// benefit: gemma users get a working skill run instead of a 400.
//
// Update this list when Groq adds new strict-schema-capable models.
// Source of truth: https://console.groq.com/docs/structured-outputs.
// Prefixes match the Groq /v1/models id format (verified against
// `node_modules/@ai-sdk/groq/dist/index.d.ts` `GroqChatModelId`); ids
// arrive vendor-prefixed (`qwen/`, `meta-llama/`, `openai/`,
// `moonshotai/`) so the prefixes carry the namespace.
const GROQ_STRICT_SCHEMA_PREFIXES: readonly string[] = [
  "moonshotai/kimi-k2",
  "meta-llama/llama-4",
  // Note: `llama-3.3-70b-versatile` does NOT support json_schema — verified
  // 2026-05 by the live smoke-test (Groq returns "This model does not
  // support response format `json_schema`"). The Llama-3.x family stays
  // off this list; structured outputs flow through json_object +
  // extractJsonMiddleware instead.
  "qwen-qwq",
  "qwen/qwen3-",
  "openai/gpt-oss",
  "deepseek-r1-distill",
];

export function groqSupportsStrictJsonSchema(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return GROQ_STRICT_SCHEMA_PREFIXES.some((p) => lower.startsWith(p));
}
