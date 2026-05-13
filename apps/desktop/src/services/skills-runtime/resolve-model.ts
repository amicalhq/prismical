import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";

import { PROVIDER_TYPES } from "@/constants/provider-types";
import type {
  ApiKeyConfig,
  Instance,
  OpenAICompatibleConfig,
} from "@/db/schema";
import { SkillRunError } from "./errors";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Resolve a LanguageModelV3 (Vercel AI SDK) for a configured instance.
// Mirrors `remote-note-generation-provider-registry.ts` so skill execution
// supports the same surface area as note generation. Providers without a
// real adapter (anthropic, ollama, etc.) throw a clear error rather than
// silently failing — matches the spec's "Couldn't run X — <reason>" toast.
export function resolveSkillModel(
  instance: Instance,
  modelId: string,
): LanguageModelV3 {
  switch (instance.provider) {
    case PROVIDER_TYPES.openai: {
      const cfg = instance.config as ApiKeyConfig;
      return openAICompatibleModel(cfg.apiKey, OPENAI_BASE_URL, modelId);
    }
    case PROVIDER_TYPES.groq: {
      const cfg = instance.config as ApiKeyConfig;
      return openAICompatibleModel(cfg.apiKey, GROQ_BASE_URL, modelId);
    }
    case PROVIDER_TYPES.openRouter: {
      const cfg = instance.config as ApiKeyConfig;
      return openAICompatibleModel(cfg.apiKey, OPENROUTER_BASE_URL, modelId);
    }
    case PROVIDER_TYPES.openAICompatible: {
      const cfg = instance.config as OpenAICompatibleConfig;
      return openAICompatibleModel(cfg.apiKey, cfg.baseURL, modelId);
    }
    case PROVIDER_TYPES.mock:
      return createMockModel(modelId);
    case PROVIDER_TYPES.anthropic:
      throw new SkillRunError(
        "Skills can't run on Anthropic instances yet — the @ai-sdk/anthropic dep hasn't been added. Use OpenRouter to reach Claude in the meantime.",
      );
    case PROVIDER_TYPES.ollama:
      throw new SkillRunError(
        "Skills can't run on Ollama instances yet — wire the OpenAI-compatible endpoint on your Ollama server (`OLLAMA_HOST` + the /v1 path) and register it as an openai-compatible instance.",
      );
    case PROVIDER_TYPES.localWhisper:
      throw new SkillRunError(
        "Local Whisper is a transcription model and can't run skills.",
      );
    default:
      throw new SkillRunError(
        `Skills aren't wired for provider type: ${instance.provider}`,
      );
  }
}

function openAICompatibleModel(
  apiKey: string,
  baseURL: string,
  modelId: string,
): LanguageModelV3 {
  const provider = createOpenAICompatible({
    apiKey,
    baseURL,
    name: "skills-runtime",
  });
  return provider(modelId);
}

// Canned structured output for dev/test runs against the Mock provider.
// Returns valid JSON that matches the runner's output schema. Latency is
// short so iteration stays snappy.
function createMockModel(modelId: string): LanguageModelV3 {
  const canned = {
    markdown:
      "## Mock skill output\n\n" +
      "This was produced by the **Mock** language model. It does not reflect " +
      "your note's content — switch to a real provider in Settings → AI " +
      "Models to see the actual skill result.\n\n" +
      "- Pipeline wiring verified end-to-end\n" +
      "- Skill prompt was rendered with injected context\n" +
      "- Output schema accepted the result\n",
  };
  return new MockLanguageModelV3({
    modelId,
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(canned) }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: {
          total: undefined,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: undefined,
          text: undefined,
          reasoning: undefined,
        },
        totalTokens: undefined,
      },
      warnings: [],
    }),
  });
}
