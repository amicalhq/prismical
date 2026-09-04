export * from "@prismical/app-contracts";
import type { CatalogEntry, Instance } from "@prismical/app-contracts";
import type { ProviderType } from "../../lib/providers";

// ─────────────────────────────────────────────────────────────────────────────
// Static catalogs.
//
// The seeds for folders, tags, notes, skills, vocabulary, and model instances
// have been retired — those are now served by the live API via React Query
// hooks; the Shortcuts screen renders the real registry in lib/shortcuts.ts.
// What remains is the
// static build-time catalogs the settings UI needs even without a running
// server (the provider model catalogs).
// ─────────────────────────────────────────────────────────────────────────────

// ─── AI Models: model catalogs per provider ─────────────────────────────────
// Static stand-in for the per-instance catalog the desktop fetches lazily.
// Keyed by provider type; the picker filters these by ModelType for the chosen
// use case.

const openAICatalog: CatalogEntry[] = [
  {
    id: "gpt-4o",
    name: "gpt-4o",
    type: "language",
    context: 128000,
    description: "Flagship multimodal model for text and reasoning tasks.",
    releaseDate: "2024-05-13",
  },
  {
    id: "gpt-4o-mini",
    name: "gpt-4o-mini",
    type: "language",
    context: 128000,
    description: "Small, fast, and affordable model for everyday tasks.",
    releaseDate: "2024-07-18",
  },
  {
    id: "o1",
    name: "o1",
    type: "language",
    context: 200000,
    description: "Reasoning model for complex, multi-step problems.",
    releaseDate: "2024-12-17",
  },
  {
    id: "gpt-4o-transcribe",
    name: "gpt-4o-transcribe",
    type: "transcription",
    description: "Speech-to-text on the gpt-4o family.",
    releaseDate: "2025-03-20",
  },
  {
    id: "whisper-1",
    name: "whisper-1",
    type: "transcription",
    description: "Classic Whisper API transcription model.",
    releaseDate: "2023-03-01",
  },
  {
    id: "text-embedding-3-large",
    name: "text-embedding-3-large",
    type: "embedding",
    releaseDate: "2024-01-25",
  },
];

const anthropicCatalog: CatalogEntry[] = [
  {
    id: "claude-3.7-sonnet",
    name: "Claude 3.7 Sonnet",
    type: "language",
    context: 200000,
    description: "Most intelligent Claude model with hybrid reasoning.",
    releaseDate: "2025-02-24",
  },
  {
    id: "claude-3.5-sonnet",
    name: "Claude 3.5 Sonnet",
    type: "language",
    context: 200000,
    description: "Balanced model for coding and agentic tasks.",
    releaseDate: "2024-10-22",
  },
  {
    id: "claude-3.5-haiku",
    name: "Claude 3.5 Haiku",
    type: "language",
    context: 200000,
    description: "Fastest Claude model for low-latency tasks.",
    releaseDate: "2024-11-04",
  },
  {
    id: "claude-3-opus",
    name: "Claude 3 Opus",
    type: "language",
    context: 200000,
    description: "Powerful model for highly complex work.",
    releaseDate: "2024-03-04",
  },
];

const openRouterCatalog: CatalogEntry[] = [
  {
    id: "anthropic/claude-3.5-sonnet",
    name: "Anthropic: Claude 3.5 Sonnet",
    type: "language",
    context: 200000,
    description: "Claude 3.5 Sonnet routed via OpenRouter.",
    releaseDate: "2024-10-22",
  },
  {
    id: "openai/gpt-4o",
    name: "OpenAI: GPT-4o",
    type: "language",
    context: 128000,
    description: "GPT-4o routed via OpenRouter.",
    releaseDate: "2024-05-13",
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Meta: Llama 3.3 70B Instruct",
    type: "language",
    context: 131072,
    description: "Open-weights Llama 3.3 70B.",
    releaseDate: "2024-12-06",
  },
  {
    id: "google/gemini-2.0-flash-001",
    name: "Google: Gemini 2.0 Flash",
    type: "language",
    context: 1000000,
    description: "Fast, capable Gemini model.",
    releaseDate: "2025-02-05",
  },
];

// Provider catalogs the picker draws on, keyed by provider type. Mock is
// handled separately (dev-only).
export const PROVIDER_CATALOGS: Partial<Record<ProviderType, CatalogEntry[]>> = {
  openai: openAICatalog,
  anthropic: anthropicCatalog,
  openrouter: openRouterCatalog,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Friendly display name for a selected model id on a given instance. */
export function modelDisplayName(
  instance: Instance | undefined,
  modelId: string,
): string {
  const fromCatalog = instance?.catalog.find((c) => c.id === modelId);
  return fromCatalog?.name ?? modelId;
}

