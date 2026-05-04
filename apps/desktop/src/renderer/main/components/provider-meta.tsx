import type { ComponentType } from "react";
import { Cloud, HardDrive, Plug, TestTube2 } from "lucide-react";
import {
  PROVIDER_TYPES,
  PROVIDER_TYPE_LABELS,
  type ProviderType,
} from "@/constants/provider-types";
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
} from "@/renderer/main/components/logos";

// UI-side metadata for the AI Models settings page. Pulled into its own
// file so the constants module stays React-free and importable from the
// main process.
//
// Brand logos for the cloud providers come from svgl.app; the source
// SVGs and their light/dark wrappers live in `./logos/`. The
// non-branded providers (whisper, openai-compatible, mock) keep
// Lucide icons because they don't have an established brand mark in
// our context.

// `className` is the only thing consumers need to set (size, optional
// dark-mode tweaks). LucideIcon's full SVGProps surface is wider than
// what brand logos can support — many ship as <img> tags whose
// theming is hard-coded — so we use this narrower contract for both.
export type ProviderLogo = ComponentType<{ className?: string }>;

export interface ProviderMeta {
  label: string;
  Logo: ProviderLogo;
  /**
   * Tailwind text class used to tint Lucide-based logos via
   * currentColor. Brand-image logos (svgl) ignore this since they ship
   * with their own colors.
   */
  tint?: string;
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
};

/** Lookup helper that falls back to a generic icon for unknown types. */
export function getProviderMeta(type: string): ProviderMeta {
  if (type in PROVIDER_META) {
    return PROVIDER_META[type as ProviderType];
  }
  return {
    label: type,
    Logo: Cloud,
    tint: "text-muted-foreground",
  };
}
