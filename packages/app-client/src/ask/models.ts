import type { Instance } from "@prismical/app-contracts";

/** Reserved id for managed inference (mirrors the core backbone). Not a real instance row. */
export const PRISMICAL_CLOUD_INSTANCE_ID = "prismical-cloud";
export const AUTO_MODEL_ID = "auto";
/**
 * Providers whose curated models the selector surfaces: the V1 BYOK set the cloud backbone runs,
 * plus the providers the desktop's local mode serves as synthetic instances —
 * Anthropic, Ollama, any OpenAI-compatible endpoint). Core never creates rows of the latter kinds,
 * so the web picker is unchanged by their presence here.
 */
const CATALOG_PROVIDERS = new Set(["openai", "openrouter", "anthropic", "ollama", "openai-compatible"]);
const PREF_KEY = "ask.model.v1";

export interface AskModelSelection {
  instanceId: string;
  modelId: string;
}
export interface AskModelOption extends AskModelSelection {
  label: string;
}
export interface AskModelGroup {
  instanceId: string;
  label: string;
  provider: string;
  options: AskModelOption[];
}

/** The default / fallback selection — Prismical Cloud's "Auto". Always present in the selector. */
export const AUTO_SELECTION: AskModelSelection = {
  instanceId: PRISMICAL_CLOUD_INSTANCE_ID,
  modelId: AUTO_MODEL_ID,
};

export function isAuto(sel: AskModelSelection): boolean {
  return sel.instanceId === PRISMICAL_CLOUD_INSTANCE_ID;
}

function selectedModelsOf(config: Instance["config"]): string[] {
  const v = (config as { selectedModels?: unknown }).selectedModels;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Build the selector groups: Prismical Cloud → Auto first, then each catalog-capable instance that has
 * curated models → one group per instance listing its `selectedModels`. Instances with no curation (or
 * an unsupported provider) are omitted — there'd be nothing to pick.
 */
export function buildAskModelGroups(
  instances: Instance[],
  autoLabel: string,
  /** The managed group's label; the desktop's local mode names its device provider instead. */
  managedLabel = "Prismical Cloud",
): AskModelGroup[] {
  const groups: AskModelGroup[] = [
    {
      instanceId: PRISMICAL_CLOUD_INSTANCE_ID,
      label: managedLabel,
      provider: PRISMICAL_CLOUD_INSTANCE_ID,
      options: [
        {
          instanceId: PRISMICAL_CLOUD_INSTANCE_ID,
          modelId: AUTO_MODEL_ID,
          label: autoLabel,
        },
      ],
    },
  ];
  for (const inst of instances) {
    if (!CATALOG_PROVIDERS.has(inst.provider)) continue;
    const ids = selectedModelsOf(inst.config);
    if (ids.length === 0) continue;
    groups.push({
      instanceId: inst.id,
      label: inst.label,
      provider: inst.provider,
      options: ids.map((id) => ({ instanceId: inst.id, modelId: id, label: id })),
    });
  }
  return groups;
}

/** The option matching a selection across all groups, or null when it's gone (e.g. instance deleted). */
export function findOption(
  groups: AskModelGroup[],
  sel: AskModelSelection | null,
): AskModelOption | null {
  if (!sel) return null;
  for (const g of groups) {
    for (const o of g.options) {
      if (o.instanceId === sel.instanceId && o.modelId === sel.modelId) return o;
    }
  }
  return null;
}

/** The active selection: the remembered preference if it is still valid, otherwise Auto. */
export function resolveActiveModel(
  groups: AskModelGroup[],
  pref: AskModelSelection | null,
): AskModelSelection {
  return findOption(groups, pref) ? pref! : AUTO_SELECTION;
}

export function loadModelPref(): AskModelSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AskModelSelection>;
    return typeof v?.instanceId === "string" && typeof v?.modelId === "string"
      ? { instanceId: v.instanceId, modelId: v.modelId }
      : null;
  } catch {
    return null;
  }
}

export function saveModelPref(sel: AskModelSelection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(sel));
  } catch {
    /* localStorage unavailable (private mode / quota) — the pref is best-effort. */
  }
}
