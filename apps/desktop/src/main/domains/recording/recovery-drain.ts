/**
 * The recovery drain resolves recordings that a crash /
 * kill / logout / quit interrupted, on the NEXT signed-in session.
 *
 * The live pipeline leaves the durable trail: a recovery-outbox row (written before the first
 * frame, so even a `kill -9` leaves one) plus a per-source recovery WAV retained
 * on disk. This drain picks up where the live pipeline stopped: it re-derives the
 * upload chunks from the retained WAV using the same chunker (so chunkIndex /
 * chunkStartMs land on the same boundaries the server's (recordingId, chunkIndex)
 * idempotency key expects), re-sends only the chunks past `lastChunkIndex`
 * (idempotent — a chunk that was in flight at the crash re-sends safely), then
 * finalizes and — on full success — deletes the WAV + row with no residue.
 *
 * Runs on SignedInRuntime acquire (RecoveryDrainLive forks it into the session
 * scope), so it is interrupted by sign-out / quit; a mid-drain interrupt parks
 * progress through the same `lastChunkIndex` bookkeeping (no double-send beyond
 * idempotency). One pass per acquire: a retryable failure bumps backoff and
 * leaves the row for the NEXT session's pass; a non-retryable failure or the
 * attempt cap marks the row `failed` (deterministic give-up, WAV retained).
 *
 * The live recording owns a Semaphore(1), so the drain yields to live capture: it
 * re-reads the RecordingService's active id
 * before every row and every chunk, and the moment ANY recording is active the
 * pass defers everything left (no attempt bump, no DB write; the rows simply
 * wait for the next workspace acquire) and ends, so drain decodes never
 * interleave with a live recording's under the shared WhisperEngine
 * Semaphore(1).
 *
 * The outbox row freezes the engine kind at recording start
 * (NULL on a legacy row means 'cloud'), and every engine-dependent decision —
 * chunk routing, stagingExpected, staging the retained WAVs — follows the
 * ROW's engine, never the current preference. Only the model/BYOK details
 * resolve from the current settings; a 'local' row whose model is missing
 * PARKS ('model-missing') instead of acking empty, so audio is never dropped.
 *
 * Pure + headless-testable: no timers (Clock only, so TestClock drives backoff),
 * no device. The upload/finalize go through the guarded session
 * WorkspaceBackend; the product-store mirror is a best-effort
 * cache write; everything folds to data (E = never).
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { Clock, Effect, Layer, SubscriptionRef } from 'effect';
import { MainLogger } from '../../infra/logging/service';
import {
  OperationalDb,
  type LocalModelRow,
  type RecoveryOutboxRow,
} from '../../infra/operational-db/service';
import type { RecoveryPauseCutPoint } from '../../infra/operational-db/schema';
import type { ProductDbError } from '../../infra/product-db/service';
import { AppModeService } from '../app-mode/service';
import { SettingsService } from '../settings/service';
import { resolveRecordingEngine, type RecordingEngine } from '../transcriber/engine';
import { detectedSpeakerCountFor } from '../transcriber/segment';
import { Transcriber } from '../transcriber/service';
import {
  WorkspaceBackend,
  type RecordingLaneFailure,
  type RecordingSegment,
  type StageLaneInput,
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
import { RecordingService } from './service';
import { RecordingStore } from './store';
import { encodeWavPcm16 } from './wav';

/** Deterministic give-up: after this many failed drain attempts a row is marked
 * `failed` so a permanently-bad recording can't drain forever. */
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

/**
 * One drain pass. Lists the outbox ONCE (the work set), then resolves each
 * recoverable row sequentially. `activeRecordingId` yields the id of a
 * genuinely ACTIVE recording (or null) — re-read before every row and every chunk, and the pass
 * defers everything left the moment it is non-null. Every
 * failure folds to data so a drain fiber can never crash the session it runs in.
 */
export const drainRecoveries = (
  activeRecordingId: Effect.Effect<string | null>
): Effect.Effect<
  DrainSummary,
  never,
  | OperationalDb
  | WorkspaceBackend
  | RecordingStore
  | MainLogger
  | Transcriber
  | SettingsService
  | AppModeService
> =>
  Effect.gen(function* () {
    const db = yield* OperationalDb;
    const coreClient = yield* WorkspaceBackend;
    const store = yield* RecordingStore;
    const transcriber = yield* Transcriber;
    const settings = yield* SettingsService;
    const { mode: appMode } = yield* AppModeService;
    const log = (yield* MainLogger).scoped('recovery-drain');

    const rows = yield* db.listRecoveryOutbox().pipe(Effect.catchAll(() => Effect.succeed([])));
    const summary: DrainSummary = {
      total: rows.length,
      resolved: 0,
      parked: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
    };
    if (rows.length === 0) return summary;
    // The engine kind is per row — frozen into the outbox row at
    // recording start (NULL on a legacy row means 'cloud'). A
    // 'local'/'byok' row never routes chunks through the cloud lane and never
    // stages its WAVs; a 'cloud' row keeps its promised staging even when the
    // current setting is non-cloud. Only the model/BYOK DETAILS come from the
    // current settings (resolveRecordingEngine also re-applies the local-mode
    // coercion for a legacy 'cloud' row draining in local mode).
    const transcription = (yield* settings.get).transcription;
    const engineForRow = (row: RecoveryOutboxRow): RecordingEngine =>
      resolveRecordingEngine(appMode, { ...transcription, engine: row.engine ?? 'cloud' });
    // The drain yields to live capture. Checked before every row and
    // every chunk — a recording started mid-pass must not have its decodes
    // interleave 1:1 with drain decodes under the WhisperEngine Semaphore(1).
    const liveActive = Effect.map(activeRecordingId, id => id !== null);
    let yieldedToLive = false;
    const yieldRow = (row: RecoveryOutboxRow): Effect.Effect<DrainOutcome> =>
      Effect.gen(function* () {
        yieldedToLive = true;
        // Cheap defer: no attempt bump, no backoff, no DB write — chunk
        // progress is already persisted via lastChunkIndex, and the row simply
        // waits for the next workspace acquire's pass.
        yield* log.info('recovery drain yielded — live recording active', {
          recordingId: row.recordingId,
          reason: 'live-recording-active',
        });
        return 'deferred' as const;
      });
    yield* log.info('recovery drain started', { rows: rows.length });

    // DB writes are best-effort here — a failed bookkeeping write must not abort
    // the pass (the row simply re-drains next session).
    const update = (
      recordingId: string,
      patch: Parameters<(typeof db)['updateRecoveryOutbox']>[1]
    ): Effect.Effect<void> =>
      db.updateRecoveryOutbox(recordingId, patch).pipe(Effect.catchAll(() => Effect.void));

    // Product-store writes are best-effort here too: a failed cache
    // write never changes a drain outcome — the row/segments just miss local.
    const persist = (
      recordingId: string,
      effect: Effect.Effect<void, ProductDbError>
    ): Effect.Effect<void> =>
      effect.pipe(
        Effect.catchAll(error =>
          log.warn('recovery persistence failed', {
            recordingId,
            op: error.op,
            cause: String(error.cause),
          })
        )
      );

    // Retryable failure → bump attempt + backoff and RETAIN the row (next pass);
    // once the attempt cap is hit, give up deterministically → `failed`.
    const park = (row: RecoveryOutboxRow, reason: string): Effect.Effect<DrainOutcome> =>
      Effect.gen(function* () {
        const attempt = row.attemptCount + 1;
        if (attempt >= MAX_DRAIN_ATTEMPTS) {
          yield* update(row.recordingId, {
            status: 'failed',
            attemptCount: attempt,
            lastError: `give-up:${reason}`,
          });
          yield* log.warn('recovery gave up after max attempts — marked failed (WAV retained)', {
            recordingId: row.recordingId,
            attempt,
            reason,
          });
          return 'failed';
        }
        const now = yield* Clock.currentTimeMillis;
        const nextAttemptAt = new Date(now + backoffMsFor(attempt)).toISOString();
        yield* update(row.recordingId, { attemptCount: attempt, nextAttemptAt, lastError: reason });
        yield* log.warn('recovery retryable failure — backoff bumped, retained for next pass', {
          recordingId: row.recordingId,
          attempt,
          nextAttemptAt,
          reason,
        });
        return 'parked';
      });

    // Non-retryable failure (404/410/422/…) → deterministic give-up now. Keep the
    // WAV + row as `failed` (matches live-capture give-up: only a clean finalize
    // deletes the artifact).
    const fail = (row: RecoveryOutboxRow, reason: string): Effect.Effect<DrainOutcome> =>
      update(row.recordingId, { status: 'failed', lastError: reason }).pipe(
        Effect.zipRight(
          log.warn('recovery non-retryable failure — marked failed (WAV retained)', {
            recordingId: row.recordingId,
            reason,
          })
        ),
        Effect.as('failed')
      );

    const drainRow = (row: RecoveryOutboxRow): Effect.Effect<DrainOutcome> =>
      Effect.gen(function* () {
        if (row.status === 'failed') return 'skipped'; // terminal give-up already
        if (row.nextAttemptAt !== null) {
          const now = yield* Clock.currentTimeMillis;
          if (Date.parse(row.nextAttemptAt) > now) {
            yield* log.info('recovery drain defer: backoff not elapsed', {
              recordingId: row.recordingId,
              nextAttemptAt: row.nextAttemptAt,
            });
            return 'deferred';
          }
        }

        // Every engine-dependent decision below follows the row's engine.
        const engine = engineForRow(row);
        const mirrorToCore = appMode === 'cloud' && engine.engine !== 'cloud';
        const sources = sourcesForMode(row.captureMode);
        const mic = sources.includes('mic')
          ? readRecoveryWav(path.join(row.wavPath, wavFileName.mic))
          : null;
        const system = sources.includes('system')
          ? readRecoveryWav(path.join(row.wavPath, wavFileName.system))
          : null;
        const durationMs = Math.round(
          (Math.max(mic?.length ?? 0, system?.length ?? 0) / CAPTURE_SAMPLE_RATE) * 1000
        );

        // A row parked by the graceful-stop path with only staging left: chunks
        // were all acked and finalize landed at stop with the accurate endedAt — re-uploading /
        // re-finalizing here would overwrite endedAt with a later sign-in's wall clock.
        const stagingOnly = row.lastError !== null && row.lastError.startsWith('staging');

        if (!stagingOnly) {
          const chunks = yield* Effect.try({
            try: () => deriveDrainChunks(mic, system, row.pauseCutPoints),
            catch: () => null,
          }).pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (chunks === null) {
            return yield* fail(row, 'pause-cut-points-invalid');
          }
          const lastIndex = row.lastChunkIndex ?? -1;
          const remaining = chunks.filter(chunk => chunk.index > lastIndex);

          // A 'local' row transcribes on-device or not at all. If its
          // model is not installed the lane would ack [] and the audio would
          // be silently dropped at resolve — PARK instead (normal backoff,
          // then 'failed' keeps the WAV), so installing the model later still
          // recovers the transcript from the retained audio.
          if (engine.engine === 'local' && remaining.length > 0) {
            const models = yield* db
              .listLocalModels()
              .pipe(Effect.catchAll(() => Effect.succeed<readonly LocalModelRow[]>([])));
            const installed = models.find(model => model.modelId === engine.modelId);
            if (installed === undefined || !fs.existsSync(installed.path)) {
              return yield* park(row, 'model-missing');
            }
          }

          // Re-send the un-acked tail. Chunks are ascending + contiguous, so we stop
          // at the first failure; the cursor advances (persisted) through successes,
          // so a mid-drain interrupt resumes from here next session.
          const produced: RecordingSegment[] = [];
          for (const chunk of remaining) {
            // Yield mid-row the moment a live recording starts.
            if (yield* liveActive) return yield* yieldRow(row);
            // Through the Transcriber seam, the cloud lane WAV-encodes + uploads
            // exactly as before; an on-device lane transcribes the retained audio).
            const res = yield* transcriber.transcribeChunk(
              row.recordingId,
              { chunkIndex: chunk.index, chunkStartMs: chunk.chunkStartMs, source: chunk.source },
              { samples: chunk.samples, sampleRate: CAPTURE_SAMPLE_RATE },
              engine
            );
            if (res.ok) {
              if (res.value.length > 0) {
                // Recovered segments persist too — the live path never
                // saw these chunks, so the drain is their only writer.
                yield* persist(row.recordingId, store.segmentsReceived(res.value));
                // In cloud mode with a non-cloud engine, the server never saw this chunk either.
                if (mirrorToCore) {
                  yield* mirrorSegmentsToCore(coreClient, log, row.recordingId, res.value);
                }
                produced.push(...res.value);
              }
              yield* update(row.recordingId, { lastChunkIndex: chunk.index });
            } else if (res.retryable) {
              return yield* park(row, `chunk-upload:${failureLabel(res.failure)}`);
            } else {
              return yield* fail(row, `chunk-upload:${failureLabel(res.failure)}`);
            }
          }

          // Derive the speaker count for a non-cloud engine from this
          // pass's segments only (the live session's are already merged, and the
          // store's max-merge never lowers what it wrote).
          if (engine.engine !== 'cloud') {
            yield* persist(
              row.recordingId,
              store.recordingMetaMerged(row.recordingId, {
                detectedSpeakerCount: detectedSpeakerCountFor(row.captureMode, produced),
              })
            );
          }

          // Tail sent (or already complete) → finalize. `stagingExpected` follows the
          // engine: only the cloud engine stages for the server finalize pass.
          const endedAt = yield* Clock.currentTimeMillis;
          const finalizeRes = yield* coreClient.finalizeRecording(row.recordingId, {
            endedAt,
            durationMs,
            stagingExpected: engine.engine === 'cloud',
            transcriptionDeferred: false,
          });
          if (!finalizeRes.ok) {
            if (finalizeRes.retryable) return yield* park(row, 'finalize');
            return yield* fail(row, `finalize:${failureLabel(finalizeRes.failure)}`);
          }
          // Mark the product-store row completed with the drain's
          // endedAt (a next-session clock, a known approximation) + the
          // WAV-derived pause-compressed durationMs (best-effort).
          yield* persist(
            row.recordingId,
            store.recordingCompleted(row.recordingId, { endedAt, durationMs })
          );
        }

        // Stage the recovered session audio for the finalize pass before deleting recovery data.
        // Re-encode from the decoded samples, not the on-disk files — a crash can
        // leave WAV header sizes unpatched, and the staged artifact must be well-formed for
        // the server-side providers. Staging is BEST-EFFORT on top of a fully-transcribed
        // recording: a transient failure parks for another pass, but at the attempt cap (or on
        // a deterministic rejection) we resolve by DELETING — never strand raw session audio
        // on disk for a recording whose transcript already landed.
        // Only the cloud engine stages — a device-transcribed recording must never be
        // re-transcribed server-side, so it takes the 'staging-disabled' abandon path.
        const stageLanes: StageLaneInput[] = [];
        if (engine.engine === 'cloud' && mic?.length) {
          stageLanes.push({
            lane: 'mic',
            contentType: 'audio/wav',
            data: encodeWavPcm16(mic, CAPTURE_SAMPLE_RATE),
            durationMs,
          });
        }
        if (engine.engine === 'cloud' && system?.length) {
          stageLanes.push({
            lane: 'system',
            contentType: 'audio/wav',
            data: encodeWavPcm16(system, CAPTURE_SAMPLE_RATE),
            durationMs,
          });
        }
        const stageRes =
          stageLanes.length === 0
            ? ({ ok: true, value: { staged: false } } as const)
            : yield* coreClient.stageRecordingAudio(row.recordingId, stageLanes);
        if (
          !stageRes.ok &&
          stageRes.failure.kind === 'http' &&
          stageRes.failure.code === 'STAGING_FINALIZATION_INTENT_MISSING'
        ) {
          // A historical stop with no durable intent cannot safely be finalized now: a skill may
          // already have run in that old no-row gap. Retain the sole recovery audio for manual
          // repair instead of exhausting retries and deleting it.
          return yield* fail(row, 'staging-finalization-intent-missing');
        }
        let abandonReason: StagingAbandonReason | null = null;
        if (!stageRes.ok && stageRes.retryable) {
          if (row.attemptCount + 1 < MAX_DRAIN_ATTEMPTS) return yield* park(row, 'staging');
          yield* log.warn('staging given up at attempt cap — resolving without staged audio', {
            recordingId: row.recordingId,
          });
          abandonReason = 'upload-gave-up';
        } else if (stageLanes.length === 0) {
          abandonReason = engine.engine === 'cloud' ? 'no-audio' : 'staging-disabled';
        } else if (stageRes.ok && !stageRes.value.staged) {
          abandonReason = 'staging-disabled';
        } else if (!stageRes.ok) {
          abandonReason = 'upload-failed';
        }
        if (abandonReason) {
          const abandonRes = yield* coreClient.abandonRecordingStaging(
            row.recordingId,
            abandonReason
          );
          if (!abandonRes.ok) {
            const recordingGone =
              abandonRes.failure.kind === 'http' &&
              (abandonRes.failure.status === 404 || abandonRes.failure.status === 410);
            if (!recordingGone) {
              if (abandonRes.retryable && row.attemptCount + 1 < MAX_DRAIN_ATTEMPTS) {
                return yield* park(row, 'staging-abandon');
              }
              return yield* fail(
                row,
                `staging-abandon:${failureLabel(abandonRes.failure)}`
              );
            }
          }
        }

        // Nothing left to recover: delete the WAV directory + outbox row.
        yield* Effect.sync(() => fs.rmSync(row.wavPath, { recursive: true, force: true }));
        yield* db.deleteRecoveryOutbox(row.recordingId).pipe(Effect.catchAll(() => Effect.void));
        yield* log.info('recovery resolved — WAV + outbox row deleted', {
          recordingId: row.recordingId,
          staged: stageRes.ok && stageRes.value.staged,
        });
        return 'resolved';
      });

    for (const row of rows) {
      if (!yieldedToLive && (yield* liveActive)) {
        yieldedToLive = true;
        yield* log.info('recovery drain yielded — live recording active', {
          reason: 'live-recording-active',
        });
      }
      if (yieldedToLive) {
        // Cheap defer for everything left: no attempt bump, no DB write.
        summary.deferred += 1;
        continue;
      }
      const outcome = yield* drainRow(row);
      summary[outcome] += 1;
    }
    yield* log.info('recovery drain complete', { ...summary });
    return summary;
  });

/**
 * Session-scoped mount: fork one drain pass on SignedInRuntime acquire,
 * reading the live RecordingService's active id so the pass never touches the
 * in-flight recording. `forkScoped` ties the fiber to the session scope, so
 * sign-out / quit interrupts it mid-drain (progress parked via `lastChunkIndex`).
 * Provides no service (Layer<never>) — it exists only for its acquire effect.
 */
export const RecoveryDrainLive: Layer.Layer<
  never,
  never,
  | OperationalDb
  | WorkspaceBackend
  | RecordingStore
  | MainLogger
  | RecordingService
  | Transcriber
  | SettingsService
  | AppModeService
> = Layer.scopedDiscard(
  Effect.gen(function* () {
    const recording = yield* RecordingService;
    // Only a genuinely ACTIVE recording counts — the state deliberately
    // retains the last finished recordingId while idle, so gate on
    // status; the drain yields whenever this resolves non-null.
    const activeRecordingId = SubscriptionRef.get(recording.state).pipe(
      Effect.map(state =>
        state.status === 'idle' || state.status === 'error' ? null : state.recordingId
      )
    );
    yield* Effect.forkScoped(drainRecoveries(activeRecordingId));
  })
);
