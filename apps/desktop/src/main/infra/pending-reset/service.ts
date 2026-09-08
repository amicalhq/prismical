import { Context } from 'effect';
import { z } from 'zod';

/**
 * The boot-time purge — the second half of the destructive
 * reset / mode switch.
 *
 * Why two halves: the product stores (local.db, the cloud-cache files), the
 * downloaded whisper weights and the recovery WAVs are all held OPEN by the
 * running workspace (better-sqlite3 handles, the whisper sidecar's mmapped model, the
 * capture pipeline). Deleting them in-process is not safe — on Windows the
 * unlink fails EBUSY, on POSIX an open client keeps writing into an unlinked
 * inode — and in local mode nothing can release the workspace short of
 * quitting. So the reset handler writes ONE marker row into the operational
 * store and relaunches gracefully; the next boot reads the marker BEFORE any
 * device-state reader or product handle exists, repeats the device wipe,
 * purges, and clears the marker. Crash-safe by
 * construction: a purge that does not complete is retried on the next boot.
 */
export const PENDING_PURGE_KEY = 'app:pendingPurge';

export const pendingPurgeSchema = z
  .object({
    v: z.literal(1),
    /** Absolute paths to remove recursively; `.db` paths also drop their WAL/SHM siblings. */
    paths: z.array(z.string().min(1)),
    /** Also drop every `local_model` row (the weights under modelsDir are gone). */
    localModels: z.boolean(),
    /** Replace device data with these settings before any boot-time reader starts. */
    settings: z.record(z.string(), z.string()).optional(),
    /**
     * Boots that already tried this marker. An incomplete purge is re-armed
     * ONLY for what is still outstanding, and only MAX_PURGE_ATTEMPTS times —
     * an unbounded retry over the original path list would delete the
     * workspace the user rebuilt in the meantime at every launch.
     */
    attempts: z.number().int().min(0).default(0),
  })
  .strict();
export type PendingPurge = z.infer<typeof pendingPurgeSchema>;

/** After this many incomplete boots the marker is dropped (loudly), never retried. */
export const MAX_PURGE_ATTEMPTS = 3;

export const encodePendingPurge = (purge: Omit<PendingPurge, 'attempts'> & { attempts?: number }): string =>
  JSON.stringify({ ...purge, attempts: purge.attempts ?? 0 });

export interface PurgeReport {
  readonly removed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  readonly localModelsCleared: boolean;
}

export interface PendingResetApi {
  /** What this boot purged — null when no marker was pending. */
  readonly applied: PurgeReport | null;
}

/**
 * Built once, early in the boot layer; the layers that would open the purged
 * paths (ModelManager) depend on this tag so the ordering is explicit.
 */
export class PendingReset extends Context.Tag('desktop/PendingReset')<
  PendingReset,
  PendingResetApi
>() {}
