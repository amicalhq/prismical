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

// Note artifacts table — generated / synthesized content attached to a note
// (AI summaries, action items, etc.). `notes.content` stays as the user's raw
// input; artifacts are produced outputs.
export const noteArtifacts = sqliteTable(
  "note_artifacts",
  {
    id: text("id").primaryKey(),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("summary"),
    content: text("content").notNull(), // Lexical editor state JSON
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
    index("note_artifacts_note_id_kind_idx").on(table.noteId, table.kind),
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
// Names preserve user casing; uniqueness is case-insensitive via a UNIQUE index on LOWER(name).
export const folders = sqliteTable(
  "folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
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
    uniqueIndex("folders_lower_name_unique").on(sql`LOWER(${table.name})`),
    index("folders_created_at_idx").on(table.createdAt),
    index("folders_is_favorite_idx").on(table.isFavorite),
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
export type NoteArtifact = typeof noteArtifacts.$inferSelect;
export type NewNoteArtifact = typeof noteArtifacts.$inferInsert;
export type YjsUpdate = typeof yjsUpdates.$inferSelect;
export type NewYjsUpdate = typeof yjsUpdates.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type NoteTag = typeof noteTags.$inferSelect;
export type NewNoteTag = typeof noteTags.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
