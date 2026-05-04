import { PROVIDER_TYPES } from "@/constants/provider-types";
import type {
  ApiKeyConfig,
  Instance,
  OllamaConfig,
  OpenAICompatibleConfig,
} from "@/db/schema";
import { MockNoteGenerationProvider } from "./mock-note-generation-provider";
import { OllamaNoteGenerationProvider } from "./ollama-note-generation-provider";
import { OpenAICompatibleNoteGenerationProvider } from "./openai-compatible-note-generation-provider";
import { OpenRouterNoteGenerationProvider } from "./openrouter-note-generation-provider";
import type { NoteGenerationProvider } from "./types";

// OpenAI and Groq both expose the OpenAI chat-completions shape, so they
// reuse the openai-compatible provider with a fixed baseURL per type.
// Keeps the runtime tiny without a new SDK dependency.
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Construct a NoteGenerationProvider for an instance + model. Throws for
 * providers that don't support note generation (local-whisper) or aren't
 * yet wired up (anthropic — needs the @ai-sdk/anthropic dep), so the
 * caller can surface a clear error.
 */
export async function createNoteGenerationProvider(
  instance: Instance,
  modelId: string,
): Promise<NoteGenerationProvider> {
  switch (instance.provider) {
    case PROVIDER_TYPES.openRouter: {
      const config = instance.config as ApiKeyConfig;
      return new OpenRouterNoteGenerationProvider(config.apiKey, modelId);
    }
    case PROVIDER_TYPES.ollama: {
      const config = instance.config as OllamaConfig;
      return new OllamaNoteGenerationProvider(config.url, modelId);
    }
    case PROVIDER_TYPES.openAICompatible: {
      const config = instance.config as OpenAICompatibleConfig;
      return new OpenAICompatibleNoteGenerationProvider(
        config.apiKey,
        config.baseURL,
        modelId,
      );
    }
    case PROVIDER_TYPES.openai: {
      const config = instance.config as ApiKeyConfig;
      return new OpenAICompatibleNoteGenerationProvider(
        config.apiKey,
        OPENAI_BASE_URL,
        modelId,
      );
    }
    case PROVIDER_TYPES.groq: {
      const config = instance.config as ApiKeyConfig;
      return new OpenAICompatibleNoteGenerationProvider(
        config.apiKey,
        GROQ_BASE_URL,
        modelId,
      );
    }
    case PROVIDER_TYPES.mock:
      return new MockNoteGenerationProvider(modelId);
    case PROVIDER_TYPES.anthropic:
      throw new Error(
        "Anthropic note generation isn't supported yet — the @ai-sdk/anthropic dependency hasn't been added",
      );
    case PROVIDER_TYPES.localWhisper:
      throw new Error(
        "Local Whisper is a transcription model and can't generate notes",
      );
    default: {
      throw new Error(
        `Note generation isn't configured for provider: ${instance.provider}`,
      );
    }
  }
}
