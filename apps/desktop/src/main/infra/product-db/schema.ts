/**
 * Product schema.
 *
 * ONE schema for both product stores: the local-mode `local.db` and the
 * per-(sub, org) cloud-cache databases under `cloud-cache/`. Rows carry NO
 * owner/org identity columns — the database FILE is the policy boundary
 * (local.db belongs to the local user; each cache file is keyed by
 * (sub, orgId) in its filename).
 *
 * Conventions (operational-db parity): timestamps are ISO-8601 TEXT stamped
 * in code (`new Date().toISOString()`), never SQL defaults; entity ids are
 * prefixed `@prismical/id` values (nt_…, fld_…, tag_…, rec_…, tsg_…) minted
 * by callers, preserving the cloud "id encodes its entity type" contract.
 *
 * The `note_fts` FTS5 virtual table and its sync triggers exist ONLY in the
 * hand-authored migration SQL (drizzle cannot model virtual tables) — never
 * run drizzle-kit push against a product DB, it would try to drop them.
 */
import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Migration ledger — one row per applied migration version. Written by our
 * embedded migrator (not drizzle-kit's runtime migrator, which would need a
 * migrations folder on disk inside the packaged asar; see migrations.ts).
 * Versioned independently of the operational store's ledger.
 */
export const schemaMeta = sqliteTable('schema_meta', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: text('applied_at').notNull(),
});

/** The local user's grouped preferences. One row (id 1); the database file owns the workspace. */
export const userPreference = sqliteTable('user_preference', {
  id: integer('id').primaryKey(),
  prefs: text('prefs', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
});

/**
 * A note's list/search metadata plus the derived read-model of its body.
 * The collaborative body itself lives as a Yjs update log in
 * `note_body_update`; contentMarkdown/contentText/firstLine are derived from
 * it in code (and contentText feeds the `note_fts` index via triggers).
 */
export const note = sqliteTable(
  'note',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    titleSource: text('title_source').notNull().default('manual'),
    /** Explicit naming revision only; following the first line does not bump it. */
    titleRevision: integer('title_revision').notNull().default(0),
    folderId: text('folder_id'),
    eventId: text('event_id'),
    iconUrl: text('icon_url'),
    starred: integer('starred', { mode: 'boolean' }).notNull().default(false),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    trashedAt: text('trashed_at'),
    publishedAt: text('published_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** Orders explicit metadata writes independently of updatedAt (cloud parity). */
    metadataUpdatedAt: text('metadata_updated_at').notNull(),
    deletedAt: text('deleted_at'),
    /** Derived body read-model (see note_body_update). */
    contentMarkdown: text('content_markdown'),
    contentText: text('content_text'),
    firstLine: text('first_line'),
  },
  t => [index('note_folder_id_idx').on(t.folderId)]
);

export const folder = sqliteTable('folder', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Self-referencing parent for nested folders. */
  parentId: text('parent_id'),
  iconUrl: text('icon_url'),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).notNull().default(false),
  meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const tag = sqliteTable('tag', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

/** Join table: note <-> tag (composite PK, tombstone for sync — no id column). */
export const noteTag = sqliteTable(
  'note_tag',
  {
    noteId: text('note_id').notNull(),
    tagId: text('tag_id').notNull(),
    addedAt: text('added_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  t => [primaryKey({ columns: [t.noteId, t.tagId] }), index('note_tag_tag_id_idx').on(t.tagId)]
);

/**
 * Append-only Yjs update log for a note's collaborative body (log-in-main /
 * doc-in-renderer). `seq` is a per-note monotonically increasing sequence
 * assigned by the writer; replaying updates in seq order rebuilds the doc.
 */
export const noteBodyUpdate = sqliteTable(
  'note_body_update',
  {
    noteId: text('note_id').notNull(),
    seq: integer('seq').notNull(),
    /** Raw Yjs update payload. */
    update: blob('update', { mode: 'buffer' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  t => [primaryKey({ columns: [t.noteId, t.seq] })]
);

/** Recording-pipeline capture modes (cloud parity). */
export const CAPTURE_MODES = ['mic', 'system', 'dual'] as const;

/** Recording lifecycle states (cloud parity). */
export const RECORDING_STATUSES = [
  'recording',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;

export const recording = sqliteTable(
  'recording',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    captureMode: text('capture_mode', { enum: CAPTURE_MODES }).notNull(),
    status: text('status', { enum: RECORDING_STATUSES }).notNull().default('recording'),
    /** Owning note, or null for a standalone voice note. */
    noteId: text('note_id'),
    /** Optional link to a calendar event — set when the recording is of a meeting. */
    eventId: text('event_id'),
    transcriptionConfig: text('transcription_config', { mode: 'json' }).$type<
      Record<string, unknown>
    >(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    durationMs: integer('duration_ms'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  t => [index('recording_note_id_idx').on(t.noteId)]
);

/** Which capture lane a transcript segment came from. */
export const TRANSCRIPT_SOURCES = ['mic', 'system'] as const;

/** Two-party speaker attribution (cloud parity). */
export const TRANSCRIPT_SPEAKERS = ['you', 'them'] as const;

/** One row per speaker/source boundary of a recording's transcript. */
export const transcriptSegment = sqliteTable(
  'transcript_segment',
  {
    id: text('id').primaryKey(),
    recordingId: text('recording_id').notNull(),
    source: text('source', { enum: TRANSCRIPT_SOURCES }).notNull(),
    speaker: text('speaker', { enum: TRANSCRIPT_SPEAKERS }).notNull(),
    text: text('text').notNull(),
    startTimeMs: integer('start_time_ms').notNull(),
    endTimeMs: integer('end_time_ms').notNull(),
    segmentOrder: integer('segment_order').notNull().default(0),
    isFinal: integer('is_final', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  t => [uniqueIndex('transcript_segment_recording_order_idx').on(t.recordingId, t.segmentOrder)]
);

// ── AI lanes ───────────────────────────────────────────────────────────────

/**
 * A skill row: the three system skills seeded from `@prismical/ai-prompts`
 * plus user-authored ones over the /me/skills sync lane. Mirrors core's
 * `skill` minus ownership/visibility (one user, one device) and lineage.
 */
export const skill = sqliteTable('skill', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  iconUrl: text('icon_url'),
  /** The prompt the run feeds the model. Added in migration 0001. */
  body: text('body').notNull().default(''),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /** MCP tool grants — carried for the contract; local runs are tool-less. */
  allowedTools: text('allowed_tools', { mode: 'json' }).$type<unknown>(),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

/** A skill run's output over a note (append/replace/rewrite lanes). */
export const artifact = sqliteTable(
  'artifact',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull(),
    skillId: text('skill_id').notNull(),
    /** Set when the run was scoped to one recording; null for whole-note skills. */
    recordingId: text('recording_id'),
    mode: text('mode').notNull(),
    version: integer('version').notNull().default(1),
    content: text('content').notNull(),
    /** Note body as it was immediately before this run was accepted (restore-last). */
    prevContent: text('prev_content'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  t => [index('artifact_note_id_idx').on(t.noteId)]
);

/** Completed recording suggestions survive renderer and app restarts until reviewed. */
export const noteSkillResult = sqliteTable(
  'note_skill_result',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull(),
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    acceptedResult: text('accepted_result', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  t => [index('note_skill_result_note_id_idx').on(t.noteId)]
);

/**
 * One AI title-generation run over a note (audit + undo). The columns mirror
 * core's revision CAS: apply succeeds only on `baseRevision`, undo only on
 * `appliedRevision`; `previousSource` decides whether undo restores the stored
 * title or re-derives the default. `revisions` is unused.
 */
export const noteTitleRun = sqliteTable(
  'note_title_run',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull(),
    skillId: text('skill_id').notNull().default(''),
    title: text('title').notNull(),
    previousTitle: text('previous_title').notNull(),
    previousSource: text('previous_source').notNull().default('manual'),
    baseRevision: integer('base_revision').notNull().default(0),
    appliedRevision: integer('applied_revision'),
    revisions: text('revisions', { mode: 'json' }).$type<ReadonlyArray<Record<string, unknown>>>(),
    /** The RunSkillResult the run returned (what the client saw). */
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
    appliedAt: text('applied_at'),
    undoneAt: text('undone_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  t => [index('note_title_run_note_id_idx').on(t.noteId)]
);

export const vocabulary = sqliteTable(
  'vocabulary',
  {
    id: text('id').primaryKey(),
    word: text('word').notNull(),
    replacementWord: text('replacement_word'),
    isReplacement: integer('is_replacement', { mode: 'boolean' }).notNull().default(false),
    usageCount: integer('usage_count').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  t => [uniqueIndex('vocabulary_word_idx').on(t.word)]
);

export const askConversation = sqliteTable('ask_conversation', {
  id: text('id').primaryKey(),
  /** Derived from the first user message; for a history list. */
  title: text('title'),
  messages: text('messages', { mode: 'json' })
    .$type<ReadonlyArray<Record<string, unknown>>>()
    .notNull()
    .default(sql`'[]'`),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
