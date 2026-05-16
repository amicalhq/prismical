import type { ProviderV3 } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defaultSettingsMiddleware, wrapProvider } from "ai";
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
import { APP_NAME, APP_URL } from "@/constants/app-attribution";
import { getUserAgent } from "@/utils/http-client";
import { createMockLanguageModel } from "./mock-language-model";
import { compatCapabilityTransform } from "./openai-compatible-capabilities";


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
    // First-class provider (t-02). Defaults to the Responses API since
    // v5, knows per-model capabilities (strips unsupported params and
    // emits AI SDK warnings — see sdk-warning-handler.ts), supports
    // strict JSON schema by default (`strictJsonSchema: true` in
    // @ai-sdk/openai@^3 — verified at chat/openai-chat-language-model.ts).
    // No transformRequestBody needed — the provider handles it natively.
    return createOpenAI({
      apiKey: c.apiKey,
      headers: { "User-Agent": getUserAgent() },
    });
  },

  [PROVIDER_TYPES.anthropic]: (cfg) => {
    const c = cfg as ApiKeyConfig;
    // First-class provider (t-03). Native structured outputs on
    // claude-sonnet-4-5+ via `outputFormat`, jsonTool fallback for older
    // models. Sanitises strict-schema-incompatible Zod refinements
    // automatically (sanitize-json-schema.ts in @ai-sdk/anthropic).
    // Caller exposes effort / thinking / structuredOutputMode via
    // providerOptions.anthropic.
    return createAnthropic({
      apiKey: c.apiKey,
      headers: { "User-Agent": getUserAgent() },
    });
  },

  [PROVIDER_TYPES.groq]: (cfg) => {
    const c = cfg as ApiKeyConfig;
    // First-class provider (t-15). Defaults `structuredOutputs: true` and
    // `strictJsonSchema: true` — which 400s on Groq models that only
    // support json_object (gemma2-9b-it, smaller Llamas). The skill
    // runner sets `providerOptions.groq.structuredOutputs: false` for
    // models outside `GROQ_STRICT_SCHEMA_PREFIXES` and relies on
    // extractJsonMiddleware to parse the loose response.
    return createGroq({
      apiKey: c.apiKey,
      headers: { "User-Agent": getUserAgent() },
    });
  },

  [PROVIDER_TYPES.openRouter]: (cfg) => {
    const c = cfg as ApiKeyConfig;
    // Vendor provider (t-16). Wrapped with defaultSettingsMiddleware to
    // turn on usage accounting — that's what populates
    // `result.providerMetadata.openrouter.usage.cost` (US dollars per
    // call). Without `usage: { include: true }` the cost field stays
    // undefined. Applied at registration so every OpenRouter call (skill
    // + note-gen) gets it without the call site remembering.
    //
    // `appName` / `appUrl` (t-08) sets the `HTTP-Referer` and
    // `X-OpenRouter-Title` headers OpenRouter reads for dashboard
    // attribution. Free observability.
    return wrapProvider({
      provider: createOpenRouter({
        apiKey: c.apiKey,
        appName: APP_NAME,
        appUrl: APP_URL,
      }),
      languageModelMiddleware: defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            openrouter: { usage: { include: true } },
          },
        },
      }),
    });
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
      // User-controlled per-instance flag (t-19). Default off — most
      // generic proxies only support json_object. Upstreams that do
      // support strict json_schema (vLLM, LM Studio 0.3+, Mistral) flip
      // it on via the instance form's Advanced section.
      supportsStructuredOutputs: c.supportsStrictJsonSchema ?? false,
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
