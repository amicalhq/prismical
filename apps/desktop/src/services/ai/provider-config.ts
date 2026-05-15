import type { ProviderV3 } from "@ai-sdk/provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { MockProviderV3 } from "ai/test";

import {
  PROVIDER_TYPES,
  type ProviderType,
} from "@/constants/provider-types";
import type {
  ApiKeyConfig,
  InstanceConfig,
  OllamaConfig,
  OpenAICompatibleConfig,
} from "@/db/schema";
import { getUserAgent } from "@/utils/http-client";
import { createMockLanguageModel } from "./mock-language-model";
import { compatCapabilityTransform } from "./openai-compatible-capabilities";

// `PROVIDER_TYPES.openai` and `PROVIDER_TYPES.groq` route through the
// generic openai-compatible adapter today. Subsequent tasks swap each to
// a first-class @ai-sdk package (t-02, t-03, t-15) — those PRs just
// change the entry below.
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// `Partial<Record<ProviderType, ...>>` is deliberate: not every provider
// type has an HTTP factory. `localWhisper` is served by an in-process
// subsystem, coming-soon types (`googleGemini`, `cerebras`, etc.) have no
// entry until wired, and `anthropic` lights up once t-03 adds the SDK
// dependency. Absence is the "local-only / not yet wired" signal — the
// registry build filters on `row.provider in providerFactories`.
export const providerFactories: Partial<
  Record<ProviderType, (cfg: InstanceConfig) => ProviderV3>
> = {
  [PROVIDER_TYPES.openai]: (cfg) => {
    const c = cfg as ApiKeyConfig;
    return createOpenAICompatible({
      name: "openai",
      apiKey: c.apiKey,
      baseURL: OPENAI_BASE_URL,
      headers: { "User-Agent": getUserAgent() },
      // Capability-aware param cleanup (t-04). Strips temperature/top_p/
      // penalties for reasoning models and renames `max_tokens` →
      // `max_completion_tokens` for newer chat models. Replaced wholesale
      // once t-02 swaps in @ai-sdk/openai (which handles capabilities
      // natively).
      transformRequestBody: compatCapabilityTransform,
    });
  },

  [PROVIDER_TYPES.groq]: (cfg) => {
    const c = cfg as ApiKeyConfig;
    return createOpenAICompatible({
      name: "groq",
      apiKey: c.apiKey,
      baseURL: GROQ_BASE_URL,
      headers: { "User-Agent": getUserAgent() },
      transformRequestBody: compatCapabilityTransform,
    });
  },

  [PROVIDER_TYPES.openRouter]: (cfg) => {
    const c = cfg as ApiKeyConfig;
    // TODO(t-08): pass `appName` / `appUrl` for OpenRouter dashboard attribution.
    // TODO(t-16): wrap with `wrapProvider` + `defaultSettingsMiddleware` to set
    // `providerOptions: { openrouter: { usage: { include: true } } }` so
    // `result.providerMetadata.openrouter.usage.cost` is populated.
    return createOpenRouter({ apiKey: c.apiKey });
  },

  [PROVIDER_TYPES.ollama]: (cfg) => {
    const c = cfg as OllamaConfig;
    // Verified: Ollama's /v1 endpoint supports json_schema response_format,
    // tools, reasoning_effort, vision, embeddings. The hard-coded flag here
    // is safe — Ollama is the controlled upstream, unlike the generic
    // openai-compatible catch-all (t-19 makes that user-controlled).
    return createOpenAICompatible({
      name: "ollama",
      baseURL: `${c.url.replace(/\/+$/, "")}/v1`,
      supportsStructuredOutputs: true,
      headers: { "User-Agent": getUserAgent() },
      transformRequestBody: compatCapabilityTransform,
    });
  },

  [PROVIDER_TYPES.openAICompatible]: (cfg) => {
    const c = cfg as OpenAICompatibleConfig;
    return createOpenAICompatible({
      name: "openai-compatible",
      apiKey: c.apiKey,
      baseURL: c.baseURL,
      headers: { "User-Agent": getUserAgent() },
      transformRequestBody: compatCapabilityTransform,
    });
  },

  [PROVIDER_TYPES.mock]: () =>
    new MockProviderV3({
      languageModels: {
        "mock-language-fast": createMockLanguageModel("mock-language-fast"),
        "mock-language-slow": createMockLanguageModel("mock-language-slow"),
      },
    }),
};
