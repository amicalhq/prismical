import type { ComponentType, SVGProps } from "react";
import {
  Cloud,
  Cpu,
  Globe,
  Mic,
  Plug,
  Server,
  Sparkles,
  TestTube2,
} from "lucide-react";
import {
  PROVIDER_TYPES,
  PROVIDER_TYPE_LABELS,
  type ProviderType,
} from "@/constants/provider-types";

// UI-side metadata for the AI Models settings page. Pulled into its own
// file so the constants module stays React-free and importable from the
// main process.
//
// Logos are Lucide icons today as a working baseline. To replace any
// entry with the real brand SVG, install via the svgl.app shadcn
// registry into `components/logos/` and swap the `Logo` reference here:
//   npx shadcn@latest add https://svgl.app/library/<name>.svg
// (svgl exposes raw SVGs at the URL shown above; wrap as a React
// component or use an `<img>` source; both work with `currentColor` for
// dark/light theming.)

// Widened from `LucideIcon` so a future svgl-sourced wrapper component
// (or any plain SVG component accepting `className`) satisfies the type
// without changing this file.
export type ProviderLogo = ComponentType<SVGProps<SVGSVGElement>>;

export interface ProviderMeta {
  label: string;
  Logo: ProviderLogo;
  /** Tailwind text class for tinting the icon when rendered inline. */
  tint?: string;
}

export const PROVIDER_META: Record<ProviderType, ProviderMeta> = {
  [PROVIDER_TYPES.openai]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.openai],
    Logo: Sparkles,
    tint: "text-emerald-600 dark:text-emerald-400",
  },
  [PROVIDER_TYPES.anthropic]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.anthropic],
    Logo: Sparkles,
    tint: "text-orange-600 dark:text-orange-400",
  },
  [PROVIDER_TYPES.groq]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.groq],
    Logo: Cpu,
    tint: "text-rose-600 dark:text-rose-400",
  },
  [PROVIDER_TYPES.openRouter]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.openRouter],
    Logo: Globe,
    tint: "text-sky-600 dark:text-sky-400",
  },
  [PROVIDER_TYPES.ollama]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.ollama],
    Logo: Server,
    tint: "text-violet-600 dark:text-violet-400",
  },
  [PROVIDER_TYPES.openAICompatible]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.openAICompatible],
    Logo: Plug,
    tint: "text-slate-600 dark:text-slate-400",
  },
  [PROVIDER_TYPES.localWhisper]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.localWhisper],
    Logo: Mic,
    tint: "text-emerald-700 dark:text-emerald-300",
  },
  [PROVIDER_TYPES.mock]: {
    label: PROVIDER_TYPE_LABELS[PROVIDER_TYPES.mock],
    Logo: TestTube2,
    tint: "text-zinc-500 dark:text-zinc-400",
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
