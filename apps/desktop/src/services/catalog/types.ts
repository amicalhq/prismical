// Normalized model metadata returned by every catalog fetcher. UI components
// consume this shape; provider-specific response shapes are flattened here so
// the picker doesn't need per-provider rendering branches.

export type ModelType = "speech" | "language" | "embedding";

export interface CatalogEntry {
  id: string; // provider-native model id, e.g. "gpt-4o-mini" or "anthropic/claude-3.5-sonnet"
  name: string; // display name; falls back to id when the provider doesn't supply one
  type: ModelType;
  context?: number; // context window in tokens (raw number; UI formats to "32k" etc.)
  pricing?: ModelPricing; // USD per 1M tokens, when known
  description?: string;
}

export interface ModelPricing {
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}
