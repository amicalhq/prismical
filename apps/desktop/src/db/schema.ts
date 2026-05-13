import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  blob,
  primaryKey,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

// Transcriptions table
export const transcriptions = sqliteTable("transcriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  language: text("language").default("en"),
  audioFile: text("audio_file"), // Path to the audio file
  confidence: real("confidence"), // AI confidence score (0-1)
  duration: integer("duration"), // Duration in seconds
  speechModel: text("speech_model"), // Model used for speech recognition
  formattingModel: text("formatting_model"), // Model used for formatting
  meta: text("meta", { mode: "json" }), // Additional metadata as JSON
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Meetings table
export const meetings = sqliteTable(
  "meetings",
  {
    id: text("id").primaryKey(),
    noteId: integer("note_id").references(() => notes.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp" }),
    durationMs: integer("duration_ms"),
    captureMode: text("capture_mode").notNull(), // "mic" | "system" | "dual"
    state: text("state").notNull(), // "recording" | "completed" | "failed" | "cancelled"
    transcriptionModel: text("transcription_model"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("meetings_note_id_started_at_idx").on(table.noteId, table.startedAt),
    index("meetings_started_at_idx").on(table.startedAt),
    index("meetings_state_idx").on(table.state),
  ],
);

// Transcript segments table
export const transcriptSegments = sqliteTable(
  "transcript_segments",
  {
    id: text("id").primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // "mic" | "system"
    speaker: text("speaker").notNull(), // "you" | "them"
    text: text("text").notNull(),
    startTimeMs: integer("start_time_ms").notNull(),
    endTimeMs: integer("end_time_ms").notNull(),
    segmentOrder: integer("segment_order").notNull().default(0),
    isFinal: integer("is_final", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("transcript_segments_meeting_id_idx").on(table.meetingId),
    index("transcript_segments_meeting_id_segment_order_idx").on(
      table.meetingId,
      table.segmentOrder,
    ),
    index("transcript_segments_start_time_ms_idx").on(table.startTimeMs),
  ],
);

// Meeting artifacts table
export const meetingArtifacts = sqliteTable(
  "meeting_artifacts",
  {
    id: text("id").primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    artifactType: text("artifact_type").notNull(), // "mic_wav" | "mic_processed_wav" | "system_wav" | "debug_json"
    path: text("path").notNull(),
    sizeBytes: integer("size_bytes"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("meeting_artifacts_meeting_id_idx").on(table.meetingId)],
);

// Vocabulary table
export const vocabulary = sqliteTable("vocabulary", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  word: text("word").notNull().unique(),
  replacementWord: text("replacement_word"),
  isReplacement: integer("is_replacement", { mode: "boolean" }).default(false),
  dateAdded: integer("date_added", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  usageCount: integer("usage_count").default(0), // How many times this word appeared in transcriptions
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// App settings table with versioned typed JSON
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey(),
  data: text("data", { mode: "json" }).$type<AppSettingsData>().notNull(),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Provider instances — one row per user-configured connection.
// Multiple rows can share a `provider` (e.g. two OpenRouter accounts).
//
// Singleton enforcement for `local-whisper` and `mock`: there is no
// schema-level partial unique index. Instead, those rows use fixed primary
// keys (`system-local-whisper`, `system-mock`) and the bootstrap step seeds
// them with `INSERT OR IGNORE`. The PK uniqueness then guarantees at most
// one row per singleton provider. tRPC create/update for these providers
// must reject user attempts to add additional ones.
export const instances = sqliteTable(
  "instances",
  {
    id: text("id").primaryKey(), // "system-local-whisper" | nanoid for user-created
    provider: text("provider").notNull(), // ProviderType: "openai" | "anthropic" | "groq" | "openrouter" | "ollama" | "openai-compatible" | "local-whisper" | "mock"
    label: text("label").notNull(), // User-facing name ("Personal OpenAI")
    config: text("config", { mode: "json" }).$type<InstanceConfig>().notNull(), // shape depends on `provider` — see InstanceConfig
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("instances_provider_idx").on(table.provider),
    // Prevent two instances of the same provider from sharing a label —
    // otherwise the model picker shows ambiguous "OpenRouter / model-x"
    // entries the user can't disambiguate.
    uniqueIndex("instances_provider_label_unique").on(
      table.provider,
      table.label,
    ),
  ],
);

// Discriminated union of per-provider config payloads stored in `instances.config`.
// The discriminator is the row's `provider` column (not a field inside the JSON),
// so the consumer must select the right branch based on the row.
export type InstanceConfig =
  | ApiKeyConfig // openai, anthropic, groq, openrouter
  | OllamaConfig // ollama
  | OpenAICompatibleConfig // openai-compatible
  | LocalWhisperConfig // local-whisper
  | MockConfig; // mock (dev only)

export interface ApiKeyConfig {
  apiKey: string;
}

export interface OllamaConfig {
  url: string;
}

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL: string;
}

export interface LocalWhisperConfig {
  downloadedModels: LocalWhisperDownloadedModel[];
}

export interface LocalWhisperDownloadedModel {
  id: string; // e.g. "whisper-large-v3-turbo"
  filename: string; // e.g. "ggml-large-v3-turbo.bin"
  sizeBytes: number;
  checksum?: string;
  downloadedAt: string; // ISO 8601
}

// Mock has no config fields, but we use an explicit shape rather than `{}` so
// the union remains a discriminated set of named types.
export type MockConfig = Record<string, never>;

// Pointer to a specific model on a specific instance.
// The model's *type* (speech / language / embedding) is implied by the
// settings slot the selection lives in (modelDefaults.transcription is
// always a speech model, etc.), so it's not encoded here.
export interface ModelSelection {
  instanceId: string;
  modelId: string;
}

// Define the shape of our settings JSON
export interface AppSettingsData {
  ui?: {
    theme: "light" | "dark" | "system";
    locale?: string;
  };
  transcription?: {
    language: string;
    autoTranscribe: boolean;
    confidenceThreshold: number;
    enablePunctuation: boolean;
    enableTimestamps: boolean;
    preloadWhisperModel?: boolean;
  };
  recording?: {
    defaultFormat: "wav" | "mp3" | "flac";
    sampleRate: 16000 | 22050 | 44100 | 48000;
    autoStopSilence: boolean;
    silenceThreshold: number;
    maxRecordingDuration: number;
    preferredMicrophoneName?: string;
  };
  meetingWidget?: {
    visibility?: "never" | "while-recording" | "always";
    normalizedY?: number;
  };
  shortcuts?: {
    pushToTalk?: number[];
    toggleRecording?: number[];
    pasteLastTranscript?: number[];
    newNote?: number[];
    openApp?: number[];
  };

  // Per-use-case default model selections. Each value points at a specific
  // model on a specific provider instance. Provider credentials/URLs live
  // in the `instances` table, not here.
  modelDefaults?: {
    transcription?: ModelSelection; // Speech-to-text (e.g. Whisper)
    formatting?: ModelSelection; // Language model used to format/summarize
    embedding?: ModelSelection; // Embedding model (used later for RAG)
  };

  dictation?: {
    autoDetectEnabled: boolean;
    selectedLanguage: string; // Concrete language used when auto-detect is disabled
  };
  preferences?: {
    launchAtLogin?: boolean;
    minimizeToTray?: boolean;
    showInDock?: boolean;
    autoTranscribeOnNewNote?: boolean;
  };
  meetingNotifications?: {
    enabled?: boolean;
    impromptuEnabled?: boolean;
    detectionDelayMs?: number;
    cooldownMs?: number;
    blockedBundleIds?: string[];
  };
  telemetry?: {
    enabled?: boolean;
  };
  auth?: {
    isAuthenticated: boolean;
    idToken: string | null;
    refreshToken: string | null;
    accessToken: string | null;
    expiresAt: number | null;
    userInfo?: {
      sub: string;
      email?: string;
      name?: string;
    };
  };
  onboarding?: {
    completedVersion: number;
    completedAt: string; // ISO 8601 timestamp
    lastVisitedScreen?: string; // Last screen user was on (for resume)
    systemAudioPermissionStatus?: "unknown" | "granted" | "required"; // Cached status for passive UI. We do not run the native tap probe on screen load because that can itself trigger the OS prompt.
    skippedScreens?: string[]; // Screens skipped via feature flags
    featureInterests?: string[]; // Selected features (max 3)
    discoverySource?: string; // How user found Prismical
    selectedModelType: "cloud" | "local"; // User's model choice
    modelRecommendation?: {
      suggested: "cloud" | "local"; // System recommendation
      reason: string; // Human-readable explanation
      followed: boolean; // Whether user followed recommendation
    };
  };
  updateChannel?: "stable" | "beta";
  featureFlags?: {
    flags?: Record<string, string | boolean>;
    payloads?: Record<string, unknown>;
    lastFetchedAt?: string; // ISO 8601
  };
  dataMigrations?: {
    notesLexical?: number;
  };
}

// Events table for calendar events linked to notes
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    calendarColor: text("calendar_color").notNull(),
    meetingUrl: text("meeting_url"),
    calendarEventUrl: text("calendar_event_url"),
    // For all-day events, startAt is UTC midnight of the day and endAt is
    // UTC midnight of the day after (Google convention — half-open interval).
    startAt: integer("start_at", { mode: "timestamp" }).notNull(),
    endAt: integer("end_at", { mode: "timestamp" }).notNull(),
    isAllDay: integer("is_all_day", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("events_start_at_idx").on(table.startAt)],
);

// Notes table
export const notes = sqliteTable(
  "notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    content: text("content").default(""), // Store the actual text content
    icon: text("icon"), // Store the icon (emoji) associated with the note
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    folderId: integer("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    eventId: text("event_id")
      .references(() => events.id) // No onDelete cascade — events outlive notes so re-linking is possible
      .unique(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("notes_folder_id_idx").on(table.folderId)],
);

export type ArtifactMode = "append-section" | "replace-doc" | "inline-rewrite";

// Artifacts table — append-only audit / eval log of every accepted skill run.
// One row per accepted run; never read back into the editor. The Yjs doc is
// canonical for content in all modes.
//
// `mode` records the editing_options used (`append-section` | `replace-doc`
// | `inline-rewrite`). `skill_id` stores the skill **slug** (not a FK to
// `skills.id`): the audit log must survive skill deletion, slug renames, and
// export/import roundtrips — none of which a UUID FK would tolerate. The
// trade-off is that nothing in the DB enforces that `skill_id` refers to an
// existing skill; that's accepted because audit rows outlive their producers
// by design.
//
// No uniqueness on (note_id, skill_id) — rows accumulate per pair (regen
// history is the audit log).
//
// `note_id` is non-null in v1; the `note_` prefix was dropped from the table
// name to leave room for standalone, non-note-scoped artifacts later.
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    mode: text("mode").notNull().$type<ArtifactMode>(),
    version: integer("version").notNull().default(1),
    // JSON-stringified Lexical *children* array (not a full editor state).
    // Reconstructable into a state JSON by wrapping in `{ root: { children: [...] } }`.
    // Audit-only snapshot at accept time; never read back into the live editor.
    content: text("content").notNull(),
    generator: text("generator").notNull(), // "ai" | "user" | "imported"
    modelId: text("model_id"),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    generatedAt: integer("generated_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("artifacts_note_id_skill_id_idx").on(table.noteId, table.skillId),
    // Partial unique index — for `append-section` mode the runtime computes
    // `version = MAX(version) + 1` per (note_id, skill_id). The single-in-flight
    // invariant from `InFlightRegistry` prevents the race in normal operation,
    // but a partial unique constraint is belt-and-suspenders against any future
    // caller that bypasses the registry (background eval re-runner, batch import,
    // etc.). `replace-doc` and `inline-rewrite` always write version=1 so they
    // would conflict here; scope the constraint to append-section only.
    uniqueIndex("artifacts_note_id_skill_id_version_append_unique")
      .on(table.noteId, table.skillId, table.version)
      .where(sql`mode = 'append-section'`),
    index("artifacts_note_id_generated_at_idx").on(
      table.noteId,
      table.generatedAt,
    ),
  ],
);

// Tags table — flat, many-to-many with notes.
// Names are lowercased on write; uniqueness is enforced by a plain UNIQUE index.
export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    isFavorite: integer("is_favorite", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("tags_name_unique").on(table.name),
    index("tags_created_at_idx").on(table.createdAt),
    index("tags_is_favorite_idx").on(table.isFavorite),
  ],
);

// Join table linking notes ⇔ tags. Composite PK + tag_id index for "notes by tag".
export const noteTags = sqliteTable(
  "note_tags",
  {
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    addedAt: integer("added_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.tagId] }),
    index("note_tags_tag_id_idx").on(table.tagId),
  ],
);

// Folders table — first-class folder entity. Notes have a single optional folder via notes.folderId.
// Names preserve user casing; uniqueness is sibling-scoped via a composite UNIQUE index on
// (LOWER(name), COALESCE(parent_id, 0)) — two folders can share a name under different parents,
// but two top-level folders or two siblings under the same parent cannot.
// parentId enables nested folders at the schema level.
export const folders = sqliteTable(
  "folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    parentId: integer("parent_id").references((): AnySQLiteColumn => folders.id, {
      onDelete: "set null",
    }),
    isFavorite: integer("is_favorite", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("folders_lower_name_parent_unique").on(
      sql`LOWER(${table.name})`,
      sql`COALESCE(${table.parentId}, 0)`,
    ),
    index("folders_created_at_idx").on(table.createdAt),
    index("folders_is_favorite_idx").on(table.isFavorite),
    index("folders_parent_id_idx").on(table.parentId),
  ],
);

// Yjs updates table for persistence
export const yjsUpdates = sqliteTable(
  "yjs_updates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    updateData: blob("update_data", { mode: "buffer" }).notNull(), // Binary data stored as Buffer
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // Index for efficient foreign key lookups
    index("yjs_updates_note_id_idx").on(table.noteId),
  ],
);

// Skills table — agentic AI enhancements applied to notes. v1 ships two
// system skills (`enhance`, `cleanup`); users can author their own.
//
// `slug` is the stable human key (survives export/import); `id` is internal.
// `body` is the agent prompt. `config` carries editing_options, surface,
// model_preference, default_skill. `allowed_tools` is null in v1 (all tools
// available); cloud-deferred fields (`created_by`, `org_id`, `public`,
// `featured`, `parent_skill_id`) are nullable and inert in v1.
export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(), // uuid v4
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    iconUrl: text("icon_url"),
    body: text("body").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<SkillMetadata>()
      .notNull()
      .default(sql`'{}'`),
    config: text("config", { mode: "json" }).$type<SkillConfig>().notNull(),
    allowedTools: text("allowed_tools", { mode: "json" }).$type<
      string[] | null
    >(),
    createdBy: text("created_by"),
    orgId: text("org_id"),
    system: integer("system", { mode: "boolean" }).notNull().default(false),
    public: integer("public", { mode: "boolean" }).notNull().default(false),
    featured: integer("featured", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    parentSkillId: text("parent_skill_id").references(
      (): AnySQLiteColumn => skills.id,
      { onDelete: "set null" },
    ),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("skills_slug_unique").on(table.slug),
    index("skills_enabled_idx").on(table.enabled),
  ],
);

export interface SkillMetadata {
  author?: string;
  tags?: string[];
  sourceUrl?: string;
}

export interface SkillConfig {
  // The skill's **default** mode. Users can pick a different mode for a
  // single run via the picker's `⋯` overflow menu (per spec §2 "Mode override
  // at pick time"); that override is held in-memory and not persisted on the
  // skill row.
  editingOptions: ArtifactMode;
  surface: SkillSurface[];
  modelPreference?: ModelSelection;
  defaultSkill?: boolean;
  /**
   * Per-skill input policy. Each flag opts the skill into having that piece
   * of context injected into the system prompt by the runner. Note markdown
   * + selection text are always injected (they're the substrate the skill
   * transforms); only optional context is gated here.
   *
   * Default if omitted: every flag is `false`. Cleanup-style skills that
   * should only see the note body must NOT set `transcript: true` — once
   * the transcript is in-context the model can't unsee it, and any
   * "don't use the transcript" instruction in the body is unenforceable.
   */
  inputs?: {
    transcript?: boolean;
  };
}

export type SkillSurface = "dock" | "inline";

// Junction: per-user skill preferences. Inert in v1 (single-user local app);
// lights up when cloud sync ships.
export const userSkillPreferences = sqliteTable(
  "user_skill_preferences",
  {
    userId: text("user_id").notNull(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [primaryKey({ columns: [table.userId, table.skillId] })],
);

// Junction: per-org skill installations. Inert in v1; cloud-only.
export const orgSkillInstallations = sqliteTable(
  "org_skill_installations",
  {
    orgId: text("org_id").notNull(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    installedAt: integer("installed_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.skillId] })],
);

// Export types for TypeScript
export type Transcription = typeof transcriptions.$inferSelect;
export type NewTranscription = typeof transcriptions.$inferInsert;
export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
export type TranscriptSegment = typeof transcriptSegments.$inferSelect;
export type NewTranscriptSegment = typeof transcriptSegments.$inferInsert;
export type MeetingArtifact = typeof meetingArtifacts.$inferSelect;
export type NewMeetingArtifact = typeof meetingArtifacts.$inferInsert;
export type Vocabulary = typeof vocabulary.$inferSelect;
export type NewVocabulary = typeof vocabulary.$inferInsert;
export type Instance = typeof instances.$inferSelect;
export type NewInstance = typeof instances.$inferInsert;
export type AppSettings = typeof appSettings.$inferSelect;
export type NewAppSettings = typeof appSettings.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type UserSkillPreference = typeof userSkillPreferences.$inferSelect;
export type NewUserSkillPreference = typeof userSkillPreferences.$inferInsert;
export type OrgSkillInstallation = typeof orgSkillInstallations.$inferSelect;
export type NewOrgSkillInstallation =
  typeof orgSkillInstallations.$inferInsert;
export type YjsUpdate = typeof yjsUpdates.$inferSelect;
export type NewYjsUpdate = typeof yjsUpdates.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type NoteTag = typeof noteTags.$inferSelect;
export type NewNoteTag = typeof noteTags.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
