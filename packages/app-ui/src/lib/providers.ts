import type { ComponentType } from "react"
import type { ApplicationTranslationKey } from "@prismical/app-i18n"
import { AudioLines, Cloud, HardDrive, Plug, TestTube2 } from "lucide-react"

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
  deepgram: "deepgram",
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
  [PROVIDER_TYPES.deepgram]: "Deepgram",
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
  [PROVIDER_TYPES.deepgram]: false,
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
  [PROVIDER_TYPES.deepgram]: true,
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
  // Overrides the field's generic placeholder. Set it where the generic one would
  // be actively wrong: the shared apiKey hint is "sk-…", which is the OpenAI key
  // shape and tells a Deepgram user to look for a prefix their key does not have.
  placeholder?: string
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
  [PROVIDER_TYPES.deepgram]: [
    {
      field: "apiKey",
      inputType: "password",
      required: true,
      // Deepgram keys are opaque tokens with no prefix, so hint the source rather
      // than a shape the user could try to match.
      placeholder: "Your Deepgram API key",
    },
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
  [PROVIDER_TYPES.googleGemini]: ["transcription", "language"],
  // ASR only. Deepgram also sells text-to-speech; nothing in the product consumes it, and
  // the AI SDK provider's languageModel/embeddingModel throw NoSuchModelError by design.
  [PROVIDER_TYPES.deepgram]: ["transcription"],
  [PROVIDER_TYPES.vercelAIGateway]: [],
  [PROVIDER_TYPES.cloudflareWorkersAI]: [],
  [PROVIDER_TYPES.cerebras]: [],
}

/**
 * Provider types whose transcription lane can label speakers. Mirrors `diarizeBatch` in the
 * server's `asr-capabilities.ts`, which is the authority — keep the two in step, same as
 * PROVIDER_TYPE_CAPABILITIES mirrors the server's PROVIDER_CAPABILITIES.
 *
 * The picker uses this to warn before a user makes a provider their transcription default, so
 * absent-or-false must mean "no speaker labels": a provider missing from this map gets the
 * warning rather than a silent surprise after their first recording.
 */
export const PROVIDER_TYPE_SPEAKER_LABELS: Record<ProviderType, boolean> = {
  // OpenAI can diarize, but not on the terms the finalize lane pays for yet — see the reasoning
  // in the server's asr-capabilities.ts. Flip together with `openai.diarizeBatch` there.
  [PROVIDER_TYPES.openai]: false,
  [PROVIDER_TYPES.groq]: false,
  [PROVIDER_TYPES.localWhisper]: false,
  // Deepgram BYOK diarizes a whole session in one request, same wire call as the managed
  // strategy-A pass — so it labels speakers and must NOT carry the warning.
  [PROVIDER_TYPES.deepgram]: true,
  // Exhaustive on purpose: a `Partial` with a warn-default would tell users of any newly added
  // transcription provider that their speakers are not labelled until someone remembered to add
  // a key here. A compile error is the cheaper reminder.
  [PROVIDER_TYPES.mock]: false,
  [PROVIDER_TYPES.anthropic]: false,
  [PROVIDER_TYPES.openRouter]: false,
  [PROVIDER_TYPES.ollama]: false,
  [PROVIDER_TYPES.openAICompatible]: false,
  // Gemini CAN diarize, but only in a request that excludes custom vocabulary and is capped at
  // 30 minutes - so its transcription lane ships without speaker labels for now, and the picker
  // must say so. Flip together with `google-gemini.diarizeBatch` in the server's asr-capabilities.
  [PROVIDER_TYPES.googleGemini]: false,
  [PROVIDER_TYPES.vercelAIGateway]: false,
  [PROVIDER_TYPES.cloudflareWorkersAI]: false,
  [PROVIDER_TYPES.cerebras]: false,
}

export function providerLabelsSpeakers(provider: string): boolean {
  return isProviderType(provider) ? (PROVIDER_TYPE_SPEAKER_LABELS[provider] ?? false) : false
}

/**
 * Extra per-provider caveat shown in the TRANSCRIPTION picker, as a translation key.
 *
 * Separate from the speaker-labels warning because it answers a different question: not "what will
 * my transcript be missing" but "will this key keep up with a recording at all". Partial on
 * purpose - most providers have nothing to say here, and a note that appears for everyone is a note
 * nobody reads.
 */
export const PROVIDER_TYPE_TRANSCRIPTION_NOTE: Partial<
  Record<ProviderType, ApplicationTranslationKey>
> = {
  // Measured against the live API. The free tier's per-window request cap is far below what the
  // live lane needs: it posts a chunk every ~15s, so one recording asks for ~4/min and a
  // dual-lane desktop recording ~8/min. The exact ceiling varies by account and model (both
  // `limit: 3` and `limit: 25` were observed on the same metric), which is why the copy states
  // the consequence rather than a number. Worse, past the limit requests stall rather than
  // failing fast, so without this note the user just sees a live transcript stop. Nothing
  // rejects a free key; this sets the expectation instead.
  [PROVIDER_TYPES.googleGemini]: 'settings.aiModels.change.freeTierRateLimited',
}

export function providerTranscriptionNote(
  provider: string
): ApplicationTranslationKey | undefined {
  return isProviderType(provider) ? PROVIDER_TYPE_TRANSCRIPTION_NOTE[provider] : undefined
}

/**
 * Every caveat to show before this provider becomes someone's dictation default, in display order.
 *
 * A single accessor because the two facts have to travel together: they were previously rendered
 * as two hand-written blocks in one dialog, which is how the wizard - the screen where a new key
 * ACTUALLY becomes the default - ended up showing neither. Callers render the list; adding a third
 * caveat reaches every picker without touching one.
 */
export function providerTranscriptionCaveats(provider: string): ApplicationTranslationKey[] {
  const keys: ApplicationTranslationKey[] = []
  if (!providerLabelsSpeakers(provider)) keys.push('settings.aiModels.change.noSpeakerLabels')
  const note = providerTranscriptionNote(provider)
  if (note) keys.push(note)
  return keys
}

// The provider types the CLOUD backend actually serves today — it has BYOK factories + a fetchable
// `/me/instances/:id/models` catalog only for these (mirrors core `PROVIDER_CAPABILITIES`). Other
// connected types (Ollama, Anthropic, Groq, OpenAI-Compatible, …) can't be picked for a cloud model
// default or Ask curation yet, so the pickers filter to this set (capability is checked on top).
export const CLOUD_CATALOG_PROVIDERS: ProviderType[] = [
  PROVIDER_TYPES.openai,
  PROVIDER_TYPES.openRouter,
  PROVIDER_TYPES.googleGemini,
  PROVIDER_TYPES.deepgram,
]

// Type guard for narrowing arbitrary strings to ProviderType.
export function isProviderType(value: string): value is ProviderType {
  return (Object.values(PROVIDER_TYPES) as readonly string[]).includes(value)
}

// Global emergency suppression, applied in addition to organization visibility flags.
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
  // Lucide + brand tint rather than a wordmark: `provider-logos.tsx` renders real brand
  // SVGs from `public/provider-logos/`, and we hold no licensed Deepgram asset there. The
  // same fallback shape the OpenAI-Compatible and local-Whisper tiles already use; drop in
  // a themed SVG pair and swap this entry when one is available.
  [PROVIDER_TYPES.deepgram]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.deepgram],
    Logo: AudioLines,
    tint: "text-emerald-600 dark:text-emerald-400",
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

/** Organization feature key for each provider, including device-only and development types. */
export const PROVIDER_FEATURE_KEYS = {
  [PROVIDER_TYPES.openai]: "openaiByok",
  [PROVIDER_TYPES.anthropic]: "anthropicByok",
  [PROVIDER_TYPES.groq]: "groqByok",
  [PROVIDER_TYPES.openRouter]: "openRouterByok",
  [PROVIDER_TYPES.ollama]: "ollamaByok",
  [PROVIDER_TYPES.openAICompatible]: "openAICompatibleByok",
  [PROVIDER_TYPES.localWhisper]: "localWhisperByok",
  [PROVIDER_TYPES.mock]: "mockByok",
  [PROVIDER_TYPES.googleGemini]: "googleGeminiByok",
  [PROVIDER_TYPES.deepgram]: "deepgramByok",
  [PROVIDER_TYPES.vercelAIGateway]: "vercelAIGatewayByok",
  [PROVIDER_TYPES.cloudflareWorkersAI]: "cloudflareWorkersAIByok",
  [PROVIDER_TYPES.cerebras]: "cerebrasByok",
} as const satisfies Record<ProviderType, string>;

export function isProviderVisible(provider: string, isEnabled: (key: string) => boolean): boolean {
  return (
    isProviderType(provider) &&
    !isHiddenProviderType(provider) &&
    isEnabled(PROVIDER_FEATURE_KEYS[provider])
  );
}
