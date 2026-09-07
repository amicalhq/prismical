/**
 * Operational store schema.
 *
 * Device configuration, migration bookkeeping, and durable recording work.
 * Product entities live in their workspace's product store; recovery jobs retain
 * the create intent needed to finish an interrupted recording.
 */
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { CreateRecordingInput } from '../../domains/transport/service';
import type { RecordingEngine } from '../../domains/transcriber/engine';
import type { RecoveryOwner } from '../../runtime/workspace-identity';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Migration ledger — one row per applied migration version. Written by our
 * embedded migrator (not drizzle-kit's runtime migrator, which would need a
 * migrations folder on disk inside the packaged asar; see migrations.ts).
 */
export const schemaMeta = sqliteTable('schema_meta', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: text('applied_at').notNull(),
});

/** Recording-pipeline capture modes (mirror the cloud create body's `captureMode`). */
export const CAPTURE_MODES = ['mic', 'system', 'dual'] as const;

/**
 * Recovery-outbox lifecycle. Written `capturing` at acquire (before the
 * first frame), so a `kill -9` always leaves a durable row. Graceful stop walks
 * capturing → finalizing → (row DELETED on success). A graceful interrupt
 * (sign-out / quit) parks the row `interrupted`. The drain treats any non-`failed`
 * row as recoverable; `failed` is reserved for deterministic processing rejection. "Resolved"
 * is not a stored state — a resolved recording's row is deleted (no residue).
 */
export const RECOVERY_OUTBOX_STATUSES = [
  'capturing',
  'finalizing',
  'interrupted',
  'failed',
] as const;

/**
 * A pause boundary in the pause-compressed recovery WAVs. The live recorder
 * flushes its partial upload tail at every boundary; persisting both source
 * offsets lets the next-session drain reproduce the exact same shared chunk
 * indices after a crash.
 */
export interface RecoveryPauseCutPoint {
  readonly micSamples: number;
  readonly systemSamples: number;
}

/**
 * Durable, workspace-owned recording work. The create intent and stop metadata
 * let recovery replay unfinished operations without inventing a different
 * recording. Audio lives in per-source WAV files until all required work is
 * durable. Existing jobs without an owner remain untouched.
 */
export const recoveryOutbox = sqliteTable('recovery_outbox', {
  /** Cloud recording id (client-minted `@prismical/id`); also the create/finalize idempotency key. */
  recordingId: text('recording_id').primaryKey(),
  /** Null on pre-ownership jobs: keep them untouched until their owner is known. */
  owner: text('owner', { mode: 'json' }).$type<RecoveryOwner>(),
  /** Replayable create intent, written before capture can acquire a device. */
  createInput: text('create_input', { mode: 'json' }).$type<CreateRecordingInput>(),
  /** Private frozen engine choices; no credentials, and never sent as cloud metadata. */
  engineConfig: text('engine_config', { mode: 'json' }).$type<RecordingEngine>(),
  /** Next unfinished processing operation; independent of capture status and diagnostics. */
  phase: text('phase', { enum: ['create', 'chunks', 'finalize', 'cleanup'] }),
  /** Fixed at stop, or inferred once from retained media after an abrupt interruption. */
  endedAt: integer('ended_at'),
  durationMs: integer('duration_ms'),
  /** Owning note's cloud id, or null for a note-less recording (pointer only, not a replica). */
  noteId: text('note_id'),
  /** Capture mode — tells the drain which per-source WAV(s) / `source` params apply. */
  captureMode: text('capture_mode', { enum: CAPTURE_MODES }).notNull(),
  /** Historical engine kind retained for diagnostics; engineConfig owns processing choices. */
  engine: text('engine', { enum: ['cloud', 'local', 'byok'] }),
  /** Recovery-scoped WAV artifact path; re-chunked by the drain, deleted on resolve. */
  wavPath: text('wav_path').notNull(),
  /** Pipeline lifecycle state. */
  status: text('status', { enum: RECOVERY_OUTBOX_STATUSES }).notNull(),
  /** Attempt count for the current processing phase. */
  attemptCount: integer('attempt_count').notNull().default(0),
  /** Earliest next drain attempt (ISO); null = eligible now. Clock/Schedule-driven. */
  nextAttemptAt: text('next_attempt_at'),
  /** Highest chunkIndex already uploaded (resumable-upload cursor); null = none yet. */
  lastChunkIndex: integer('last_chunk_index'),
  /** Per-source accepted-sample offsets where pause flushed a partial upload tail. */
  pauseCutPoints: text('pause_cut_points', { mode: 'json' })
    .$type<readonly RecoveryPauseCutPoint[]>()
    .notNull()
    .default(sql`'[]'`),
  /** Last failure reason (why parked/failed) — operational diagnostics only. */
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Installed local ASR model weights — device state, identity-
 * and mode-free (a downloaded ggml file serves cloud and local mode alike), so
 * it lives here rather than in a product store that a mode switch or a cache
 * rebuild would drop. One row per catalogue model actually present on disk;
 * the file itself sits under AppConfig.modelsDir. The ModelManager reconciles
 * rows ↔ files at boot (row without file → deleted; catalogue file without row
 * → adopted only once its SHA-1 verifies).
 */
export const localModel = sqliteTable('local_model', {
  /** Catalogue id (`whisper-base-en`, …). */
  modelId: text('model_id').primaryKey(),
  /** Catalogue filename (`ggml-base.en.bin`). */
  filename: text('filename').notNull(),
  /** Absolute path of the installed weights file. */
  path: text('path').notNull(),
  /** Actual on-disk size after the verified download. */
  sizeBytes: integer('size_bytes').notNull(),
  /** SHA-1 hex of the installed file (matched the catalogue pin at install). */
  checksum: text('checksum').notNull(),
  /** ISO time the download completed (or the file was adopted). */
  downloadedAt: text('downloaded_at').notNull(),
  /** ISO time the SHA-1 last verified; null only for a legacy/unverified row. */
  verifiedAt: text('verified_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
