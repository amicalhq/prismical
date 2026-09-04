import { rmSync } from 'node:fs';
import { Effect, Layer } from 'effect';
import { MainLogger } from '../logging/service';
import { OperationalDb } from '../operational-db/service';
import {
  MAX_PURGE_ATTEMPTS,
  PENDING_PURGE_KEY,
  PendingReset,
  encodePendingPurge,
  pendingPurgeSchema,
  type PendingPurge,
  type PendingResetApi,
  type PurgeReport,
} from './service';

/** A `.db` path drags its SQLite WAL/SHM (and a rollback journal) siblings along. */
const siblingsOf = (target: string): ReadonlyArray<string> =>
  target.endsWith('.db')
    ? [target, `${target}-wal`, `${target}-shm`, `${target}-journal`]
    : [target];

const removeTree = (target: string): boolean => {
  try {
    // Retries absorb the ordinary Windows EBUSY/EPERM/ENOTEMPTY transients
    // (an indexer or AV still holding a just-unlinked file) so they do not
    // count as a failed purge.
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
};

const applyPurge = (purge: PendingPurge): Omit<PurgeReport, 'localModelsCleared'> => {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const target of purge.paths) {
    // A path is "removed" only when every sibling went; a stale `-wal` beside
    // a freshly created DB would replay the old database into the new one.
    const outcomes = siblingsOf(target).map(removeTree);
    (outcomes.every(Boolean) ? removed : failed).push(target);
  }
  return { removed, failed };
};

/**
 * PendingResetLive applies the marker written by the reset
 * handler, before any product store / model / recovery handle exists.
 * Infallible — a failure is logged. An incomplete purge is re-armed for the
 * NEXT boot with only what is still outstanding (never the original list —
 * the workspace recreated at a purged path meanwhile is the user's new data)
 * and only MAX_PURGE_ATTEMPTS times; after that the marker is dropped loudly.
 */
export const PendingResetLive: Layer.Layer<PendingReset, never, OperationalDb | MainLogger> =
  Layer.effect(
    PendingReset,
    Effect.gen(function* () {
      const db = yield* OperationalDb;
      const log = (yield* MainLogger).scoped('pending-reset');
      const none: PendingResetApi = { applied: null };

      const raw = yield* db.getSetting(PENDING_PURGE_KEY).pipe(
        Effect.catchTag('DbError', error =>
          log.error('pending purge marker unreadable — skipping', { op: error.op }).pipe(
            Effect.as(null)
          )
        )
      );
      if (raw === null) return none;

      let parsed: PendingPurge;
      try {
        parsed = pendingPurgeSchema.parse(JSON.parse(raw));
      } catch {
        // A malformed marker can never be applied; drop it so boot stays clean.
        yield* log.error('pending purge marker malformed — dropped');
        yield* db
          .deleteSetting(PENDING_PURGE_KEY)
          .pipe(Effect.catchTag('DbError', () => Effect.void));
        return none;
      }

      const outcome = applyPurge(parsed);
      const localModelsCleared = parsed.localModels
        ? yield* db.deleteAllLocalModels().pipe(
            Effect.as(true),
            Effect.catchTag('DbError', error =>
              log.error('pending purge — local_model clear failed', { op: error.op }).pipe(
                Effect.as(false)
              )
            )
          )
        : false;

      const complete = outcome.failed.length === 0 && (!parsed.localModels || localModelsCleared);
      if (complete) {
        yield* db.deleteSetting(PENDING_PURGE_KEY).pipe(
          Effect.catchTag('DbError', error =>
            log.error('pending purge — marker clear failed (will re-apply next boot)', {
              op: error.op,
            })
          )
        );
        yield* log.warn('pending purge applied', {
          removed: outcome.removed.length,
          localModels: parsed.localModels,
        });
      } else if (parsed.attempts + 1 >= MAX_PURGE_ATTEMPTS) {
        yield* db
          .deleteSetting(PENDING_PURGE_KEY)
          .pipe(Effect.catchTag('DbError', () => Effect.void));
        yield* log.error('pending purge abandoned — still incomplete after the retry budget', {
          attempts: parsed.attempts + 1,
          failed: outcome.failed,
          localModelsCleared,
        });
      } else {
        // Re-arm ONLY the outstanding work: paths that survived, and the rows
        // if they could not be cleared. Removed paths must never be re-listed.
        const remaining = encodePendingPurge({
          v: 1,
          paths: [...outcome.failed],
          localModels: parsed.localModels && !localModelsCleared,
          attempts: parsed.attempts + 1,
        });
        yield* db.setSetting(PENDING_PURGE_KEY, remaining).pipe(
          Effect.catchTag('DbError', error =>
            log.error('pending purge — marker narrow failed', { op: error.op })
          )
        );
        yield* log.error('pending purge incomplete — outstanding work re-armed for the next boot', {
          attempts: parsed.attempts + 1,
          failed: outcome.failed,
          localModelsCleared,
        });
      }

      const api: PendingResetApi = { applied: { ...outcome, localModelsCleared } };
      return api;
    })
  );
