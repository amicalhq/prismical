/**
 * Operational store schema.
 *
 * Local-only device state: settings key/value (including SecureStore payloads
 * under the `secure:` key prefix) and the migration ledger. Product data never
 * lands here — it is cloud-direct by design.
 */
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
 * row as recoverable; `failed` is the deterministic give-up terminal. "Resolved"
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
 * Recovery outbox — operational crash/interrupt-recovery state only,
 * keyed to the cloud recordingId. This is NOT a product-entity replica: it holds
 * cloud id *pointers* (recordingId, noteId) plus device-local recovery bookkeeping
 * (WAV path, drain cursor/backoff) — never note bodies, titles, transcript
 * segments, or transcriptionConfig. Those are cloud-direct. A row exists so that
 * after an interrupted recording the drain can resume chunk upload from the
 * retained WAV and finalize, then delete the WAV.
 */
export const recoveryOutbox = sqliteTable('recovery_outbox', {
  /** Cloud recording id (client-minted `@prismical/id`); also the create/finalize idempotency key. */
  recordingId: text('recording_id').primaryKey(),
  /** Owning note's cloud id, or null for a note-less recording (pointer only, not a replica). */
  noteId: text('note_id'),
  /** Capture mode — tells the drain which per-source WAV(s) / `source` params apply. */
  captureMode: text('capture_mode', { enum: CAPTURE_MODES }).notNull(),
  /**
   * The transcription-engine kind the live session froze at start —
   * mirrors desktop-contracts' transcriptionEngineSchema. The drain routes the
   * row's remaining chunks / staging by THIS value, never the current
   * preference: a device-transcribed recording must never have its audio
   * uploaded because the user later switched to cloud, and a cloud recording
   * keeps its promised staging even under a non-cloud current setting.
   * NULL on a legacy row means 'cloud' (every such row was necessarily
   * produced by the cloud upload lane). Kind only — model/BYOK details resolve
   * from the current settings at drain time.
   */
  engine: text('engine', { enum: ['cloud', 'local', 'byok'] }),
  /** Recovery-scoped WAV artifact path; re-chunked by the drain, deleted on resolve. */
  wavPath: text('wav_path').notNull(),
  /** Pipeline lifecycle state. */
  status: text('status', { enum: RECOVERY_OUTBOX_STATUSES }).notNull(),
  /** Drain retry counter (backoff + deterministic give-up). */
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
