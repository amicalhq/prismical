import type { ModelType } from "../services/catalog";

// Static registry of supported AI provider types. Provider *instances*
// (rows in the `instances` table) carry the user's credentials; this file
// holds compile-time metadata about the types themselves.
//
// To add a new provider type:
//   1. Add an entry to `PROVIDER_TYPES`.
//   2. Add label, multi-instance flag, and config fields below. If the new
//      type is a singleton, also add it to `SINGLETON_INSTANCE_IDS`.
//   3. Add a catalog fetcher in `services/catalog/`.
//   4. Add a logo entry in the UI provider-meta file
//      (`renderer/main/components/provider-meta.tsx`). The `label` there
//      mirrors `PROVIDER_TYPE_LABELS` below — keep them aligned.
//   5. Update `InstanceConfig` in `db/schema.ts` if the config payload is novel.

export const PROVIDER_TYPES = {
  openai: "openai",
  anthropic: "anthropic",
  groq: "groq",
  openRouter: "openrouter",
  ollama: "ollama",
  openAICompatible: "openai-compatible",
  localWhisper: "local-whisper",
  mock: "mock",
  // Coming-soon placeholders. Surfaced in the Available tiles
  // (disabled, with a "Coming soon" tooltip) so users can see
  // what's on the roadmap without being able to add instances yet.
  // Catalog fetcher / validator / runtime registries are
  // intentionally not implemented for these.
  googleGemini: "google-gemini",
  vercelAIGateway: "vercel-ai-gateway",
  cloudflareWorkersAI: "cloudflare-workers-ai",
  cerebras: "cerebras",
} as const;

export type ProviderType = (typeof PROVIDER_TYPES)[keyof typeof PROVIDER_TYPES];

// Canonical English label per type. UI can override with i18n; tRPC error
// messages and logs use these directly.
export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  [PROVIDER_TYPES.openai]: "OpenAI",
  [PROVIDER_TYPES.anthropic]: "Anthropic",
  [PROVIDER_TYPES.groq]: "Groq",
  [PROVIDER_TYPES.openRouter]: "OpenRouter",
  [PROVIDER_TYPES.ollama]: "Ollama",
  [PROVIDER_TYPES.openAICompatible]: "OpenAI Compatible",
  [PROVIDER_TYPES.localWhisper]: "Whisper (local)",
  [PROVIDER_TYPES.mock]: "Mock",
  [PROVIDER_TYPES.googleGemini]: "Google Gemini",
  [PROVIDER_TYPES.vercelAIGateway]: "Vercel AI Gateway",
  [PROVIDER_TYPES.cloudflareWorkersAI]: "Cloudflare Workers AI",
  [PROVIDER_TYPES.cerebras]: "Cerebras",
};

// Tiles for these providers render disabled in the Available list
// with a "Coming soon" tooltip. Anthropic and Groq are gated here
// pending direct AI-SDK integrations; the others are pure roadmap
// placeholders. Flip to false once each is fully wired (catalog +
// validator + runtime).
export const PROVIDER_TYPE_COMING_SOON: Record<ProviderType, boolean> = {
  [PROVIDER_TYPES.openai]: false,
  [PROVIDER_TYPES.anthropic]: false,
  [PROVIDER_TYPES.groq]: false,
  [PROVIDER_TYPES.openRouter]: false,
  [PROVIDER_TYPES.ollama]: false,
  [PROVIDER_TYPES.openAICompatible]: false,
  [PROVIDER_TYPES.localWhisper]: false,
  [PROVIDER_TYPES.mock]: false,
  [PROVIDER_TYPES.googleGemini]: true,
  [PROVIDER_TYPES.vercelAIGateway]: true,
  [PROVIDER_TYPES.cloudflareWorkersAI]: true,
  [PROVIDER_TYPES.cerebras]: true,
};

// Whether multiple instances of this type are allowed. Singletons
// (local-whisper, mock) are seeded with fixed primary keys at startup;
// the instances tRPC router must reject attempts to add more.
export const PROVIDER_TYPE_MULTI_INSTANCE: Record<ProviderType, boolean> = {
  [PROVIDER_TYPES.openai]: true,
  [PROVIDER_TYPES.anthropic]: true,
  [PROVIDER_TYPES.groq]: true,
  [PROVIDER_TYPES.openRouter]: true,
  [PROVIDER_TYPES.ollama]: true,
  [PROVIDER_TYPES.openAICompatible]: true,
  [PROVIDER_TYPES.localWhisper]: false,
  [PROVIDER_TYPES.mock]: false,
  // Coming-soon — tentative; revisit when implementing.
  [PROVIDER_TYPES.googleGemini]: true,
  [PROVIDER_TYPES.vercelAIGateway]: true,
  [PROVIDER_TYPES.cloudflareWorkersAI]: true,
  [PROVIDER_TYPES.cerebras]: true,
};

// Fixed primary keys for the singleton system instances. Must match the
// schema-comment contract in `db/schema.ts`. Bootstrap uses `INSERT OR
// IGNORE` keyed on these IDs to enforce single-row-ness via PK.
export const SINGLETON_INSTANCE_IDS: Readonly<
  Partial<Record<ProviderType, string>>
> = {
  [PROVIDER_TYPES.localWhisper]: "system-local-whisper",
  [PROVIDER_TYPES.mock]: "system-mock",
};

// Form-field spec for the Add/Edit Instance dialog. Order of entries
// determines order of inputs in the form. Empty array = no form (the
// instance is always seeded by the system, not the user).
export type InstanceConfigFieldName =
  | "apiKey"
  | "url"
  | "baseURL"
  | "supportsStrictJsonSchema";

export interface InstanceConfigFieldSpec {
  field: InstanceConfigFieldName;
  inputType: "password" | "text" | "checkbox";
  required: boolean;
  // When true, the form renders the field inside a collapsible
  // "Advanced settings" section instead of the main field stack.
  advanced?: boolean;
}

export const PROVIDER_TYPE_CONFIG_FIELDS: Record<
  ProviderType,
  readonly InstanceConfigFieldSpec[]
> = {
  [PROVIDER_TYPES.openai]: [
    { field: "apiKey", inputType: "password", required: true },
  ],
  [PROVIDER_TYPES.anthropic]: [
    { field: "apiKey", inputType: "password", required: true },
  ],
  [PROVIDER_TYPES.groq]: [
    { field: "apiKey", inputType: "password", required: true },
  ],
  [PROVIDER_TYPES.openRouter]: [
    { field: "apiKey", inputType: "password", required: true },
  ],
  [PROVIDER_TYPES.ollama]: [
    { field: "url", inputType: "text", required: true },
  ],
  [PROVIDER_TYPES.openAICompatible]: [
    { field: "baseURL", inputType: "text", required: true },
    { field: "apiKey", inputType: "password", required: true },
    {
      field: "supportsStrictJsonSchema",
      inputType: "checkbox",
      required: false,
      advanced: true,
    },
  ],
  [PROVIDER_TYPES.localWhisper]: [],
  [PROVIDER_TYPES.mock]: [],
  // Coming-soon types have no form (the tile is disabled, no dialog
  // ever opens). Empty arrays are placeholders so the registry stays
  // total over ProviderType.
  [PROVIDER_TYPES.googleGemini]: [],
  [PROVIDER_TYPES.vercelAIGateway]: [],
  [PROVIDER_TYPES.cloudflareWorkersAI]: [],
  [PROVIDER_TYPES.cerebras]: [],
};

// Capabilities per provider type. Used by the model picker (and similar
// UIs) to filter which instances are eligible for which use case without
// having to fetch each instance's catalog. Static map: kept in lockstep
// with the catalog fetcher classifiers for the same type — if a fetcher
// can produce a given ModelType, that ModelType belongs here.
//
// "openai-compatible" is a wildcard endpoint shape. We assume any of
// language/embedding might be hosted there. Speech-on-compatible is
// rare; left out by default to avoid surfacing irrelevant instances in
// the transcription picker.
export const PROVIDER_TYPE_CAPABILITIES: Record<ProviderType, ModelType[]> = {
  [PROVIDER_TYPES.openai]: ["transcription", "language", "embedding"],
  [PROVIDER_TYPES.anthropic]: ["language"],
  [PROVIDER_TYPES.groq]: ["transcription", "language"],
  [PROVIDER_TYPES.openRouter]: ["language"],
  [PROVIDER_TYPES.ollama]: ["language", "embedding"],
  [PROVIDER_TYPES.openAICompatible]: ["language", "embedding"],
  [PROVIDER_TYPES.localWhisper]: ["transcription"],
  [PROVIDER_TYPES.mock]: ["transcription", "language", "embedding"],
  // Coming-soon — empty until each is wired. Picker filters by this
  // map, so leaving them empty also keeps stray instances out.
  [PROVIDER_TYPES.googleGemini]: [],
  [PROVIDER_TYPES.vercelAIGateway]: [],
  [PROVIDER_TYPES.cloudflareWorkersAI]: [],
  [PROVIDER_TYPES.cerebras]: [],
};

// Type guard for narrowing arbitrary strings to ProviderType.
export function isProviderType(value: string): value is ProviderType {
  return (Object.values(PROVIDER_TYPES) as readonly string[]).includes(value);
}
