import {
  PROVIDER_TYPES,
  isProviderType,
  type ProviderType,
} from "../../constants/provider-types";
import type {
  ApiKeyConfig,
  Instance,
  LocalWhisperConfig,
  OllamaConfig,
  OpenAICompatibleConfig,
} from "../../db/schema";
import {
  fetchAnthropicCatalog,
  fetchGroqCatalog,
  fetchLocalWhisperCatalog,
  fetchMockCatalog,
  fetchOllamaCatalog,
  fetchOpenAICatalog,
  fetchOpenAICompatibleCatalog,
  fetchOpenRouterCatalog,
} from "./fetchers";
import type { CatalogEntry } from "./types";

export type { CatalogEntry, ModelPricing, ModelType } from "./types";
export { invalidateModelsDevCache } from "./models-dev";

/**
 * Fetch the model catalog for a single instance. Dispatches to the right
 * per-type fetcher and narrows the JSON config to the expected shape.
 *
 * Throws on HTTP/parse errors; returns [] for an instance that has nothing
 * to surface (e.g. a fresh local-whisper instance with no downloads).
 *
 * Defends against corrupted rows: if `instance.type` isn't a known
 * `ProviderType`, throws with the specific row id and value rather than
 * silently dispatching to an unrelated branch.
 */
export async function getCatalog(instance: Instance): Promise<CatalogEntry[]> {
  if (!isProviderType(instance.type)) {
    throw new Error(
      `Instance ${instance.id} has unknown provider type: ${instance.type}`,
    );
  }
  const type: ProviderType = instance.type;
  switch (type) {
    case PROVIDER_TYPES.openai:
      return fetchOpenAICatalog(instance.config as ApiKeyConfig);
    case PROVIDER_TYPES.anthropic:
      return fetchAnthropicCatalog();
    case PROVIDER_TYPES.groq:
      return fetchGroqCatalog(instance.config as ApiKeyConfig);
    case PROVIDER_TYPES.openRouter:
      return fetchOpenRouterCatalog(instance.config as ApiKeyConfig);
    case PROVIDER_TYPES.ollama:
      return fetchOllamaCatalog(instance.config as OllamaConfig);
    case PROVIDER_TYPES.openAICompatible:
      return fetchOpenAICompatibleCatalog(
        instance.config as OpenAICompatibleConfig,
      );
    case PROVIDER_TYPES.localWhisper:
      return fetchLocalWhisperCatalog(instance.config as LocalWhisperConfig);
    case PROVIDER_TYPES.mock:
      return fetchMockCatalog();
    case PROVIDER_TYPES.googleGemini:
    case PROVIDER_TYPES.vercelAIGateway:
    case PROVIDER_TYPES.cloudflareWorkersAI:
    case PROVIDER_TYPES.cerebras:
      // Coming-soon placeholders. Tile is disabled in the UI so this
      // shouldn't be reached, but throw loudly if someone calls in
      // (corrupted row, programmatic creation, etc.) so we notice.
      throw new Error(
        `${type} catalog isn't supported yet — provider listed as "Coming soon"`,
      );
    default: {
      // Exhaustiveness check — adding a provider type without a catalog
      // fetcher fails the type-check here.
      const exhaustive: never = type;
      throw new Error(`No catalog fetcher for provider type: ${exhaustive}`);
    }
  }
}
