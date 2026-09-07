/**
 * Workspace-owned recovery of durable recording jobs. One worker processes
 * stopped/interrupted recordings and wakes on recording state changes or the
 * next persisted retry deadline. Capture and recovery never own a job together.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { Clock, Data, Effect, Layer, Queue, Stream, SubscriptionRef } from 'effect';
import { MainLogger } from '../../infra/logging/service';
import { OperationalDb, type RecoveryOutboxRow } from '../../infra/operational-db/service';
import type { RecoveryPauseCutPoint } from '../../infra/operational-db/schema';
import type { ProductDbError } from '../../infra/product-db/service';
import { detectedSpeakerCountFor } from '../transcriber/segment';
import { Transcriber } from '../transcriber/service';
import {
  WorkspaceBackend,
  type RecordingLaneFailure,
  type StagingAbandonReason,
} from '../transport/service';
import { mirrorSegmentsToCore } from './segment-mirror';
import {
  CAPTURE_SAMPLE_RATE,
  CHUNK_SAMPLES,
  bufferSamples,
  cutAll,
  flushAll,
  initialPipeline,
  type ChunkSource,
  type PendingChunk,
} from './chunker';
import { wavFileName } from './recovery-writer';
import { readStagingLanes } from './staging-lanes';
import { RecordingService, type RecordingServiceApi, type RecordingState } from './service';
import { WorkspaceIdentity, sameWorkspace } from '../../runtime/workspace-identity';
import { RecordingStore } from './store';

/** Optional staging may be abandoned after this many attempts. Required work keeps retrying. */
export const MAX_DRAIN_ATTEMPTS = 5;

/** Exponential backoff between drain attempts (per row), capped. Clock-driven —
 * a row's `nextAttemptAt` gates it until the delay for its attempt has elapsed. */
const BACKOFF_BASE_MS = 30_000; // 30 s
const BACKOFF_CAP_MS = 30 * 60_000; // 30 min
const backoffMsFor = (attempt: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));

/** Which per-source WAV(s) a captureMode retained (mirrors `laneForFrame`). */
const sourcesForMode = (mode: RecoveryOutboxRow['captureMode']): readonly ChunkSource[] =>
  mode === 'mic' ? ['mic'] : mode === 'system' ? ['system'] : ['mic', 'system'];

const failureLabel = (failure: RecordingLaneFailure): string =>
  failure.kind === 'http'
    ? `http-${failure.status}`
    : failure.kind === 'engine'
      ? `engine-${failure.reason}`
      : failure.kind;

/**
 * Read a retained recovery WAV back into Float32 samples, or null if absent/empty.
 *
 * A hard kill skips StreamingWavWriter.finalize(),
 * so the header's data-size field stays at its placeholder 0. We therefore derive
 * the valid sample range from the ON-DISK data-section size (fileBytes - 44),
 * never the header field — this is correct for a cleanly-finalized WAV too (there
 * the two agree), so one path handles both. A truncated trailing byte (an
 * unflushed half-sample) is floored off.
 */
export const readRecoveryWav = (filePath: string): Float32Array | null => {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const dataBytes = buf.length - 44;
  if (dataBytes <= 0) return null;
  const sampleCount = Math.floor(dataBytes / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    out[i] = buf.readInt16LE(44 + i * 2) / 0x8000;
  }
  return out;
};

/**
 * Re-derive the upload chunks from the retained per-source samples by feeding
 * the shared chunker in `CHUNK_SAMPLES`-sized windows (mic before system per window):
 * each windowed `cutAll` cuts the COMPLETE fixed chunk, then a final `flushAll`
 * emits the sub-`CHUNK_SAMPLES` tail — reproducing the live run's shared monotonic
 * chunkIndex + per-source chunkStartMs EXACTLY. For identical per-source sample
 * counts this yields the same chunk sequence the live path produced (the boundary
 * invariant the server's (recordingId, chunkIndex) dedupe relies on). Persisted
 * pause cut points force the same partial-tail flushes the live path performed at
 * each pause, while preserving one monotonic chunk index across every segment.
 */
export const deriveDrainChunks = (
  mic: Float32Array | null,
  system: Float32Array | null,
  pauseCutPoints: readonly RecoveryPauseCutPoint[] = []
): readonly PendingChunk[] => {
  const micLen = mic?.length ?? 0;
  const sysLen = system?.length ?? 0;
  const chunks: PendingChunk[] = [];
  let state = initialPipeline;
  let micOff = 0;
  let sysOff = 0;

  let previous: RecoveryPauseCutPoint = { micSamples: 0, systemSamples: 0 };
  for (const point of pauseCutPoints) {
    const valid =
      Number.isSafeInteger(point.micSamples) &&
      Number.isSafeInteger(point.systemSamples) &&
      point.micSamples >= previous.micSamples &&
      point.systemSamples >= previous.systemSamples &&
      point.micSamples <= micLen &&
      point.systemSamples <= sysLen;
    if (!valid) throw new RangeError('invalid recovery pause cut point');
    previous = point;
  }

  const boundaries: readonly RecoveryPauseCutPoint[] = [
    ...pauseCutPoints,
    { micSamples: micLen, systemSamples: sysLen },
  ];
  for (const boundary of boundaries) {
    while (micOff < boundary.micSamples || sysOff < boundary.systemSamples) {
      if (mic && micOff < boundary.micSamples) {
        const end = Math.min(micOff + CHUNK_SAMPLES, boundary.micSamples);
        state = bufferSamples(state, 'mic', mic.subarray(micOff, end)).state;
        micOff = end;
      }
      if (system && sysOff < boundary.systemSamples) {
        const end = Math.min(sysOff + CHUNK_SAMPLES, boundary.systemSamples);
        state = bufferSamples(state, 'system', system.subarray(sysOff, end)).state;
        sysOff = end;
      }
      const [cut, next] = cutAll(state);
      for (const chunk of cut) chunks.push(chunk);
      state = next;
    }

    // Pause and stop both flush each source's partial tail, mic before system.
    // Continue with the returned state so indices and per-source cut offsets
    // remain monotonic across the compressed recording timeline.
    const [tail, next] = flushAll(state);
    for (const chunk of tail) chunks.push(chunk);
    state = next;
  }
  return chunks;
};

/** Per-row outcome (drives the pass summary + tests). */
export type DrainOutcome = 'resolved' | 'parked' | 'failed' | 'skipped' | 'deferred';

export interface DrainSummary {
  total: number;
  resolved: number;
  parked: number;
  failed: number;
  skipped: number;
  deferred: number;
}

class RecoveryFileError extends Data.TaggedError('RecoveryFileError')<{
  readonly cause: unknown;
}> {}

const fileOperation = <A>(run: () => A): Effect.Effect<A, RecoveryFileError> =>
  Effect.try({ try: run, catch: cause => new RecoveryFileError({ cause }) });

/** A pass is serial and only touches jobs belonging to the mounted workspace. */
export const drainRecoveries = (
  activeRecordingId: Effect.Effect<string | null>,
  resolveCompletion: RecordingServiceApi['resolveCompletion']
): Effect.Effect<
  DrainSummary,
  never,
  OperationalDb | WorkspaceBackend | RecordingStore | MainLogger | Transcriber | WorkspaceIdentity
> =>
  Effect.gen(function* () {
    const db = yield* OperationalDb;
    const backend = yield* WorkspaceBackend;
    const store = yield* RecordingStore;
    const transcriber = yield* Transcriber;
    const owner = yield* WorkspaceIdentity;
    const appMode = owner.mode;
    const log = (yield* MainLogger).scoped('recovery-drain');
    const rows = (yield* db
      .listRecoveryOutbox()
      .pipe(
        Effect.catchAll(error =>
          log
            .warn('recovery work could not be listed', { cause: String(error.cause) })
            .pipe(Effect.as([]))
        )
      )).filter(row => sameWorkspace(row.owner, owner));
    const summary: DrainSummary = {
      total: rows.length,
      resolved: 0,
      parked: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
    };
    const bestEffort = (effect: Effect.Effect<void, ProductDbError>): Effect.Effect<void> =>
      effect.pipe(
        Effect.catchAll(error =>
          log.warn('recovery cache write failed', {
            op: error.op,
            cause: String(error.cause),
          })
        )
      );
    // Local storage is authoritative. A cloud recording already has another durable copy.
    const persist = (effect: Effect.Effect<void, ProductDbError>) =>
      appMode === 'local' ? effect : bestEffort(effect);
    const park = (row: RecoveryOutboxRow, reason: string): Effect.Effect<DrainOutcome> =>
      Effect.gen(function* () {
        const attempt = row.attemptCount + 1;
        const now = yield* Clock.currentTimeMillis;
        const nextAttemptAt = new Date(now + backoffMsFor(attempt)).toISOString();
        yield* db
          .updateRecoveryOutbox(row.recordingId, {
            attemptCount: attempt,
            nextAttemptAt,
            lastError: reason,
          })
          .pipe(
            Effect.catchAll(error =>
              log.warn('recovery retry state could not be saved', {
                recordingId: row.recordingId,
                cause: String(error.cause),
              })
            )
          );
        yield* log.warn('recovery work retained for retry', {
          recordingId: row.recordingId,
          attempt,
          nextAttemptAt,
          reason,
        });
        return 'parked' as const;
      });
    const fail = (row: RecoveryOutboxRow, reason: string): Effect.Effect<DrainOutcome> =>
      db.updateRecoveryOutbox(row.recordingId, { status: 'failed', lastError: reason }).pipe(
        Effect.catchAll(error =>
          log.warn('recovery failure state could not be saved', {
            recordingId: row.recordingId,
            cause: String(error.cause),
          })
        ),
        Effect.zipRight(
          row.phase === 'staging' || row.phase === 'cleanup'
            ? Effect.void
            : resolveCompletion(row.recordingId, false)
        ),
        Effect.zipRight(
          log.warn('recovery rejected — audio retained', {
            recordingId: row.recordingId,
            reason,
          })
        ),
        Effect.as('failed')
      );

    const drainRow = (original: RecoveryOutboxRow): Effect.Effect<DrainOutcome> => {
      let row = original;
      const update = (patch: Parameters<typeof db.updateRecoveryOutbox>[1]) =>
        db.updateRecoveryOutbox(row.recordingId, patch).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              row = { ...row, ...patch };
            })
          )
        );
      const transition = (phase: NonNullable<RecoveryOutboxRow['phase']>) =>
        update({ phase, attemptCount: 0, nextAttemptAt: null, lastError: null });
      const process = Effect.gen(function* () {
        if (row.status === 'failed') {
          yield* resolveCompletion(
            row.recordingId,
            row.phase === 'staging' || row.phase === 'cleanup'
          );
          return 'skipped' as const;
        }
        if (
          row.nextAttemptAt !== null &&
          Date.parse(row.nextAttemptAt) > (yield* Clock.currentTimeMillis)
        ) {
          return 'deferred' as const;
        }
        if (row.phase === null || row.createInput === null || row.engineConfig === null) {
          return yield* fail(row, 'recovery-metadata-missing');
        }
        if (row.phase === 'cleanup') {
          yield* resolveCompletion(row.recordingId, true);
          yield* fileOperation(() => fs.rmSync(row.wavPath, { recursive: true, force: true }));
          yield* db.deleteRecoveryOutbox(row.recordingId);
          return 'resolved' as const;
        }
        const engine = row.engineConfig;
        const mirrorToCore = appMode === 'cloud' && engine.engine !== 'cloud';
        const sources = sourcesForMode(row.captureMode);
        const { mic, system, mediaDuration, lastWriteAt } = yield* fileOperation(() => {
          // Completed transcription uses its durable stop metadata. Optional
          // staging reads raw WAVs with a size cap below; do not decode them here.
          if (
            (row.phase === 'finalize' || row.phase === 'staging') &&
            row.endedAt !== null &&
            row.durationMs !== null
          ) {
            return {
              mic: null,
              system: null,
              mediaDuration: row.durationMs,
              lastWriteAt: row.endedAt,
            };
          }
          const samples = (source: ChunkSource) =>
            sources.includes(source)
              ? readRecoveryWav(path.join(row.wavPath, wavFileName[source]))
              : null;
          const mic = samples('mic');
          const system = samples('system');
          const mediaDuration = Math.round(
            (Math.max(mic?.length ?? 0, system?.length ?? 0) / CAPTURE_SAMPLE_RATE) * 1000
          );
          const lastWriteAt = Math.max(
            row.createInput!.startedAt,
            ...sources.map(source => {
              const file = path.join(row.wavPath, wavFileName[source]);
              return fs.existsSync(file) ? Math.round(fs.statSync(file).mtimeMs) : 0;
            })
          );
          return { mic, system, mediaDuration, lastWriteAt };
        });
        // Graceful stop writes exact metadata. For a crash, freeze the last media
        // write time once, so retries never move endedAt to a later session.
        if (row.endedAt === null || row.durationMs === null) {
          yield* update({
            endedAt: row.endedAt ?? lastWriteAt,
            durationMs: row.durationMs ?? mediaDuration,
          });
        }
        if (row.durationMs !== mediaDuration) {
          return yield* fail(row, 'recovery-audio-incomplete');
        }
        if (row.phase === 'create') {
          const startWrite = store.recordingStarted({
            ...row.createInput,
            id: row.recordingId,
            noteId: row.createInput.noteId ?? null,
            status: 'recording',
          });
          yield* engine.engine === 'cloud' ? bestEffort(startWrite) : startWrite;
          const created = yield* backend.createRecording(row.createInput);
          if (!created.ok)
            return yield* created.retryable
              ? park(row, `create:${failureLabel(created.failure)}`)
              : fail(row, `create:${failureLabel(created.failure)}`);
          yield* transition('chunks');
        }
        if (row.phase === 'chunks') {
          const chunks = yield* Effect.try({
            try: () => deriveDrainChunks(mic, system, row.pauseCutPoints),
            catch: () => null,
          }).pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (chunks === null) return yield* fail(row, 'pause-cut-points-invalid');
          const remaining = chunks.filter(chunk => chunk.index > (row.lastChunkIndex ?? -1));
          if (engine.engine === 'local' && remaining.length > 0) {
            const models = yield* db.listLocalModels();
            const installed = models.find(model => model.modelId === engine.modelId);
            if (installed === undefined || !fs.existsSync(installed.path))
              return yield* park(row, 'model-missing');
          }
          for (const chunk of remaining) {
            if ((yield* activeRecordingId) !== null) return 'deferred' as const;
            const res = yield* transcriber.transcribeChunk(
              row.recordingId,
              { chunkIndex: chunk.index, chunkStartMs: chunk.chunkStartMs, source: chunk.source },
              { samples: chunk.samples, sampleRate: CAPTURE_SAMPLE_RATE },
              engine
            );
            if (!res.ok)
              return yield* res.retryable
                ? park(row, `chunk-upload:${failureLabel(res.failure)}`)
                : fail(row, `chunk-upload:${failureLabel(res.failure)}`);
            if (res.value.length > 0) {
              // Locally produced text has no durable server copy yet, even in cloud mode.
              yield* engine.engine === 'cloud'
                ? bestEffort(store.segmentsReceived(res.value))
                : store.segmentsReceived(res.value);
              if (mirrorToCore) {
                const mirrored = yield* mirrorSegmentsToCore(
                  backend,
                  log,
                  row.recordingId,
                  res.value
                );
                if (!mirrored.ok)
                  return yield* mirrored.retryable
                    ? park(row, `segment-mirror:${failureLabel(mirrored.failure)}`)
                    : fail(row, `segment-mirror:${failureLabel(mirrored.failure)}`);
              }
            }
            yield* update({ lastChunkIndex: chunk.index });
          }
          yield* transition('finalize');
        }
        if (row.phase === 'finalize') {
          if (engine.engine !== 'cloud') {
            const segments = yield* store.segmentsForRecording(row.recordingId);
            yield* store.recordingMetaMerged(row.recordingId, {
              detectedSpeakerCount: detectedSpeakerCountFor(row.captureMode, segments),
            });
          }
          const finalized = yield* backend.finalizeRecording(row.recordingId, {
            endedAt: row.endedAt!,
            durationMs: row.durationMs!,
            stagingExpected: engine.engine === 'cloud' && row.stagingMode !== 'server',
            transcriptionDeferred: false,
          });
          if (!finalized.ok)
            return yield* finalized.retryable
              ? park(row, `finalize:${failureLabel(finalized.failure)}`)
              : fail(row, `finalize:${failureLabel(finalized.failure)}`);
          yield* persist(
            store.recordingCompleted(row.recordingId, {
              endedAt: row.endedAt!,
              durationMs: row.durationMs!,
            })
          );
          yield* transition('staging');
        }
        // Required transcript work is durable. Optional staging can keep retrying
        // while the owning renderer waits on the server's diarization gate.
        yield* resolveCompletion(row.recordingId, true);
        // The server spool owns finalization; no client upload or abandon is needed.
        if (row.stagingMode !== 'server') {
          const lanes =
            engine.engine === 'cloud'
              ? yield* fileOperation(() => readStagingLanes(row.wavPath, row.durationMs!))
              : [];
          const staged =
            lanes.length === 0
              ? ({ ok: true, value: { staged: false } } as const)
              : yield* backend.stageRecordingAudio(row.recordingId, lanes);
          if (
            !staged.ok &&
            staged.failure.kind === 'http' &&
            staged.failure.code === 'STAGING_FINALIZATION_INTENT_MISSING'
          ) {
            return yield* fail(row, 'staging-finalization-intent-missing');
          }
          let abandon: StagingAbandonReason | null = null;
          if (!staged.ok && staged.retryable) {
            if (row.attemptCount + 1 < MAX_DRAIN_ATTEMPTS) return yield* park(row, 'staging');
            abandon = 'upload-gave-up';
          } else if (lanes.length === 0) {
            abandon = engine.engine === 'cloud' ? 'no-audio' : 'staging-disabled';
          } else if (staged.ok && !staged.value.staged) {
            abandon = 'staging-disabled';
          } else if (!staged.ok) {
            abandon = 'upload-failed';
          }
          if (abandon) {
            const result = yield* backend.abandonRecordingStaging(row.recordingId, abandon);
            if (!result.ok) {
              const gone =
                result.failure.kind === 'http' &&
                (result.failure.status === 404 || result.failure.status === 410);
              if (!gone)
                return yield* result.retryable
                  ? park(row, `staging-abandon:${failureLabel(result.failure)}`)
                  : fail(row, `staging-abandon:${failureLabel(result.failure)}`);
            }
          }
        }
        yield* transition('cleanup');
        yield* fileOperation(() => fs.rmSync(row.wavPath, { recursive: true, force: true }));
        yield* db.deleteRecoveryOutbox(row.recordingId);
        yield* log.info('recovery resolved — WAV + outbox row deleted', {
          recordingId: row.recordingId,
        });
        return 'resolved' as const;
      });
      return process.pipe(
        Effect.catchAll(error =>
          park(
            row,
            error._tag === 'RecoveryFileError' ? 'recovery-file' : `persistence:${error.op}`
          )
        )
      );
    };

    for (const row of rows) {
      if ((yield* activeRecordingId) !== null) {
        summary.deferred += 1;
        continue;
      }
      const result = yield* drainRow(row);
      summary[result] += 1;
    }
    return summary;
  });

/** One serial, workspace-scoped worker; waits for state changes or actual retry deadlines. */
export const runRecoveryWorker = (
  state: SubscriptionRef.SubscriptionRef<RecordingState>,
  resolveCompletion: RecordingServiceApi['resolveCompletion']
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* OperationalDb;
      const owner = yield* WorkspaceIdentity;
      const wakeups = yield* Queue.sliding<void>(1);
      const activeId = SubscriptionRef.get(state).pipe(
        Effect.map(value =>
          value.status === 'idle' || value.status === 'error'
            ? null
            : (value.recordingId ?? 'starting')
        )
      );
      yield* Stream.runForEach(state.changes, value =>
        value.status === 'idle' || value.status === 'error'
          ? Queue.offer(wakeups, undefined)
          : Effect.void
      ).pipe(Effect.forkScoped);
      while (true) {
        yield* drainRecoveries(activeId, resolveCompletion);
        const rows = yield* db
          .listRecoveryOutbox()
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (rows === null) {
          yield* Queue.take(wakeups).pipe(Effect.raceFirst(Effect.sleep(BACKOFF_BASE_MS)));
          continue;
        }
        const pending = rows.filter(
          row => sameWorkspace(row.owner, owner) && row.status !== 'failed'
        );
        if ((yield* activeId) !== null || pending.length === 0) {
          yield* Queue.take(wakeups);
        } else {
          const now = yield* Clock.currentTimeMillis;
          // A bookkeeping failure can leave no deadline. Bound that retry too.
          const next = Math.min(
            ...pending.map(row =>
              row.nextAttemptAt === null || Date.parse(row.nextAttemptAt) <= now
                ? now + BACKOFF_BASE_MS
                : Date.parse(row.nextAttemptAt)
            )
          );
          yield* Queue.take(wakeups).pipe(Effect.raceFirst(Effect.sleep(Math.max(1, next - now))));
        }
      }
    })
  );

export const RecoveryDrainLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const recording = yield* RecordingService;
    yield* runRecoveryWorker(recording.state, recording.resolveCompletion).pipe(Effect.forkScoped);
  })
);
