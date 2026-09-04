import { Context, Data, type Effect, type Option, type SubscriptionRef } from 'effect';
import type { ModelDownloadError, ModelsStateView } from '@prismical/desktop-contracts';
import type { DbError } from '../../infra/operational-db/service';

/**
 * The local model manager is boot-scoped device state shared by both modes:
 * downloaded Whisper and VAD weights under
 * AppConfig.modelsDir, mirrored by `local_model` rows in operational.db.
 * Boot-scoped because a multi-GB download must survive a workspace rebuild
 * (org switch / sign-out) and because the weights serve cloud mode too.
 *
 * The observable `state` IS the wire snapshot (catalogue × installed × active
 * downloads); the IPC push fiber re-parses it through the contract schema. The
 * verbs are supervised (one download fiber per model id, interrupted on cancel
 * and on scope close, always leaving no `.part` behind) and their asynchronous
 * outcomes surface through `state`, not through the returned Effect.
 */

/**
 * Every refusal/failure the manager can raise. The `ModelDownloadError` subset
 * is what a download fiber publishes into `state`; the rest are synchronous
 * refusals of `download` / `delete` (the IPC handler logs them and lets the
 * next state push tell the renderer the truth).
 */
export type ModelErrorReason =
  | ModelDownloadError
  | 'unknown-model'
  | 'already-installed'
  | 'download-in-progress'
  | 'cancelled';

export class ModelError extends Data.TaggedError('ModelError')<{
  readonly reason: ModelErrorReason;
  readonly modelId: string;
  readonly detail?: string;
}> {}

/** What the boot reconcile did (logged; asserted by tests). */
export interface ReconcileReport {
  /** Rows deleted because their file was missing, truncated, or not in the catalogue. */
  readonly removed: number;
  /** Catalogue-named files with no row that verified against the pinned SHA-1. */
  readonly adopted: number;
  /**
   * Unknown `.part` files (no catalogue filename claims them) deleted. A
   * `<catalogue filename>.part` is kept as a resumable prefix.
   */
  readonly partsDeleted: number;
}

export interface ModelManagerApi {
  /** The observable renderer-facing snapshot — the models:stateChanged push reads this. */
  readonly state: SubscriptionRef.SubscriptionRef<ModelsStateView>;
  /** The current snapshot (SubscriptionRef.get). */
  readonly list: Effect.Effect<ModelsStateView>;
  /**
   * Validate (catalogue id, not installed, not in flight, enough free space)
   * and START a supervised download; resolves once the fiber is forked.
   * Progress, verification and the terminal outcome ride `state` — and so does
   * every pre-flight refusal/failure (insufficient space, an io failure
   * preparing the models dir): each publishes an error entry BEFORE the effect
   * fails, so the fire-and-forget renderer always sees an outcome. A whisper
   * install auto-kicks the VAD entry's download when it is not installed.
   */
  readonly download: (modelId: string) => Effect.Effect<void, ModelError>;
  /**
   * Interrupt an in-flight download (its `.part` is removed) — resolves once
   * the fiber is gone. On an `error` entry it merely clears the error; on an
   * idle model it is a no-op.
   */
  readonly cancel: (modelId: string) => Effect.Effect<void>;
  /** Cancel any in-flight download, unlink the file, delete the row, republish. */
  readonly delete: (modelId: string) => Effect.Effect<void, ModelError | DbError>;
  /**
   * Disk ↔ rows reconciliation (forked at boot; tolerant of a missing dir):
   * rows without files → deleted; catalogue-named files without rows → adopted
   * only once their SHA-1 verifies; unknown `.part` files → deleted
   * (catalogue-named ones are kept for a blind cross-restart resume).
   */
  readonly reconcile: Effect.Effect<ReconcileReport, DbError>;
  /**
   * The absolute path of an installed model's weights — what LocalWhisperLive
   * feeds the worker's initializeModel(). None when not installed OR when the
   * file vanished out of band (the row is left for reconcile to clean up).
   */
  readonly installedPath: (modelId: string) => Effect.Effect<Option.Option<string>>;
}

export class ModelManager extends Context.Tag('desktop/ModelManager')<
  ModelManager,
  ModelManagerApi
>() {}
