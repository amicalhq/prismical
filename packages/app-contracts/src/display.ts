// Shared display types. Moved from web-only types so the shared renderer data
// layer (@prismical/app-client) and both the web and desktop shells speak one
// type vocabulary. Types-only + a couple of dep-free string-id constants — keeps
// app-contracts runtime-dep-free.

// `ModelType`/`ProviderType` mirror the string unions in the React provider-type
// registry, which stays in the UI layer because it carries logo components.
// Kept as explicit unions here so the
// display types below don't drag the registry's runtime into app-contracts;
// they are structurally identical to the registry's, so values assign both ways.
export type ModelType = 'transcription' | 'language' | 'embedding';
export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'openai-compatible'
  | 'local-whisper'
  | 'mock'
  | 'google-gemini'
  | 'vercel-ai-gateway'
  | 'cloudflare-workers-ai'
  | 'cerebras';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Tag = {
  id: string;
  name: string;
  color: string; // oklch or hex
  createdAt: string;
  favorite?: boolean;
};

export type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  favorite?: boolean;
};

export type CalendarEvent = {
  id: string;
  /**
   * Opaque cross-user identity of the invite (the same for every attendee's copy). Note↔event
   * links are keyed on it; absent on rows from a server that predates it.
   */
  key?: string;
  title: string;
  start: string;
  end: string;
  calendarColor: string;
  isAllDay?: boolean;
  joinUrl?: string;
  attendees?: string[];
};

/**
 * One of a note's calendar events, as THIS user sees it. Events are per-user rows, so `eventId`
 * is the user's own copy of the invite (undefined when they hold none — a collaborator's link);
 * title/times/joinUrl always render, from the user's row or from the invite as it was linked.
 */
export type NoteEventLink = {
  noteId: string;
  eventKey: string;
  eventId?: string;
  /** The event the note is principally about; at most one per note. */
  isPrimary: boolean;
  /** 'auto' = matched from the calendar when the note was created (undoable). */
  source: 'user' | 'auto' | 'api';
  title: string;
  start?: string;
  end?: string;
  joinUrl?: string;
};

export type CalendarConnection = {
  id: string;
  provider: string;
  /** Server ingestion model: OAuth pull vs a native device snapshot. */
  syncMode?: 'pull' | 'device_push';
  /** "active" | "error" (server-owned; new values may appear). */
  status: string;
  /** e.g. "token_revoked" when status is "error". */
  statusReason?: string;
  accountEmail?: string;
  deviceId?: string;
  deviceName?: string;
  lastSyncedAt?: string;
};

export type TranscriptLine = {
  id: string;
  /** Display label ("You", "Naomi", "Speaker 2") — resolved through the speaker registry. */
  speaker: string;
  /** Raw registry key ('you' | 'them' | 'dz:N') — drives avatars/colors; absent on legacy lines. */
  speakerKey?: string;
  at: string;
  text: string;
};

export type Note = {
  id: string;
  titleSource?: string;
  titleRevision?: number;
  title: string;
  emoji?: string;
  starred: boolean;
  folderId?: string;
  tagIds: string[];
  updatedAt: string;
  preview: string;
  body: string; // plain text or simple markdown for static render
  /** The user's own event row for the note's primary link (see NoteEventLink); never another user's. */
  eventId?: string;
  writable?: boolean; // false ⇒ caller has read-only access (disable the editor)
  isOwner?: boolean; // false ⇒ this note was shared with the caller ("Shared with me")
  sharedByName?: string; // the note author's name (shown on shared notes)
  transcript?: TranscriptLine[];
};

// How a skill writes its result back into the note (desktop `ArtifactMode`).
export type ArtifactMode = 'append-section' | 'replace-doc' | 'inline-rewrite';
// Where a skill is offered to run from (desktop `SkillConfig.surface`). `ask` is web-only so far:
// on that surface a skill is a saved prompt suggested in the Ask AI panel (sent to /me/ask as-is).
export type SkillSurface = 'dock' | 'inline' | 'ask' | 'title';

// For ask-surface skills (web-only): whether the saved prompt targets the note in focus or works
// across notes. Drives where it appears as an Ask AI suggestion — `single-note` only when a note is
// open, `multi-note` everywhere. Absent ⇒ treated as `multi-note`.
export type SkillAskScope = 'single-note' | 'multi-note';

export type SkillConfig = {
  outputTarget?: 'note-body' | 'note-title';
  inputs?: { transcript?: boolean };
  editingOptions: ArtifactMode;
  surface: SkillSurface[];
  defaultSkill: boolean;
  modeAgnosticPrompt: boolean;
  askScope?: SkillAskScope;
};

export type Skill = {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** The prompt body — what the model is told to do with the note. */
  body: string;
  system: boolean;
  enabled: boolean;
  config: SkillConfig;
  createdAt: string;
  updatedAt: string;
  /** MCP tool grants: `mcp:{serverId}:{tool}` | `mcp:{serverId}:*`; null/absent = none. */
  allowedTools?: string[] | null;
};

// Stable ids of the global system skills. Enhance is the recording→note action auto-enhance/the
// wand run; Cleanup is the whole-note copy-editor.
export const ENHANCE_SKILL_ID = 'skl_enhance';
export const CLEANUP_SKILL_ID = 'skl_cleanup';
export const NAME_NOTE_SKILL_ID = 'skl_name_note';

// ─── AI Models (provider instances, catalogs, defaults) ─────────────────────
// Mirrors the desktop app's data model: connected provider *instances* carry
// credentials, each instance exposes a model *catalog*, and per-use-case
// *defaults* point at one (instance, model) pair. See `src/lib/providers.tsx`
// for the static provider-type registry these rows reference.

export type UseCase = 'transcription' | 'formatting';

/** USD per 1M tokens, when known. */
export type ModelPricing = {
  input: number;
  output: number;
};

/** Normalized model metadata — one row per model in an instance's catalog. */
export type CatalogEntry = {
  id: string; // provider-native model id, e.g. "gpt-4o-mini"
  name: string; // display name; falls back to id
  type: ModelType;
  context?: number;
  pricing?: ModelPricing;
  description?: string;
  releaseDate?: string; // ISO 8601 (YYYY-MM-DD); used to sort newest-first
};

// `selectedModels` is the user-curated allowlist of model ids for an instance (set in the connect/
// edit dialog from the live catalog). The Ask model selector shows only these; empty/absent ⇒ not yet
// curated. Non-secret, so it rides the synced `instance.config` (core whitelists the key).
export type ApiKeyConfig = { apiKey: string; selectedModels?: string[] };
export type OllamaConfig = { url: string };
export type OpenAICompatibleConfig = {
  apiKey: string;
  baseURL: string;
  supportsStrictJsonSchema?: boolean;
  selectedModels?: string[];
};
export type LocalWhisperDownloadedModel = {
  id: string;
  filename: string;
  sizeBytes: number;
  downloadedAt: string; // ISO 8601
};
export type LocalWhisperConfig = {
  downloadedModels: LocalWhisperDownloadedModel[];
};
export type MockConfig = Record<string, never>;

export type InstanceConfig =
  | ApiKeyConfig
  | OllamaConfig
  | OpenAICompatibleConfig
  | LocalWhisperConfig
  | MockConfig;

/** A connected provider instance (a row the user has configured). */
export type Instance = {
  id: string;
  provider: ProviderType;
  label: string;
  config: InstanceConfig;
  /** The instance's model catalog (what the picker lists in step 2). */
  catalog: CatalogEntry[];
};

/** Pointer to a specific model on a specific instance. */
export type ModelSelection = {
  instanceId: string;
  modelId: string;
};

export type ModelDefaults = Record<UseCase, ModelSelection | null>;

/** An available Whisper model the user can download (manage dialog). */
export type AvailableWhisperModel = {
  id: string;
  name: string;
  description: string;
  filename: string;
  size: number; // approximate bytes
  sizeFormatted: string; // human readable, e.g. "~78 MB"
  speed: number; // 0–5 rating
  accuracy: number; // 0–5 rating
};

export type VocabularyEntry = {
  id: string;
  word: string;
  replacement?: string;
  addedAt: string;
  uses: number;
};

// ─── Upcoming meetings (derived from events) ────────────────────────────────────

export type UpcomingMeeting = {
  id: string;
  calendarColor: string;
  startAt: Date;
  endAt: Date;
  isAllDay: boolean;
  title: string;
  meetingUrl: string | null;
  calendarEventUrl: string | null;
};

// ─── Sidebar favorite union ─────────────────────────────────────────────────────

export type FavoriteEntry =
  | { kind: 'note'; createdAt: Date; note: Note }
  | { kind: 'tag'; createdAt: Date; tag: Tag }
  | { kind: 'folder'; createdAt: Date; folder: Folder };
