import type { ComponentType } from "react"
import { Cloud, HardDrive, Plug, TestTube2 } from "lucide-react"

import {
  AnthropicLogo,
  CerebrasLogo,
  CloudflareLogo,
  GeminiLogo,
  GroqLogo,
  OllamaLogo,
  OpenAILogo,
  OpenRouterLogo,
  VercelLogo,
} from "../components/provider-logos"

// ─── Provider type registry ─────────────────────────────────────────────────
// Static registry of supported AI provider types, mirrored from the desktop
// app's `constants/provider-types.ts`. Provider *instances* carry the user's
// credentials (see mock-data.ts); this holds compile-time metadata about the
// types themselves.

export type ModelType = "transcription" | "language" | "embedding"

export const PROVIDER_TYPES = {
  openai: "openai",
  anthropic: "anthropic",
  groq: "groq",
  openRouter: "openrouter",
  ollama: "ollama",
  openAICompatible: "openai-compatible",
  localWhisper: "local-whisper",
  mock: "mock",
  googleGemini: "google-gemini",
  // Coming-soon placeholders. Surfaced in the Available tiles (disabled, with
  // a "Coming soon" tooltip) so users can see what's on the roadmap.
  vercelAIGateway: "vercel-ai-gateway",
  cloudflareWorkersAI: "cloudflare-workers-ai",
  cerebras: "cerebras",
} as const

export type ProviderType = (typeof PROVIDER_TYPES)[keyof typeof PROVIDER_TYPES]

// Canonical English label per type.
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
}

// Tiles for these providers render disabled with a "Coming soon" tooltip.
export const PROVIDER_TYPE_COMING_SOON: Record<ProviderType, boolean> = {
  [PROVIDER_TYPES.openai]: false,
  [PROVIDER_TYPES.anthropic]: true,
  [PROVIDER_TYPES.groq]: true,
  [PROVIDER_TYPES.openRouter]: false,
  [PROVIDER_TYPES.ollama]: true,
  [PROVIDER_TYPES.openAICompatible]: true,
  [PROVIDER_TYPES.localWhisper]: false,
  [PROVIDER_TYPES.mock]: false,
  [PROVIDER_TYPES.googleGemini]: false,
  [PROVIDER_TYPES.vercelAIGateway]: true,
  [PROVIDER_TYPES.cloudflareWorkersAI]: true,
  [PROVIDER_TYPES.cerebras]: true,
}

// Whether multiple instances of this type are allowed. Singletons
// (local-whisper, mock) are seeded with fixed ids.
export const PROVIDER_TYPE_MULTI_INSTANCE: Record<ProviderType, boolean> = {
  [PROVIDER_TYPES.openai]: true,
  [PROVIDER_TYPES.anthropic]: true,
  [PROVIDER_TYPES.groq]: true,
  [PROVIDER_TYPES.openRouter]: true,
  [PROVIDER_TYPES.ollama]: true,
  [PROVIDER_TYPES.openAICompatible]: true,
  [PROVIDER_TYPES.localWhisper]: false,
  [PROVIDER_TYPES.mock]: false,
  [PROVIDER_TYPES.googleGemini]: true,
  [PROVIDER_TYPES.vercelAIGateway]: true,
  [PROVIDER_TYPES.cloudflareWorkersAI]: true,
  [PROVIDER_TYPES.cerebras]: true,
}

// Fixed ids for the singleton system instances.
export const SINGLETON_INSTANCE_IDS: Readonly<
  Partial<Record<ProviderType, string>>
> = {
  [PROVIDER_TYPES.localWhisper]: "system-local-whisper",
  [PROVIDER_TYPES.mock]: "system-mock",
}

// Form-field spec for the Add/Edit Instance dialog. Order of entries
// determines order of inputs in the form. Empty array = no form.
export type InstanceConfigFieldName =
  | "apiKey"
  | "url"
  | "baseURL"
  | "supportsStrictJsonSchema"

export interface InstanceConfigFieldSpec {
  field: InstanceConfigFieldName
  inputType: "password" | "text" | "checkbox"
  required: boolean
  // When true, the field renders inside a collapsible "Advanced settings"
  // section instead of the main field stack.
  advanced?: boolean
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
  [PROVIDER_TYPES.ollama]: [{ field: "url", inputType: "text", required: true }],
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
  [PROVIDER_TYPES.googleGemini]: [
    { field: "apiKey", inputType: "password", required: true },
  ],
  [PROVIDER_TYPES.vercelAIGateway]: [],
  [PROVIDER_TYPES.cloudflareWorkersAI]: [],
  [PROVIDER_TYPES.cerebras]: [],
}

// Capabilities per provider type. Used by the model picker to filter which
// instances are eligible for which use case.
export const PROVIDER_TYPE_CAPABILITIES: Record<ProviderType, ModelType[]> = {
  [PROVIDER_TYPES.openai]: ["transcription", "language", "embedding"],
  [PROVIDER_TYPES.anthropic]: ["language"],
  // Transcription-only in cloud BYOK: the server's PROVIDER_CAPABILITIES exposes no
  // groq language models — listing them here would surface instances that 422 at run time.
  [PROVIDER_TYPES.groq]: ["transcription"],
  [PROVIDER_TYPES.openRouter]: ["language"],
  [PROVIDER_TYPES.ollama]: ["language", "embedding"],
  [PROVIDER_TYPES.openAICompatible]: ["language", "embedding"],
  [PROVIDER_TYPES.localWhisper]: ["transcription"],
  [PROVIDER_TYPES.mock]: ["transcription", "language", "embedding"],
  // Google also exposes embeddings, but core has no embedding execution path yet.
  [PROVIDER_TYPES.googleGemini]: ["language"],
  [PROVIDER_TYPES.vercelAIGateway]: [],
  [PROVIDER_TYPES.cloudflareWorkersAI]: [],
  [PROVIDER_TYPES.cerebras]: [],
}

// The provider types the CLOUD backend actually serves today — it has BYOK factories + a fetchable
// `/me/instances/:id/models` catalog only for these (mirrors core `PROVIDER_CAPABILITIES`). Other
// connected types (Ollama, Anthropic, Groq, OpenAI-Compatible, …) can't be picked for a cloud model
// default or Ask curation yet, so the pickers filter to this set (capability is checked on top).
export const CLOUD_CATALOG_PROVIDERS: ProviderType[] = [
  PROVIDER_TYPES.openai,
  PROVIDER_TYPES.openRouter,
  PROVIDER_TYPES.googleGemini,
]

// Type guard for narrowing arbitrary strings to ProviderType.
export function isProviderType(value: string): value is ProviderType {
  return (Object.values(PROVIDER_TYPES) as readonly string[]).includes(value)
}

// Provider types hidden from the AI-models UI entirely. Keep this for emergency
// product/security suppression; normal unavailable states must remain visible as
// either coming-soon cloud providers or desktop-only local providers.
export const HIDDEN_PROVIDER_TYPES: ReadonlySet<ProviderType> = new Set<ProviderType>()

/** Whether a provider type is hidden from the AI-models UI (see HIDDEN_PROVIDER_TYPES). */
export function isHiddenProviderType(type: ProviderType): boolean {
  return HIDDEN_PROVIDER_TYPES.has(type)
}

// ─── Provider UI metadata ───────────────────────────────────────────────────

export type ProviderLogo = ComponentType<{ className?: string }>

export interface ProviderMeta {
  label: string
  Logo: ProviderLogo
  /** Tailwind text class used to tint Lucide-based logos via currentColor. */
  tint?: string
}

export const PROVIDER_META: Record<ProviderType, ProviderMeta> = {
  [PROVIDER_TYPES.openai]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.openai],
    Logo: OpenAILogo,
  },
  [PROVIDER_TYPES.anthropic]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.anthropic],
    Logo: AnthropicLogo,
  },
  [PROVIDER_TYPES.groq]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.groq],
    Logo: GroqLogo,
  },
  [PROVIDER_TYPES.openRouter]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.openRouter],
    Logo: OpenRouterLogo,
  },
  [PROVIDER_TYPES.ollama]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.ollama],
    Logo: OllamaLogo,
  },
  [PROVIDER_TYPES.openAICompatible]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.openAICompatible],
    Logo: Plug,
    tint: "text-slate-600 dark:text-slate-400",
  },
  [PROVIDER_TYPES.localWhisper]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.localWhisper],
    Logo: HardDrive,
    tint: "text-indigo-600 dark:text-indigo-400",
  },
  [PROVIDER_TYPES.mock]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.mock],
    Logo: TestTube2,
    tint: "text-zinc-500 dark:text-zinc-400",
  },
  [PROVIDER_TYPES.googleGemini]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.googleGemini],
    Logo: GeminiLogo,
  },
  [PROVIDER_TYPES.vercelAIGateway]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.vercelAIGateway],
    Logo: VercelLogo,
  },
  [PROVIDER_TYPES.cloudflareWorkersAI]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.cloudflareWorkersAI],
    Logo: CloudflareLogo,
  },
  [PROVIDER_TYPES.cerebras]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.cerebras],
    Logo: CerebrasLogo,
  },
}

/** Lookup helper that falls back to a generic icon for unknown types. */
export function getProviderMeta(type: string): ProviderMeta {
  if (type in PROVIDER_META) {
    return PROVIDER_META[type as ProviderType]
  }
  return {
    label: type,
    Logo: Cloud,
    tint: "text-muted-foreground",
  }
}
