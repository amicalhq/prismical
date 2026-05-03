import { getUserAgent } from "../../utils/http-client";
import { AVAILABLE_MODELS } from "../../constants/models";
import { logger } from "../../main/logger";
import {
  isOllamaEmbeddingModelName,
  normalizeOllamaUrl,
  normalizeOpenAICompatibleBaseURL,
} from "../../utils/provider-utils";
import {
  getModelsDevCatalog,
  modelsDevEntryToCatalog,
} from "./models-dev";
import type { CatalogEntry, ModelType } from "./types";
import type {
  ApiKeyConfig,
  LocalWhisperConfig,
  OllamaConfig,
  OpenAICompatibleConfig,
} from "../../db/schema";

// Per-provider catalog fetchers. Each one takes the instance's config
// (already type-narrowed by the dispatcher) and returns CatalogEntry[].
// HTTP/parse failures throw so the UI can surface them. Empty results are
// allowed (e.g. a fresh OpenRouter key, an empty Ollama install).

// ---------- Direct provider APIs ----------

export async function fetchOpenAICatalog(
  config: ApiKeyConfig,
): Promise<CatalogEntry[]> {
  const entries = await fetchOpenAIShape(
    "https://api.openai.com/v1/models",
    config.apiKey,
    classifyOpenAIModel,
  );
  return enrichWithModelsDev("openai", entries);
}

export async function fetchGroqCatalog(
  config: ApiKeyConfig,
): Promise<CatalogEntry[]> {
  const entries = await fetchOpenAIShape(
    "https://api.groq.com/openai/v1/models",
    config.apiKey,
    classifyGroqModel,
  );
  return enrichWithModelsDev("groq", entries);
}

export async function fetchOpenRouterCatalog(
  config: ApiKeyConfig,
): Promise<CatalogEntry[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    method: "GET",
    headers: openAIHeaders(config.apiKey),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as { data?: OpenRouterModel[] };
  const entries = (data.data ?? []).map((m): CatalogEntry => {
    const type = classifyOpenRouterModel(m);
    const entry: CatalogEntry = {
      id: m.id,
      name: m.name ?? m.id,
      type,
    };
    if (typeof m.context_length === "number") entry.context = m.context_length;
    if (typeof m.description === "string" && m.description.length > 0) {
      entry.description = m.description;
    }
    // OpenRouter returns pricing as decimal STRINGS to avoid float precision
    // ("0.00000125" per token). Always coerce.
    const promptUSD = coerceFiniteNumber(m.pricing?.prompt);
    const completionUSD = coerceFiniteNumber(m.pricing?.completion);
    if (promptUSD !== null && completionUSD !== null) {
      entry.pricing = {
        input: promptUSD * 1_000_000,
        output: completionUSD * 1_000_000,
      };
    }
    const date = unixToISODate(m.created);
    if (date) entry.releaseDate = date;
    return entry;
  });
  // OpenRouter ids are namespaced ("anthropic/claude-3-5-sonnet"); the
  // bare model id ("claude-3-5-sonnet") is what models.dev keys on, so
  // strip the namespace before the lookup. Best-effort — ids that
  // don't match are returned as-is.
  return enrichWithModelsDev("openrouter", entries, (id) => {
    const slash = id.lastIndexOf("/");
    return slash >= 0 ? id.slice(slash + 1) : id;
  });
}

export async function fetchOllamaCatalog(
  config: OllamaConfig,
): Promise<CatalogEntry[]> {
  const url = `${normalizeOllamaUrl(config.url)}/api/tags`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": getUserAgent(),
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as { models?: OllamaModel[] };
  return (data.models ?? []).map((m): CatalogEntry => {
    const type: ModelType = isOllamaEmbeddingModelName(m.name)
      ? "embedding"
      : "language";
    return {
      id: m.name,
      name: prettifyOllamaName(m.name),
      type,
      description: m.details?.family ?? undefined,
    };
  });
}

export async function fetchOpenAICompatibleCatalog(
  config: OpenAICompatibleConfig,
): Promise<CatalogEntry[]> {
  const baseURL = normalizeOpenAICompatibleBaseURL(config.baseURL);
  if (!baseURL) {
    // normalize returns "" for an empty/whitespace string. Surface a clear
    // error rather than letting `fetch("/models")` blow up with TypeError.
    throw new Error(
      "OpenAI-compatible instance is missing baseURL — set it in the instance config",
    );
  }
  const response = await fetch(`${baseURL}/models`, {
    method: "GET",
    headers: openAIHeaders(config.apiKey),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as {
    data?: OpenAICompatibleModel[];
  };
  return (data.data ?? [])
    .filter(isOpenAICompatibleChatModel)
    .map((m): CatalogEntry => {
      const entry: CatalogEntry = {
        id: m.id,
        name: m.id,
        type: "language",
      };
      const ctx =
        typeof m.context_length === "number"
          ? m.context_length
          : typeof m.context_window === "number"
            ? m.context_window
            : undefined;
      if (typeof ctx === "number") entry.context = ctx;
      if (typeof m.description === "string") entry.description = m.description;
      return entry;
    });
}

// ---------- models.dev fallback ----------

export async function fetchAnthropicCatalog(): Promise<CatalogEntry[]> {
  // Anthropic has no list-models endpoint, so we always go through models.dev.
  return fetchFromModelsDev("anthropic");
}

/**
 * Layer models.dev metadata on top of direct-API catalog entries when
 * the ids match. Specifically: friendly `name`, `releaseDate`, and a
 * `description` if one wasn't set already. Used by OpenAI/Groq/
 * OpenRouter — these endpoints return raw ids and either no `created`
 * or a `created` value that doesn't reflect the model's release date,
 * which is why sort-by-newest needs models.dev to land correctly.
 *
 * `idToLookupId` lets callers map a provider-namespaced id to the
 * bare id models.dev keys on (e.g. OpenRouter's "anthropic/claude-…"
 * → "claude-…"). Defaults to identity.
 *
 * Best-effort — if models.dev is unreachable or the provider/id isn't
 * present, returns the entries unchanged.
 */
async function enrichWithModelsDev(
  providerId: string,
  entries: CatalogEntry[],
  idToLookupId: (id: string) => string = (id) => id,
): Promise<CatalogEntry[]> {
  const data = await getModelsDevCatalog();
  const provider = data?.[providerId];
  const models = provider?.models;
  // Always run the local prettifier so cloud catalogs read decently
  // even when models.dev is unreachable. The remote layer only adds
  // value on top — replacing the prettified guess with a curated
  // name, attaching a release date, etc.
  const prettified = entries.map((entry) =>
    entry.name === entry.id
      ? { ...entry, name: prettifyCloudModelId(entry.id) }
      : entry,
  );
  if (!models) {
    logger.main.warn(
      `enrichWithModelsDev: no models.dev data for "${providerId}" (count=${entries.length})`,
    );
    return prettified;
  }
  let matched = 0;
  const out = prettified.map((entry) => {
    const lookupId = idToLookupId(entry.id);
    const md = models[lookupId];
    if (!md) return entry;
    matched++;
    const enriched: CatalogEntry = { ...entry };
    if (typeof md.name === "string" && md.name.length > 0) {
      enriched.name = md.name;
    }
    if (typeof md.release_date === "string") {
      enriched.releaseDate = md.release_date;
    }
    if (
      !enriched.description &&
      typeof md.description === "string" &&
      md.description.length > 0
    ) {
      enriched.description = md.description;
    }
    return enriched;
  });
  logger.main.info(
    `enrichWithModelsDev: provider=${providerId} matched=${matched}/${entries.length}`,
  );
  return out;
}

// Local fallback prettifier for cloud model ids when no curated name is
// available. Hand-tuned for the families we route — adds proper case
// to common prefixes ("gpt-" → "GPT-", "claude-" → "Claude ") and is a
// no-op for anything unexpected. Models.dev results override this
// when present.
function prettifyCloudModelId(id: string): string {
  const lower = id.toLowerCase();
  // Match longest-prefix-first.
  const rules: Array<[RegExp, string]> = [
    [/^chatgpt-/, "ChatGPT "],
    [/^gpt-/, "GPT-"],
    [/^claude-/, "Claude "],
    [/^text-embedding-/, "Text Embedding "],
    [/^o(\d+)([-.])?/, "o$1$2"], // o1, o3, o4 keep lowercase 'o'
  ];
  for (const [from, to] of rules) {
    if (from.test(lower)) {
      return id.replace(from, to);
    }
  }
  return id;
}

export async function fetchFromModelsDev(
  providerId: string,
): Promise<CatalogEntry[]> {
  const data = await getModelsDevCatalog();
  if (!data) {
    // Distinguish "catalog source unreachable" (throw — UI can offer retry)
    // from "provider section legitimately empty" (return [] below).
    throw new Error(
      "Could not reach models.dev — check your internet connection and try again",
    );
  }
  const provider = data[providerId];
  if (!provider?.models) return [];
  const out: CatalogEntry[] = [];
  for (const [id, m] of Object.entries(provider.models)) {
    const entry = modelsDevEntryToCatalog(id, m);
    if (entry) out.push(entry);
  }
  return out;
}

// ---------- Local-whisper / mock ----------

export async function fetchLocalWhisperCatalog(
  config: LocalWhisperConfig,
): Promise<CatalogEntry[]> {
  return (config.downloadedModels ?? []).map((m): CatalogEntry => {
    const meta = AVAILABLE_MODELS.find((am) => am.id === m.id);
    return {
      id: m.id,
      // Prefer the curated display name ("Whisper Large v3 Turbo")
      // over the raw id ("whisper-large-v3-turbo"). Falls back to id
      // for any model not in the static manifest (shouldn't happen
      // since downloads also draw from AVAILABLE_MODELS).
      name: meta?.name ?? m.id,
      type: "transcription",
    };
  });
}

const MOCK_CATALOG: readonly CatalogEntry[] = [
  { id: "mock-language-fast", name: "Mock Language (fast)", type: "language" },
  { id: "mock-language-slow", name: "Mock Language (slow)", type: "language" },
  { id: "mock-speech", name: "Mock Speech", type: "transcription" },
  { id: "mock-embedding", name: "Mock Embedding", type: "embedding" },
];

export async function fetchMockCatalog(): Promise<CatalogEntry[]> {
  return [...MOCK_CATALOG];
}

// ---------- Helpers ----------

function openAIHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": getUserAgent(),
  };
}

async function fetchOpenAIShape(
  url: string,
  apiKey: string,
  classify: (id: string) => ModelType | null,
): Promise<CatalogEntry[]> {
  const response = await fetch(url, {
    method: "GET",
    headers: openAIHeaders(apiKey),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as { data?: OpenAIShapeModel[] };
  const out: CatalogEntry[] = [];
  for (const m of data.data ?? []) {
    const type = classify(m.id);
    if (!type) continue;
    const entry: CatalogEntry = { id: m.id, name: m.id, type };
    const date = unixToISODate(m.created);
    if (date) entry.releaseDate = date;
    out.push(entry);
  }
  return out;
}

// Convert a Unix epoch (seconds) into an ISO-8601 date string. Returns
// null for missing or implausible timestamps so the caller can omit
// the field rather than store garbage.
function unixToISODate(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  if (seconds <= 0) return null;
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// OpenAI's id space is well-known. We only surface families we route — TTS,
// DALL-E, moderation, etc. are intentionally dropped (return null = drop).
// Fine-tunes use ids like "ft:gpt-4o:org::abc"; we surface them under the
// underlying capability so paying users can pick their own models.
function classifyOpenAIModel(id: string): ModelType | null {
  const lower = id.toLowerCase();
  // Match the underlying capability anywhere in the id so "ft:gpt-4o:..."
  // and "ft:whisper-large:..." surface in the right pickers.
  if (lower.includes("whisper")) return "transcription";
  if (lower.includes("text-embedding")) return "embedding";
  // "gpt-" also catches "chatgpt-*". `\bo[134]\b` matches o1/o3/o4 even
  // when prefixed (e.g. "o3-mini") since `-` is a word boundary.
  if (lower.includes("gpt-") || /\bo[134]\b/.test(lower)) return "language";
  return null;
}

// Groq hosts Llama / Mixtral / Gemma / DeepSeek / Qwen / Kimi for chat and
// Whisper for speech, plus playai-tts. Be strict — unknown families get
// dropped so a future image/tts release doesn't leak into the language picker.
function classifyGroqModel(id: string): ModelType | null {
  const lower = id.toLowerCase();
  if (lower.includes("whisper")) return "transcription";
  if (
    lower.includes("llama") ||
    lower.includes("mixtral") ||
    lower.includes("gemma") ||
    lower.includes("deepseek") ||
    lower.includes("qwen") ||
    lower.includes("mistral") ||
    lower.includes("kimi") ||
    lower.includes("gpt-oss")
  ) {
    return "language";
  }
  return null;
}

function classifyOpenRouterModel(model: OpenRouterModel): ModelType {
  const id = model.id.toLowerCase();
  if (id.includes("whisper")) return "transcription";
  if (id.includes("embed")) return "embedding";
  // OpenRouter's modality field is reliable for non-text routes; default to language.
  const modality = model.architecture?.modality;
  if (typeof modality === "string" && modality.includes("audio")) return "transcription";
  return "language";
}

// Ollama tags (e.g. "llama3.2:3b" vs "llama3.2:1b") are user-visible because
// two installs of the same family with different sizes need to be
// distinguishable in the picker. Capitalize the family but keep the tag.
function prettifyOllamaName(name: string): string {
  const [base, tag] = name.split(":");
  const pretty = base.charAt(0).toUpperCase() + base.slice(1);
  return tag ? `${pretty} (${tag})` : pretty;
}

// OpenAI-compatible servers expose every model the operator has loaded —
// often including embedding/rerank/whisper variants we don't want in the
// language picker. The operator can override by renaming, but the heuristic
// catches the common cases.
function isOpenAICompatibleChatModel(model: OpenAICompatibleModel): boolean {
  const id = model.id.toLowerCase();
  if (!id) return false;
  return !(
    id.includes("embed") ||
    id.includes("rerank") ||
    id.includes("tts") ||
    id.includes("whisper") ||
    id.includes("audio")
  );
}

/**
 * Coerce OpenRouter-style decimal-string numbers to finite numbers. Returns
 * null for values that can't be parsed cleanly so callers can decide whether
 * to omit a field or use a default.
 */
function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ---------- Provider response shapes (local types) ----------

interface OpenAIShapeModel {
  id: string;
  object?: string;
  owned_by?: string;
  // Unix epoch seconds. OpenAI / Groq / many compat servers populate this.
  created?: number;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  // Unix epoch seconds — OpenRouter exposes the model's release timestamp.
  created?: number;
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string;
  };
  pricing?: {
    // OpenRouter quotes pricing as decimal strings ("0.00000125") per token.
    // Sometimes a number sneaks through; accept both and coerce on read.
    prompt?: string | number;
    completion?: string | number;
  };
}

interface OllamaModel {
  name: string;
  model?: string;
  size?: number;
  details?: {
    parameter_size?: string;
    family?: string;
    families?: string[];
  };
}

interface OpenAICompatibleModel {
  id: string;
  object?: string;
  context_length?: number;
  context_window?: number;
  description?: string;
  [key: string]: unknown;
}
