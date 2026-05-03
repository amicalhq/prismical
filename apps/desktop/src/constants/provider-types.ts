// Static registry of supported AI provider types. Provider *instances*
// (rows in the `instances` table) carry the user's credentials; this file
// holds compile-time metadata about the types themselves.
//
// To add a new provider type:
//   1. Add an entry to `PROVIDER_TYPES`.
//   2. Add label, multi-instance flag, and config fields below. If the new
//      type is a singleton, also add it to `SINGLETON_INSTANCE_IDS`.
//   3. Add a catalog fetcher in `services/catalog/`.
//   4. Add a logo entry in the UI provider-meta file.
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
  [PROVIDER_TYPES.localWhisper]: "Local",
  [PROVIDER_TYPES.mock]: "Mock",
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
export type InstanceConfigFieldName = "apiKey" | "url" | "baseURL";

export interface InstanceConfigFieldSpec {
  field: InstanceConfigFieldName;
  inputType: "password" | "text";
  required: boolean;
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
  ],
  [PROVIDER_TYPES.localWhisper]: [],
  [PROVIDER_TYPES.mock]: [],
};

// Type guard for narrowing arbitrary strings to ProviderType.
export function isProviderType(value: string): value is ProviderType {
  return (Object.values(PROVIDER_TYPES) as readonly string[]).includes(value);
}
