/**
 * LocalWhisperLive — the on-device lane behind the
 * Transcriber seam: whisper.cpp through the boot-scoped WhisperEngine, one
 * chunk at a time, minting one stable row per chunk.
 *
 * Per chunk, in order:
 *   1. installed weights for the frozen engine.modelId (ModelManager) — none →
 *      a retryable model-missing result, retaining audio until weights are available;
 *   2. the near-silence guard on the 48 kHz samples → `[]` without
 *      touching the engine (whisper hallucinates on near-silence);
 *   3. 48 kHz → 16 kHz through a per-(recording, source) StreamingLinearResampler
 *      (continuity across chunk boundaries — the carry is 1 sample);
 *   4. the prompt: buildWhisperPrompt over the workspace
 *      VocabularySource's targets + the last words of this lane's previous
 *      chunk;
 *   5. ensureModel → transcribe (the worker pads, filters hallucinations,
 *      clamps) → applyReplacements →
 *      mintChunkSegment → `[segment]` or `[]`; usage_count bumped for hits.
 *
 * Failure mapping onto RecordingLaneFailure `{ kind: 'engine' }`: a worker
 * that could not spawn / crashed / timed out is RETRYABLE (the cursor holds,
 * the drain re-sends from the retained WAV); a decode error is NOT (that
 * chunk's text is lost, but the recording continues.
 *
 * Lane state (resampler + previous text) lives in a map keyed by
 * `${recordingId}:${source}`; entries idle for LANE_IDLE_TTL are evicted on
 * the next call (no end-of-recording signal reaches a lane), and the whole
 * map dies with the workspace scope. When the VAD weights are installed
 * (`installedPath(VAD_MODEL_ID)`), `localDecodeOptions` carries
 * `vad: true, vad_model_path` and whisper.cpp decodes only detected speech —
 * timestamps come back already mapped onto the original timeline.
 */
import { Clock, Effect, Either, HashSet, Layer, Option, Ref } from 'effect';
import { applyReplacements, targets } from '@prismical/ai-prompts/transcription';
import type { TranscriptionLanguage } from '@prismical/api-contracts/apps/v1';
import type { StreamingLinearResampler } from '../../infra/audio/streaming-linear-resampler';
import { MainLogger, type ScopedLog } from '../../infra/logging/service';
import { ProductDb } from '../../infra/product-db/service';
import type { WhisperDecodeOptions } from '../../infra/whisper/protocol';
import { WhisperEngine, type WhisperEngineError } from '../../infra/whisper/service';
import { AppModeService } from '../app-mode/service';
import { VAD_MODEL_ID } from '../models/catalogue';
import { ModelManager } from '../models/service';
import {
  WorkspaceBackend,
  type RecordingLaneResult,
  type RecordingSegment,
  type TranscribeChunkParams,
} from '../transport/service';
import { isNearSilence, makeWhisperResampler } from './audio';
import { supportsRecordingLanguage } from './engine';
import { mintChunkSegment } from './segment';
import { LocalTranscriberLane, type TranscriberLaneApi } from './service';
import { makeVocabularySource } from './vocabulary';
import { buildWhisperPrompt } from './whisper-prompt';

const EMPTY_OK: RecordingLaneResult<readonly RecordingSegment[]> = { ok: true, value: [] };

/** A lane that has not seen a chunk for this long is a finished recording. */
export const LANE_IDLE_TTL_MS = 10 * 60_000;

/**
 * Consecutive transient engine failures (timeout / crash / spawn) that open a
 * recording's circuit. Past this the worker is in a kill → multi-GB
 * model reload → kill loop this recording cannot escape (a weak CPU + a large
 * model): the lane stops engaging the worker for the recording's remaining
 * chunks and fails them retryable WITHOUT calling the engine, so the cursor
 * freezes and the drain re-covers the audio from the retained WAV. A worker
 * RESPONSE (success or a decode error) breaks that premise and resets the
 * count. Per-recording — another recording (or the drain's rows) still gets a
 * fresh worker attempt.
 */
export const ENGINE_BREAKER_THRESHOLD = 2;

/**
 * The decode options the lane sends include the recording's spoken language;
 * translation stays disabled. The
 * worker passes every key through to the addon verbatim. When the VAD
 * weights are installed the pair `vad: true, vad_model_path` is appended and
 * NOTHING else — every other `vad_*` knob keeps whisper-cli's defaults (the
 * addon defaults them; do not restate).
 */
export const localDecodeOptions = (
  initialPrompt: string | undefined,
  vadModelPath?: string,
  language: TranscriptionLanguage = 'en'
): WhisperDecodeOptions => ({
  language,
  translate: false,
  initial_prompt: initialPrompt ?? '',
  suppress_blank: true,
  suppress_non_speech_tokens: true,
  no_timestamps: false,
  ...(vadModelPath === undefined ? {} : { vad: true, vad_model_path: vadModelPath }),
});

/** WhisperEngineError → the lane result the recording lane / drain branch on. */
export const engineFailureResult = (
  error: WhisperEngineError
): RecordingLaneResult<readonly RecordingSegment[]> => {
  switch (error.reason) {
    case 'spawn-failed':
    case 'worker-crashed':
      return { ok: false, retryable: true, failure: { kind: 'engine', reason: 'worker-crashed' } };
    case 'timeout':
      return { ok: false, retryable: true, failure: { kind: 'engine', reason: 'timeout' } };
    case 'inference-failed':
      return {
        ok: false,
        retryable: false,
        failure: { kind: 'engine', reason: 'inference-failed' },
      };
  }
};

interface LaneContext {
  readonly resampler: StreamingLinearResampler;
  previousText: string;
  lastUsedAt: number;
}

export const LocalWhisperLive: Layer.Layer<
  LocalTranscriberLane,
  never,
  WhisperEngine | ModelManager | ProductDb | MainLogger | AppModeService | WorkspaceBackend
> = Layer.effect(
  LocalTranscriberLane,
  Effect.gen(function* () {
    const whisper = yield* WhisperEngine;
    const models = yield* ModelManager;
    const product = yield* ProductDb;
    const appMode = yield* AppModeService;
    const backend = yield* WorkspaceBackend;
    const log: ScopedLog = (yield* MainLogger).scoped('transcriber');
    // The mode-aware term source: in cloud mode the ProductDb is the
    // never-written cache, so terms come from the server (once per recording).
    const source = makeVocabularySource({ mode: appMode.mode, product, backend, log });
    const warnedMissing = yield* Ref.make(HashSet.empty<string>());
    // Callback-free, single-fiber-per-chunk state: every access is inside
    // Effect.sync on the calling fiber, so the Map never interleaves.
    const lanes = new Map<string, LaneContext>();
    // Per-recording breaker state; `open` holds the failure that tripped
    // it (returned verbatim for every remaining chunk — no new failure kinds).
    interface BreakerContext {
      consecutive: number;
      open: RecordingLaneResult<readonly RecordingSegment[]> | null;
      lastUsedAt: number;
    }
    const breakers = new Map<string, BreakerContext>();
    const breakerFor = (recordingId: string, now: number): BreakerContext => {
      for (const [other, context] of breakers) {
        if (other !== recordingId && now - context.lastUsedAt > LANE_IDLE_TTL_MS) {
          breakers.delete(other);
        }
      }
      let context = breakers.get(recordingId);
      if (context === undefined) {
        context = { consecutive: 0, open: null, lastUsedAt: now };
        breakers.set(recordingId, context);
      }
      context.lastUsedAt = now;
      return context;
    };

    const warnModelMissingOnce = (recordingId: string, modelId: string): Effect.Effect<void> =>
      Ref.modify(warnedMissing, seen => [
        HashSet.has(seen, recordingId),
        HashSet.add(seen, recordingId),
      ]).pipe(
        Effect.flatMap(seen =>
          seen
            ? Effect.void
            : log.warn('local whisper model not installed — audio retained for recovery', { context: {
                recordingId,
                modelId,
              } })
        )
      );

    /** This lane's context, created on first use; idle siblings evicted on the way. */
    const laneFor = (recordingId: string, source: string, now: number): LaneContext => {
      const key = `${recordingId}:${source}`;
      for (const [other, context] of lanes) {
        if (other !== key && now - context.lastUsedAt > LANE_IDLE_TTL_MS) lanes.delete(other);
      }
      let context = lanes.get(key);
      if (context === undefined) {
        context = { resampler: makeWhisperResampler(), previousText: '', lastUsedAt: now };
        lanes.set(key, context);
      }
      context.lastUsedAt = now;
      return context;
    };

    const transcribeChunk: TranscriberLaneApi['transcribeChunk'] = (
      recordingId,
      params: TranscribeChunkParams,
      audio,
      engine
    ) =>
      Effect.gen(function* () {
        if (!supportsRecordingLanguage(engine, engine.language ?? 'en')) {
          return {
            ok: false,
            retryable: true,
            failure: { kind: 'engine', reason: 'language-unsupported' },
          };
        }
        // An open circuit bypasses the engine outright — every remaining
        // chunk of this recording fails retryable so the drain re-covers it.
        const breaker = yield* Clock.currentTimeMillis.pipe(
          Effect.map(now => breakerFor(recordingId, now))
        );
        if (breaker.open !== null) return breaker.open;
        const installed = yield* models.installedPath(engine.modelId);
        if (Option.isNone(installed)) {
          yield* warnModelMissingOnce(recordingId, engine.modelId);
          return {
            ok: false,
            retryable: true,
            failure: { kind: 'engine', reason: 'model-missing' },
          };
        }
        // The VAD weights are optional: Some(path) ⇒ whisper.cpp decodes only
        // detected speech spans (no-speech chunks come back empty instead of
        // hallucinated). The ModelManager only ever hands over SHA-1-verified
        // files — that IS the SIGABRT defense: a non-Silero ggml passed as
        // `vad_model_path` aborts the worker process outright.
        const vadPath = yield* models.installedPath(VAD_MODEL_ID);
        if (isNearSilence(audio.samples)) return EMPTY_OK;

        const startedAt = yield* Clock.currentTimeMillis;
        const lane = yield* Effect.sync(() => laneFor(recordingId, params.source, startedAt));
        const audio16k = yield* Effect.sync(() => lane.resampler.process(audio.samples));
        const terms = yield* source.termsFor(recordingId);
        const prompt = buildWhisperPrompt({
          vocabulary: targets(terms),
          previousTranscription: lane.previousText,
        });

        const decoded = yield* whisper
          .ensureModel(installed.value)
          .pipe(
            Effect.zipRight(
              whisper.transcribe(
                audio16k,
                localDecodeOptions(prompt, Option.getOrUndefined(vadPath), engine.language)
              )
            ),
            Effect.either
          );
        if (Either.isLeft(decoded)) {
          yield* log.warn('local whisper chunk failed', { context: {
            recordingId,
            chunkIndex: params.chunkIndex,
            source: params.source,
            reason: decoded.left.reason,
            detail: decoded.left.detail,
          } });
          const result = engineFailureResult(decoded.left);
          if (!result.ok && result.retryable) {
            breaker.consecutive += 1;
            if (breaker.consecutive >= ENGINE_BREAKER_THRESHOLD && breaker.open === null) {
              breaker.open = result;
              yield* log.warn(
                'local whisper circuit opened — engine bypassed for the rest of this recording (audio parks for the drain)',
                { context: {
                  recordingId,
                  consecutiveFailures: breaker.consecutive,
                  reason: decoded.left.reason,
                } }
              );
            }
          } else {
            // The worker RESPONDED (a decode error) — not the wedged loop.
            breaker.consecutive = 0;
          }
          return result;
        }
        breaker.consecutive = 0;

        const replaced = applyReplacements(decoded.right.text, terms);
        const now = yield* Clock.currentTimeMillis;
        const segment = mintChunkSegment({
          recordingId,
          params,
          samples: audio.samples,
          text: replaced.text,
          now,
        });
        if (segment === null) return EMPTY_OK;
        yield* Effect.sync(() => {
          lane.previousText = segment.text;
        });
        if (replaced.hits.length > 0) {
          // Local mode records vocabulary usage; the cloud source is a no-op.
          yield* source.bumpUsage(recordingId, replaced.hits);
        }
        return { ok: true, value: [segment] } satisfies RecordingLaneResult<
          readonly RecordingSegment[]
        >;
      });

    const api: TranscriberLaneApi = { transcribeChunk };
    return api;
  })
);
