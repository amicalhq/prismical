import { PROVIDER_TYPES, type ProviderType } from "@/constants/provider-types";
import type { SettingsService } from "@/services/settings-service";
import { MockNoteGenerationProvider } from "./mock-note-generation-provider";
import { OllamaNoteGenerationProvider } from "./ollama-note-generation-provider";
import { OpenAICompatibleNoteGenerationProvider } from "./openai-compatible-note-generation-provider";
import { OpenRouterNoteGenerationProvider } from "./openrouter-note-generation-provider";
import type { NoteGenerationProvider } from "./types";

export type RemoteNoteGenerationProviderType = Extract<
  ProviderType,
  | typeof PROVIDER_TYPES.openRouter
  | typeof PROVIDER_TYPES.ollama
  | typeof PROVIDER_TYPES.openAICompatible
  | typeof PROVIDER_TYPES.mock
>;

const registry: {
  [K in RemoteNoteGenerationProviderType]: (
    settingsService: SettingsService,
    modelId: string,
  ) => Promise<NoteGenerationProvider | null>;
} = {
  [PROVIDER_TYPES.openRouter]: async (settingsService, modelId) => {
    const config = await settingsService.getOpenRouterConfig();
    if (!config?.apiKey) {
      return null;
    }

    return new OpenRouterNoteGenerationProvider(config.apiKey, modelId);
  },
  [PROVIDER_TYPES.ollama]: async (settingsService, modelId) => {
    const config = await settingsService.getOllamaConfig();
    if (!config?.url) {
      return null;
    }

    return new OllamaNoteGenerationProvider(config.url, modelId);
  },
  [PROVIDER_TYPES.openAICompatible]: async (settingsService, modelId) => {
    const config = await settingsService.getOpenAICompatibleConfig();
    if (!config?.apiKey || !config?.baseURL) {
      return null;
    }

    return new OpenAICompatibleNoteGenerationProvider(
      config.apiKey,
      config.baseURL,
      modelId,
    );
  },
  [PROVIDER_TYPES.mock]: async (_settingsService, modelId) => {
    return new MockNoteGenerationProvider(modelId);
  },
};

export async function createRemoteNoteGenerationProvider(
  settingsService: SettingsService,
  providerType: RemoteNoteGenerationProviderType,
  modelId: string,
): Promise<NoteGenerationProvider | null> {
  return registry[providerType](settingsService, modelId);
}
