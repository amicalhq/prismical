/**
 * RecordingStoreLive — see store.ts for the contract.
 * Workspace-scoped: built over whichever ProductDb the branch mounts and
 * provided to RecordingServiceLive + RecoveryDrainLive inside
 * sharedWorkspaceServices (workspace-layer.ts).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Effect, Layer } from 'effect';
import * as schema from '../../infra/product-db/schema';
import { ProductDb, ProductDbError } from '../../infra/product-db/service';
import type { RecordingSegment } from '../transport/service';
import { RecordingStore, type RecordingStoreApi } from './store';

/**
 * The five server-row fields main's RecordingSegment type does not declare but
 * the runtime wire objects carry (parseSegments is a cast, not a zod parse).
 * Read defensively — a server change must degrade to the defaults, never
 * poison the cache with a non-string timestamp.
 */
interface WireSegmentExtras {
  readonly isFinal?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly deletedAt?: unknown;
}

const isoOr = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

/**
 * The recording.meta merge rule folds detectedSpeakerCount as a running max:
 * a numeric patch value over a
 * numeric stored value keeps the larger; anything else shallow-overwrites.
 * Pure + exported so the rule is pinned by a unit test.
 */
export const mergeRecordingMeta = (
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const previous = current[key];
    merged[key] =
      typeof value === 'number' && typeof previous === 'number' ? Math.max(previous, value) : value;
  }
  return merged;
};

const normalizeSegment = (
  segment: RecordingSegment,
  now: string
): typeof schema.transcriptSegment.$inferInsert => {
  const extras = segment as RecordingSegment & WireSegmentExtras;
  return {
    id: segment.id,
    recordingId: segment.recordingId,
    // Cached verbatim; the enum typing is compile-time only (no CHECK in the DDL).
    source: segment.source as (typeof schema.TRANSCRIPT_SOURCES)[number],
    speaker: segment.speaker as (typeof schema.TRANSCRIPT_SPEAKERS)[number],
    text: segment.text,
    startTimeMs: segment.startTimeMs,
    endTimeMs: segment.endTimeMs,
    segmentOrder: segment.segmentOrder,
    isFinal: typeof extras.isFinal === 'boolean' ? extras.isFinal : true,
    createdAt: isoOr(extras.createdAt, now),
    updatedAt: isoOr(extras.updatedAt, now),
    deletedAt: typeof extras.deletedAt === 'string' ? extras.deletedAt : null,
  };
};

export const RecordingStoreLive: Layer.Layer<RecordingStore, never, ProductDb> = Layer.effect(
  RecordingStore,
  Effect.gen(function* () {
    const { db } = yield* ProductDb;

    const tryDb = <T>(op: string, run: () => Promise<T>): Effect.Effect<T, ProductDbError> =>
      Effect.tryPromise({ try: run, catch: cause => new ProductDbError({ op, cause }) });

    const api: RecordingStoreApi = {
      segmentsForRecording: recordingId =>
        tryDb('segments-for-recording', async () =>
          db
            .select()
            .from(schema.transcriptSegment)
            .where(
              and(
                eq(schema.transcriptSegment.recordingId, recordingId),
                isNull(schema.transcriptSegment.deletedAt)
              )
            )
        ),
      recordingStarted: fields =>
        tryDb('recording-started', async () => {
          const now = new Date().toISOString();
          const values: typeof schema.recording.$inferInsert = {
            id: fields.id,
            title: fields.title,
            captureMode: fields.captureMode,
            status: fields.status,
            noteId: fields.noteId,
            transcriptionConfig: fields.transcriptionConfig ?? null,
            startedAt: new Date(fields.startedAt).toISOString(),
            meta: fields.meta ?? null,
            createdAt: now,
            updatedAt: now,
          };
          // Upsert keyed by the client-minted id (drain re-entry safe): the
          // start fields replace, the original createdAt survives.
          await db
            .insert(schema.recording)
            .values(values)
            .onConflictDoUpdate({
              target: schema.recording.id,
              set: {
                title: values.title,
                captureMode: values.captureMode,
                status: values.status,
                noteId: values.noteId,
                transcriptionConfig: values.transcriptionConfig,
                startedAt: values.startedAt,
                meta: values.meta,
                updatedAt: now,
              },
            });
        }),

      recordingCompleted: (id, end) =>
        tryDb('recording-completed', async () => {
          await db
            .update(schema.recording)
            .set({
              status: 'completed',
              endedAt: new Date(end.endedAt).toISOString(),
              durationMs: end.durationMs,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.recording.id, id));
        }),

      recordingFailed: id =>
        tryDb('recording-failed', async () => {
          // UPDATE only — a missing row (create never persisted) is left
          // missing rather than fabricated from nothing.
          await db
            .update(schema.recording)
            .set({ status: 'failed', updatedAt: new Date().toISOString() })
            .where(eq(schema.recording.id, id));
        }),

      recordingMetaMerged: (id, patch) =>
        tryDb('recording-meta-merged', async () => {
          // Read-merge-write (no JSON operators in the SQLite dialect worth the
          // portability); the recording lane serializes its own meta writes.
          const rows = await db
            .select({ meta: schema.recording.meta })
            .from(schema.recording)
            .where(eq(schema.recording.id, id));
          const row = rows[0];
          if (row === undefined) return; // never fabricates (like recordingFailed)
          await db
            .update(schema.recording)
            .set({
              meta: mergeRecordingMeta(row.meta ?? {}, patch),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.recording.id, id));
        }),

      segmentsReceived: segments => {
        if (segments.length === 0) return Effect.void;
        return tryDb('segments-received', async () => {
          const now = new Date().toISOString();
          // ON CONFLICT (recording_id, segment_order) DO UPDATE — a chunk
          // retry (drain re-send) deletes + reinserts server-side with a NEW
          // tsg_ id, so the window is the identity and the newest row wins.
          await db
            .insert(schema.transcriptSegment)
            .values(segments.map(segment => normalizeSegment(segment, now)))
            .onConflictDoUpdate({
              target: [schema.transcriptSegment.recordingId, schema.transcriptSegment.segmentOrder],
              set: {
                id: sql`excluded.id`,
                source: sql`excluded.source`,
                speaker: sql`excluded.speaker`,
                text: sql`excluded.text`,
                startTimeMs: sql`excluded.start_time_ms`,
                endTimeMs: sql`excluded.end_time_ms`,
                isFinal: sql`excluded.is_final`,
                createdAt: sql`excluded.created_at`,
                updatedAt: sql`excluded.updated_at`,
                deletedAt: sql`excluded.deleted_at`,
              },
            });
        });
      },
    };

    return api;
  })
);
