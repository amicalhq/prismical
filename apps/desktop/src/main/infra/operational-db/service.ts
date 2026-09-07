import { Context, Data, type Effect } from 'effect';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './schema';
import type { RecoveryPauseCutPoint } from './schema';

export class DbError extends Data.TaggedError('DbError')<{
  readonly op: string;
  readonly cause: unknown;
}> {}

/** A persisted recovery-outbox row, inferred from the schema. */
export type RecoveryOutboxRow = typeof schema.recoveryOutbox.$inferSelect;
export type CaptureMode = RecoveryOutboxRow['captureMode'];
export type RecoveryOutboxStatus = RecoveryOutboxRow['status'];

/**
 * Fields the RecordingService acquire supplies when it opens the outbox
 * row BEFORE the first frame. The service stamps createdAt/updatedAt and defaults
 * status → 'capturing'; attemptCount defaults to 0 and the drain cursors start null.
 */
export interface NewRecoveryOutbox {
  readonly recordingId: string;
  readonly owner: NonNullable<RecoveryOutboxRow['owner']>;
  readonly createInput: NonNullable<RecoveryOutboxRow['createInput']>;
  readonly engineConfig: NonNullable<RecoveryOutboxRow['engineConfig']>;
  readonly stagingMode?: RecoveryOutboxRow['stagingMode'];
  readonly phase?: NonNullable<RecoveryOutboxRow['phase']>;
  readonly noteId?: string | null;
  readonly captureMode: CaptureMode;
  readonly wavPath: string;
  /** The engine kind frozen at recording start; omitted/null reads as legacy 'cloud'. */
  readonly engine?: RecoveryOutboxRow['engine'];
  readonly status?: RecoveryOutboxStatus;
  readonly pauseCutPoints?: readonly RecoveryPauseCutPoint[];
}

/**
 * Mutable transition/bookkeeping patch — the finalizer and drain
 * advance status and drain state. `undefined` fields are left untouched; pass
 * `null` explicitly to clear a nullable column. updatedAt is re-stamped each call.
 */
export interface RecoveryOutboxPatch {
  readonly stagingMode?: RecoveryOutboxRow['stagingMode'];
  readonly phase?: NonNullable<RecoveryOutboxRow['phase']>;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly status?: RecoveryOutboxStatus;
  readonly attemptCount?: number;
  readonly nextAttemptAt?: string | null;
  readonly lastChunkIndex?: number | null;
  readonly pauseCutPoints?: readonly RecoveryPauseCutPoint[];
  readonly lastError?: string | null;
}

/** A persisted installed-model row, inferred from the schema. */
export type LocalModelRow = typeof schema.localModel.$inferSelect;

/**
 * What the ModelManager supplies when a download verified (or a catalogue file
 * was adopted at reconcile). The service stamps createdAt (insert) / updatedAt.
 */
export interface NewLocalModel {
  readonly modelId: string;
  readonly filename: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly downloadedAt: string;
  readonly verifiedAt: string | null;
}

export interface OperationalDbService {
  /** Drizzle handle for future domains; typed against the operational schema. */
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly getSetting: (key: string) => Effect.Effect<string | null, DbError>;
  readonly setSetting: (key: string, value: string) => Effect.Effect<void, DbError>;
  readonly deleteSetting: (key: string) => Effect.Effect<void, DbError>;
  /**
   * Delete every settings row whose key starts with `prefix`; the destructive
   * reset sweeps a whole namespace such as `eventkit:`.
   */
  readonly deleteSettingsByPrefix: (prefix: string) => Effect.Effect<void, DbError>;
  /** Open a recovery-outbox row at recording acquire. */
  readonly insertRecoveryOutbox: (row: NewRecoveryOutbox) => Effect.Effect<void, DbError>;
  /** Advance an existing row's state / drain bookkeeping. */
  readonly updateRecoveryOutbox: (
    recordingId: string,
    patch: RecoveryOutboxPatch
  ) => Effect.Effect<void, DbError>;
  /** Fetch a single row (or null). */
  readonly getRecoveryOutbox: (
    recordingId: string
  ) => Effect.Effect<RecoveryOutboxRow | null, DbError>;
  /** Every persisted (i.e. unresolved) row, oldest first — the drain's work list. */
  readonly listRecoveryOutbox: () => Effect.Effect<ReadonlyArray<RecoveryOutboxRow>, DbError>;
  /** Resolve a recording — deletes the row after success or drain resolution. */
  readonly deleteRecoveryOutbox: (recordingId: string) => Effect.Effect<void, DbError>;
  /** Every installed-model row — the ModelManager's boot read + reconcile input. */
  readonly listLocalModels: () => Effect.Effect<ReadonlyArray<LocalModelRow>, DbError>;
  /** Insert-or-replace an installed-model row (keyed by modelId). */
  readonly upsertLocalModel: (row: NewLocalModel) => Effect.Effect<void, DbError>;
  /** Forget an installed model (file deleted, or reconcile found it missing). */
  readonly deleteLocalModel: (modelId: string) => Effect.Effect<void, DbError>;
  /** Drop every installed-model row during a boot-time purge. */
  readonly deleteAllLocalModels: () => Effect.Effect<void, DbError>;
}

export class OperationalDb extends Context.Tag('desktop/OperationalDb')<
  OperationalDb,
  OperationalDbService
>() {}
