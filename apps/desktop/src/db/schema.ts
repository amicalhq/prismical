import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  primaryKey,
  blob,
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

// App settings table with typed JSON
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey(),
  data: text("data", { mode: "json" }).$type<AppSettingsData>().notNull(),
  version: integer("version").notNull().default(1), // For migrations
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Unified models table for all model types (Whisper, Language, Embedding)
export const models = sqliteTable(
  "models",
  {
    // Identity
    id: text("id").notNull(),
    provider: text("provider").notNull(), // "local-whisper", "openrouter", "ollama"

    // Common fields
    name: text("name").notNull(),
    type: text("type").notNull(), // "speech", "language", "embedding"
    size: text("size"), // Model size string (e.g., "7B", "Large", "~78 MB")
    context: text("context"), // Context window (e.g., "32k", "128k")
    description: text("description"),

    // Local model fields (only for downloaded Whisper models)
    localPath: text("local_path"), // Where file is stored on disk
    sizeBytes: integer("size_bytes"), // Actual file size in bytes
    checksum: text("checksum"), // SHA-1 hash for verification
    downloadedAt: integer("downloaded_at", { mode: "timestamp" }),

    // Remote model fields (OpenRouter/Ollama)
    originalModel: text("original_model", { mode: "json" }), // Original API response

    // Model characteristics (for UI display)
    speed: real("speed"), // 1-5 rating
    accuracy: real("accuracy"), // 1-5 rating

    // Timestamps
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // Composite primary key on (provider, id)
    primaryKey({ columns: [table.provider, table.id] }),
    // Indexes for efficient lookups
    index("models_provider_idx").on(table.provider),
    index("models_type_idx").on(table.type),
  ],
);

// Define the shape of our settings JSON
export interface AppSettingsData {
  formatterConfig?: {
    enabled: boolean;
    modelId?: string; // Formatting model selection (language model ID or "prismical-cloud")
    fallbackModelId?: string; // Last non-cloud formatting model for auto-restore
  };
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
    enabled?: boolean;
    normalizedY?: number;
  };
  shortcuts?: {
    pushToTalk?: number[];
    toggleRecording?: number[];
    pasteLastTranscript?: number[];
    newNote?: number[];
  };

  modelProvidersConfig?: {
    openRouter?: {
      apiKey: string;
    };
    ollama?: {
      url: string;
    };
    openAICompatible?: {
      apiKey: string;
      baseURL: string;
    };
    defaultSpeechModel?: string; // Model ID for default speech model (Whisper)
    defaultLanguageModel?: string; // Model ID for default language model
    defaultLanguageModelSelection?: string; // Composite selection key for the default language model
    defaultEmbeddingModel?: string; // Model ID for default embedding model
  };

  dictation?: {
    autoDetectEnabled: boolean;
    selectedLanguage: string; // Concrete language used when auto-detect is disabled
  };
  preferences?: {
    launchAtLogin?: boolean;
    minimizeToTray?: boolean;
    showInDock?: boolean;
    muteSystemAudio?: boolean;
    muteDictationSounds?: boolean;
    autoDictateOnNewNote?: boolean;
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
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  calendarColor: text("calendar_color").notNull(),
  meetingUrl: text("meeting_url"),
  calendarEventUrl: text("calendar_event_url"),
  startTime: text("start_time"),
  endTime: text("end_time"),
  date: text("date"), // ISO 8601 date string
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Notes table
export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  content: text("content").default(""), // Store the actual text content
  icon: text("icon"), // Store the icon (emoji) associated with the note
  starred: integer("starred", { mode: "boolean" }).notNull().default(false),
  folder: text("folder"),
  eventId: text("event_id")
    .references(() => events.id) // No onDelete cascade — events outlive notes so re-linking is possible
    .unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

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
export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
export type AppSettings = typeof appSettings.$inferSelect;
export type NewAppSettings = typeof appSettings.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type YjsUpdate = typeof yjsUpdates.$inferSelect;
export type NewYjsUpdate = typeof yjsUpdates.$inferInsert;
