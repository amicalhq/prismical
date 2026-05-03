import { PROVIDER_TYPES } from "@/constants/provider-types";
import type {
  ApiKeyConfig,
  Instance,
  OllamaConfig,
  OpenAICompatibleConfig,
} from "@/db/schema";
import type { FormattingProvider } from "../../core/pipeline-types";
import { MockFormatter } from "./mock-formatter";
import { OllamaFormatter } from "./ollama-formatter";
import { OpenAICompatibleFormatter } from "./openai-compatible-formatter";
import { OpenRouterProvider as OpenRouterFormatter } from "./openrouter-formatter";

// OpenAI and Groq are OpenAI-compatible at the chat-completions API
// shape, so we reuse the OpenAICompatibleFormatter with the right
// baseURL rather than ship two near-identical classes.
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Construct a FormattingProvider for an instance + model. Throws for
 * types that can't format text (local-whisper) or aren't wired up
 * (anthropic — needs @ai-sdk/anthropic).
 */
export async function createFormatter(
  instance: Instance,
  modelId: string,
): Promise<FormattingProvider> {
  switch (instance.type) {
    case PROVIDER_TYPES.openRouter: {
      const config = instance.config as ApiKeyConfig;
      return new OpenRouterFormatter(config.apiKey, modelId);
    }
    case PROVIDER_TYPES.ollama: {
      const config = instance.config as OllamaConfig;
      return new OllamaFormatter(config.url, modelId);
    }
    case PROVIDER_TYPES.openAICompatible: {
      const config = instance.config as OpenAICompatibleConfig;
      return new OpenAICompatibleFormatter(
        config.apiKey,
        config.baseURL,
        modelId,
      );
    }
    case PROVIDER_TYPES.openai: {
      const config = instance.config as ApiKeyConfig;
      return new OpenAICompatibleFormatter(
        config.apiKey,
        OPENAI_BASE_URL,
        modelId,
      );
    }
    case PROVIDER_TYPES.groq: {
      const config = instance.config as ApiKeyConfig;
      return new OpenAICompatibleFormatter(
        config.apiKey,
        GROQ_BASE_URL,
        modelId,
      );
    }
    case PROVIDER_TYPES.mock:
      return new MockFormatter(modelId);
    case PROVIDER_TYPES.anthropic:
      throw new Error(
        "Anthropic formatting isn't supported yet — the @ai-sdk/anthropic dependency hasn't been added",
      );
    case PROVIDER_TYPES.localWhisper:
      throw new Error(
        "Local Whisper is a transcription model and can't format text",
      );
    default: {
      throw new Error(
        `Formatting isn't configured for provider type: ${instance.type}`,
      );
    }
  }
}
