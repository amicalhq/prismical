import { getUserAgent } from "../../utils/http-client";
import { logger } from "../../main/logger";
import type { CatalogEntry, ModelType } from "./types";

// Memoized fetch of https://models.dev/api.json — a curated, provider-keyed
// catalog. We use it primarily as the catalog source for providers without
// a list-models endpoint (Anthropic). Other providers can also fall back to
// it when their direct call fails or returns nothing.

const MODELS_DEV_URL = "https://models.dev/api.json";

// Shape we read from the response. We're intentionally permissive — any
// missing field collapses to `undefined` in the normalized CatalogEntry.
interface ModelsDevModel {
  id?: string;
  name?: string;
  description?: string;
  // models.dev expresses modality input/output as arrays; "audio" → speech,
  // "embedding" output → embedding, otherwise language.
  modalities?: {
    input?: string[];
    output?: string[];
  };
  limit?: {
    context?: number;
  };
  cost?: {
    input?: number;
    output?: number;
  };
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

interface ModelsDevResponse {
  // Top-level keyed by provider id (e.g. "openai", "anthropic").
  [providerId: string]: ModelsDevProvider | undefined;
}

let cached: Promise<ModelsDevResponse | null> | null = null;

export async function getModelsDevCatalog(): Promise<ModelsDevResponse | null> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const response = await fetch(MODELS_DEV_URL, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": getUserAgent(),
        },
      });
      if (!response.ok) {
        logger.main.warn(`models.dev returned HTTP ${response.status}`);
        return null;
      }
      return (await response.json()) as ModelsDevResponse;
    } catch (error) {
      logger.main.warn("Failed to fetch models.dev catalog", error);
      return null;
    }
  })();
  return cached;
}

/** Force a re-fetch on next call. Exposed for a "refresh" button in the UI. */
export function invalidateModelsDevCache(): void {
  cached = null;
}

/**
 * Convert one models.dev model entry to a CatalogEntry. Returns null if the
 * entry can't be classified (e.g. image-only) so the caller can drop it.
 */
export function modelsDevEntryToCatalog(
  modelId: string,
  m: ModelsDevModel,
): CatalogEntry | null {
  const type = classifyModelsDevModality(m.modalities);
  if (!type) return null;

  const id = m.id ?? modelId;
  const entry: CatalogEntry = {
    id,
    name: m.name ?? id,
    type,
  };
  if (typeof m.limit?.context === "number") entry.context = m.limit.context;
  if (typeof m.description === "string") entry.description = m.description;
  if (
    typeof m.cost?.input === "number" &&
    typeof m.cost?.output === "number"
  ) {
    entry.pricing = { input: m.cost.input, output: m.cost.output };
  }
  return entry;
}

function classifyModelsDevModality(
  modalities: ModelsDevModel["modalities"],
): ModelType | null {
  // Drop entries that don't declare modalities — better an empty picker than
  // surfacing image/tts models in the language list because metadata was
  // missing.
  if (!modalities) return null;

  const input = modalities.input ?? [];
  const output = modalities.output ?? [];

  // Speech-to-text: audio input → text output.
  if (input.includes("audio") && output.includes("text")) return "speech";
  // Embeddings: vector/embedding output.
  if (output.includes("embedding") || output.includes("vector")) {
    return "embedding";
  }
  // Anything that produces text (and isn't already classified above) is a
  // language model. Image/video/audio-only outputs fall through to null.
  if (output.includes("text")) return "language";
  return null;
}
