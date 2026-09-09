/**
 * RecordingServiceLive — the session-scoped supervisor.
 *
 * Wires capture → recovery WAV (recovery-writer) → chunk upload lane →
 * recovery outbox. One `FiberMap<recordingId>` + a `Semaphore(1)` (one active
 * recording). Every timer uses Clock/Schedule, not raw timers, so TestClock
 * drives restart backoff and auto-pause. Chunk boundaries follow audio samples.
 * The session scope interrupts the native child on sign-out / org-switch / quit,
 * parks the outbox `interrupted`, and retains the WAV for the next session's drain.
 *
 * Normal Stop closes capture and its WAV, then drains in-flight chunks while
 * another capture may start. Durable retries go to the workspace worker. Exhausted capture
 * restarts use the same path for audio already captured. Workspace interruption
 * parks the job and closes the WAV; only its original workspace may recover it.
 */
import path from 'node:path';
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Stream,
  SubscriptionRef,
} from 'effect';
import { createId } from '@prismical/id';
import { PendingSkillResultsSchema } from '@prismical/api-contracts/apps/v1';
import {
  AUTO_PAUSE_DEFAULTS,
  AutoPauseMachine,
  SilenceWatcher,
  combinedSilentSeconds,
  type AutoPauseEffect,
} from '@prismical/silence';
import type { AudioFrame, MeetingCaptureMode } from '@/types/meeting';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import { MicActivity } from '../../infra/mic-detector/service';
import { OperationalDb } from '../../infra/operational-db/service';
import type { RecoveryPauseCutPoint } from '../../infra/operational-db/schema';
import type { ProductDbError } from '../../infra/product-db/service';
import { RecordingBridge } from './bridge';
import { WorkspaceIdentity } from '../../runtime/workspace-identity';
import { ModelManager } from '../models/service';
import {
  Capture,
  type CaptureError,
  type MicBindingCommand,
  type MicCaptureEvent,
} from './capture/service';
import { PermissionService } from './permission/service';
import {
  WorkspaceBackend,
  type CreateRecordingInput,
  type RecordingLaneFailure,
} from '../transport/service';
import { isSessionTranscriptionFailure, recordingRetryAfterMs } from '../transport/recording-retry';
import { RecordingStore } from './store';
import { AppModeService } from '../app-mode/service';
import { DesktopI18n } from '../i18n/service';
import { SettingsService } from '../settings/service';
import { resolveRecordingEngine, type RecordingEngine } from '../transcriber/engine';
import { resolveTranscriptionConfig } from '../transcriber/transcription-config';
import { detectedSpeakerCountFor } from '../transcriber/segment';
import { Transcriber } from '../transcriber/service';
import { mirrorSegmentsToCore } from './segment-mirror';
import {
  CAPTURE_SAMPLE_RATE,
  bufferSamples,
  cutAll,
  cutPaired,
  flushAll,
  initialPipeline,
  laneForFrame,
  type PendingChunk,
} from './chunker';
import { makeRecoveryWavSet, type RecoveryWriteError } from './recovery-writer';
import {
  RecordingBusyError,
  RecordingStartError,
  RecordingService,
  idleRecordingState,
  type RecordingServiceApi,
  type RecordingState,
  type StartRecordingInput,
} from './service';
import {
  initialMicAlignmentState,
  reduceMicAlignment,
  sameDesiredBinding,
  type DesiredMicBinding,
  type MicAlignmentEvent,
  type MicAlignmentState,
  type MicSource,
} from './mic-alignment';

// Recovery WAVs live under `<config.recoveryDir>/<recordingId>/`; the directory
// is resolved by AppConfig so the destructive reset purges the
// same tree.

/** Three detector poll periods; older replayed context is not used for MIC-001. */
const MIC_ACTIVITY_FRESH_MS = 3_000;

/** Auto-pause never fires in the opening seconds of a session — matches web. */
const MIN_SESSION_SECONDS_BEFORE_AUTO_PAUSE = 30;
/** Auto-stop poll while paused: no frames flow, so the audio clock is frozen. */
const AUTO_STOP_POLL = Duration.seconds(5);

type MicTransitionTrigger = 'app-select' | 'app-start' | 'default-change' | 'device-lost';
type InitialMicFallbackReason = 'missing' | 'unidentified' | null;

interface PendingMicTransition {
  readonly from: MicSource;
  readonly trigger: Extract<MicTransitionTrigger, 'app-select' | 'app-start'>;
  readonly detectMs: number;
}

/** Bounded, signed-in-only restart: exponential 1 s→cap 10 s, up to N attempts,
 * then the recording ends instead of retrying forever at a fixed interval. */
const MAX_CAPTURE_RESTARTS = 5;
const RESTART_SCHEDULE = Schedule.intersect(
  Schedule.either(
    Schedule.exponential(Duration.seconds(1), 2),
    Schedule.spaced(Duration.seconds(10))
  ),
  Schedule.recurs(MAX_CAPTURE_RESTARTS)
);

interface ActiveRecording {
  readonly recordingId: string;
  readonly stopSignal: Deferred.Deferred<void>;
  readonly done: Deferred.Deferred<void>;
  readonly controls: Ref.Ref<Option.Option<RecordingControls>>;
  readonly stopping: Ref.Ref<boolean>;
  readonly synchronize: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

interface RecordingControls {
  readonly pause: Effect.Effect<boolean>;
  readonly resume: Effect.Effect<boolean>;
  /** "Keep recording" on the auto-pause prompt. */
  readonly keepRecording: Effect.Effect<boolean>;
  readonly pauseFromPrompt: Effect.Effect<boolean>;
}

interface AcceptedSamples {
  readonly micSamples: number;
  readonly systemSamples: number;
}

const mediaDurationMs = (samples: AcceptedSamples): number =>
  Math.round((Math.max(samples.micSamples, samples.systemSamples) / CAPTURE_SAMPLE_RATE) * 1000);

export const RecordingServiceLive: Layer.Layer<
  RecordingService,
  never,
  | WorkspaceBackend
  | RecordingStore
  | Capture
  | PermissionService
  | OperationalDb
  | MainLogger
  | AppConfig
  | RecordingBridge
  | MicActivity
  | DesktopI18n
  | Transcriber
  | SettingsService
  | AppModeService
  | WorkspaceIdentity
  | ModelManager
> = Layer.scoped(
  RecordingService,
  Effect.gen(function* () {
    const coreClient = yield* WorkspaceBackend;
    const store = yield* RecordingStore;
    const owner = yield* WorkspaceIdentity;
    const models = yield* ModelManager;
    // Every chunk transcribes through the seam (cloud / local / BYOK lane);
    // the engine is resolved from the preference + boot mode ONCE per recording.
    const transcriber = yield* Transcriber;
    const settings = yield* SettingsService;
    const { mode: appMode } = yield* AppModeService;
    const capture = yield* Capture;
    const permission = yield* PermissionService;
    const db = yield* OperationalDb;
    const logger = yield* MainLogger;
    const config = yield* AppConfig;
    const bridge = yield* RecordingBridge;
    const micActivity = yield* MicActivity;
    const i18n = yield* DesktopI18n;
    const log = logger.scoped('recording');
    const micLog = logger.scoped('mic-alignment');
    const recoveryRoot = config.recoveryDir;

    const state = yield* SubscriptionRef.make<RecordingState>(idleRecordingState);
    const fibers = yield* FiberMap.make<string>();
    const semaphore = yield* Effect.makeSemaphore(1);
    const activeRef = yield* Ref.make<Option.Option<ActiveRecording>>(Option.none());
    // Claims survive newer recordings, but never their owning workspace. Map
    // access is synchronous; readiness waits happen outside that atomic access.
    const completions = new Map<
      string,
      {
        ready: Deferred.Deferred<boolean>;
        stopped: boolean;
        noteId: string | null;
        segments: number;
      }
    >();
    const resolveCompletion: RecordingServiceApi['resolveCompletion'] = (recordingId, ready) =>
      Effect.gen(function* () {
        const completion = completions.get(recordingId);
        if (!completion || (yield* Deferred.isDone(completion.ready))) return;
        if (ready) {
          const segments = yield* store.segmentsForRecording(recordingId).pipe(
            Effect.map(rows => Math.max(completion.segments, rows.length)),
            Effect.catchAll(() => Effect.succeed(completion.segments))
          );
          yield* SubscriptionRef.update(state, current => ({
            ...current,
            completedRecordings: [
              ...current.completedRecordings.filter(result => result.recordingId !== recordingId),
              { recordingId, noteId: completion.noteId, segments },
            ],
          }));
        } else {
          completions.delete(recordingId);
        }
        yield* SubscriptionRef.update(state, current => ({
          ...current,
          finalizingRecordingIds: current.finalizingRecordingIds.filter(id => id !== recordingId),
        }));
        yield* Deferred.succeed(completion.ready, ready);
      });
    const captureStopped = (recordingId: string) =>
      Effect.gen(function* () {
        const completion = completions.get(recordingId);
        if (!completion) return;
        completion.stopped = true;
        if (yield* Deferred.isDone(completion.ready)) return;
        yield* SubscriptionRef.update(state, current => current.finalizingRecordingIds.includes(recordingId)
          ? current
          : { ...current, finalizingRecordingIds: [...current.finalizingRecordingIds, recordingId] });
      });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const pending = [...completions.values()];
        completions.clear();
        return pending;
      }).pipe(
        Effect.flatMap(pending =>
          Effect.forEach(pending, completion => Deferred.succeed(completion.ready, false), {
            discard: true,
          })
        )
      )
    );

    // Cloud transcript rows are a cache. On-device transcripts are authoritative:
    // their writes must succeed before acknowledging chunks or releasing audio.
    const persistBestEffort = (
      recordingId: string,
      effect: Effect.Effect<void, ProductDbError>
    ): Effect.Effect<void> =>
      effect.pipe(
        Effect.catchAll(error =>
          log.warn('recording persistence failed', {
            context: { recordingId, op: error.op },
            error: error.cause,
          })
        )
      );

    const persistRequired = (
      recordingId: string,
      effect: Effect.Effect<void, ProductDbError>
    ): Effect.Effect<boolean> =>
      effect.pipe(
        Effect.as(true),
        Effect.catchAll(error =>
          log
            .warn('recording save failed — audio retained for recovery', {
              context: { recordingId, op: error.op },
              error: error.cause,
            })
            .pipe(Effect.as(false))
        )
      );

    // The live capture level: a smoothed 0..1 RMS the dock's
    // waveform push fiber reads — deliberately OUTSIDE `state` so the per-frame
    // churn never touches the state subscribers. EMA-smoothed here (per frame);
    // throttling to the wire cadence is the push fiber's job.
    const level = yield* SubscriptionRef.make(0);
    const LEVEL_SMOOTHING = 0.4; // weight of the newest frame
    const frameRms = (samples: Float32Array): number => {
      if (samples.length === 0) return 0;
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      // Mic RMS rarely exceeds ~0.35 in normal speech — scale to fill 0..1.
      return Math.min(1, Math.sqrt(sum / samples.length) * 3);
    };
    const updateLevel = (samples: Float32Array): Effect.Effect<void> => {
      const rms = frameRms(samples);
      // One NaN sample in native PCM must not poison the EMA for the rest of
      // the recording (NaN also defeats every downstream dedupe).
      if (!Number.isFinite(rms)) return Effect.void;
      return SubscriptionRef.update(level, prev => prev + (rms - prev) * LEVEL_SMOOTHING);
    };

    // ---- the per-recording program ----
    // `input.captureMode` is the EFFECTIVE mode (post permission gate); `requestedMode`
    // is what the caller asked for — they differ when permission checks degraded system/dual → mic.
    const run = (
      recordingId: string,
      input: StartRecordingInput,
      requestedMode: MeetingCaptureMode,
      initialAlignment: MicAlignmentState,
      initialFallbackReason: InitialMicFallbackReason,
      stopSignal: Deferred.Deferred<void>,
      controlsRef: Ref.Ref<Option.Option<RecordingControls>>,
      createInput: CreateRecordingInput,
      engine: RecordingEngine,
      synchronize: ActiveRecording['synchronize']
    ): Effect.Effect<void> => {
      const mode = input.captureMode;
      const noteId = input.noteId ?? null;
      const wavDir = path.join(recoveryRoot, recordingId);
      let liveSegments: RecordingState['segments'] = [];
      const setState = (patch: Partial<RecordingState>): Effect.Effect<void> =>
        SubscriptionRef.update(state, current =>
          current.recordingId === recordingId ? { ...current, ...patch } : current
        );
      const appendSegments = (segments: RecordingState['segments']): Effect.Effect<void> =>
        Effect.suspend(() => {
          liveSegments = [...liveSegments, ...segments];
          const completion = completions.get(recordingId);
          if (completion) completion.segments = liveSegments.length;
          return setState({ segments: liveSegments });
        });

      // Interrupt/failure park (success is a no-op — the graceful path already
      // resolved or parked the row). Runs as a scope finalizer with the exit.
      const parkOnExit = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> => {
        if (Exit.isSuccess(exit)) return Effect.void;
        // Unexpected capture/storage failures and workspace interruptions retain
        // a recoverable job; only the visible capture outcome differs.
        const failed = !Exit.isInterrupted(exit);
        return db.getRecoveryOutbox(recordingId).pipe(
          Effect.flatMap(row =>
            row === null
              ? Effect.void
              : db.updateRecoveryOutbox(recordingId, {
                  status: 'interrupted',
                  lastError: failed ? 'recording-interrupted' : 'interrupted',
                })
          ),
          Effect.zipRight(
            failed
              ? captureStopped(recordingId).pipe(Effect.zipRight(setState({ status: 'error' })))
              : Effect.void
          ),
          // A genuine give-up also fails the product-store row (an
          // interruption stays 'recording' — the drain resolves it later).
          Effect.zipRight(
            failed
              ? persistBestEffort(recordingId, store.recordingFailed(recordingId))
              : Effect.void
          ),
          Effect.zipRight(
            log.info('recording parked for recovery', {
              context: { recordingId, outcome: failed ? 'failed' : 'interrupted' },
            })
          ),
          Effect.catchAll(() => Effect.void)
        );
      };

      const body = Effect.gen(function* () {
        const attemptStarted = yield* Clock.currentTimeNanos;
        let captureSummarized = false;
        let completed = false;
        let failedStage: string | undefined;
        let nextUploadAt = 0;
        let uploadsHalted = false;
        const deferRetry = (failure: RecordingLaneFailure): Effect.Effect<void> =>
          Effect.gen(function* () {
            const delay =
              failure.kind === 'http' ? recordingRetryAfterMs(failure.retryAfterMs) : undefined;
            if (delay === undefined) return;
            nextUploadAt = (yield* Clock.currentTimeMillis) + delay;
            yield* db
              .updateRecoveryOutbox(recordingId, {
                nextAttemptAt: new Date(nextUploadAt).toISOString(),
              })
              .pipe(
                Effect.catchAll(cause =>
                  log.warn('recording retry deadline save failed', {
                    context: { recordingId },
                    error: cause,
                  })
                )
              );
          });
        yield* Effect.addFinalizer(exit =>
          Effect.gen(function* () {
            const durationMs = Number((yield* Clock.currentTimeNanos) - attemptStarted) / 1_000_000;
            const interrupted = Exit.isInterrupted(exit);
            const outcome = interrupted ? 'interrupted' : completed ? 'success' : 'failure';
            if (!captureSummarized) {
              yield* log.info('Recording capture ended', {
                context: {
                  recordingId,
                  operation: 'capture',
                  outcome: interrupted ? 'interrupted' : 'failure',
                  durationMs,
                },
              });
            }
            yield* log.info('Recording processing attempt ended', {
              context: {
                recordingId,
                operation: 'processing',
                outcome,
                durationMs,
                ...(!completed && !interrupted
                  ? { failedStage: failedStage ?? 'capture', reason: 'recovery-pending' }
                  : {}),
              },
            });
          })
        );
        const startedAt = createInput.startedAt;
        const transcriptionConfig = createInput.transcriptionConfig;
        const mirrorToCore = appMode === 'cloud' && engine.engine !== 'cloud';

        yield* Effect.addFinalizer(parkOnExit);
        // Reset the level on EVERY exit path (graceful stop, capture give-up,
        // interruption) — the next recording must not inherit a dead one's EMA.
        yield* Effect.addFinalizer(() =>
          SubscriptionRef.get(state).pipe(
            Effect.flatMap(current =>
              current.recordingId === recordingId ? SubscriptionRef.set(level, 0) : Effect.void
            )
          )
        );
        yield* setState({
          recordingId,
          status: 'starting',
          captureMode: mode,
          requestedCaptureMode: requestedMode,
          spendsCloudQuota: transcriptionConfig?.provider === 'prismical-cloud',
          quotaRemainingAtStartSeconds: input.quotaRemainingAtStartSeconds ?? null,
          noteId,
          segments: [],
          elapsedMs: 0,
          elapsedAt: startedAt,
          startedAt,
          pausedAccumMs: 0,
          micSource: initialAlignment.micSource,
          autoPausePrompt: null,
          autoStopRequested: false,
        });
        yield* micLog.info('session_start', {
          context: {
            recordingId,
            mode: initialAlignment.micSource,
            app:
              initialAlignment.desired.kind === 'device'
                ? initialAlignment.desired.appName
                : undefined,
          },
        });
        if (initialFallbackReason !== null) {
          yield* micLog.info('fallback', {
            context: { recordingId, reason: initialFallbackReason },
          });
        }

        yield* log.info('recording engine resolved', {
          context: {
            recordingId,
            engine: engine.engine,
            ...(engine.engine === 'local' ? { modelId: engine.modelId } : {}),
          },
        });

        // Capture can proceed while creation is unavailable, but chunks and
        // finalization must wait for both creation and the authoritative row.
        const createRes = yield* coreClient.createRecording(createInput);
        if (!createRes.ok) {
          yield* deferRetry(createRes.failure);
          yield* log.warn('createRecording failed — capturing anyway', {
            context: { recordingId, failure: createRes.failure },
          });
        }
        const saveStarted = store.recordingStarted({
          id: recordingId,
          title: createInput.title,
          captureMode: mode,
          status: 'recording',
          noteId,
          startedAt,
          transcriptionConfig,
        });
        const startedSaved =
          engine.engine === 'cloud'
            ? yield* persistBestEffort(recordingId, saveStarted).pipe(Effect.as(true))
            : yield* persistRequired(recordingId, saveStarted);
        const created = createRes.ok && startedSaved;
        if (!created) failedStage = createRes.ok ? 'storage' : 'create';
        if (created) {
          yield* db.updateRecoveryOutbox(recordingId, { phase: 'chunks' }).pipe(
            Effect.catchAll(cause =>
              log.warn('recovery progress save failed', {
                context: { recordingId },
                error: cause,
              })
            )
          );
        }

        // 3) shared pipeline resources (survive capture restarts).
        const recovery = yield* makeRecoveryWavSet({
          dir: wavDir,
          mode,
          log,
          callbackLog: logger.scopedSync('wav-writer'),
        });
        const pipeline = yield* Ref.make(initialPipeline);
        const uploadQueue = yield* Effect.acquireRelease(
          Queue.unbounded<PendingChunk | null>(),
          Queue.shutdown
        );
        const alignment = yield* SubscriptionRef.make(initialAlignment);
        const pendingMicTransition = yield* Ref.make<PendingMicTransition | null>(null);
        const unavailableSinceMs = yield* Ref.make<number | null>(null);
        const cursorRef = yield* Ref.make<number | null>(null); // last contiguously-acked index
        const expectedNextRef = yield* Ref.make(0); // next index that would advance the cursor
        const pausedRef = yield* Ref.make(false);
        const pausedAtRef = yield* Ref.make<number | null>(null);
        const acceptedSamplesRef = yield* Ref.make<AcceptedSamples>({
          micSamples: 0,
          systemSamples: 0,
        });
        const pauseCutPointsRef = yield* Ref.make<readonly RecoveryPauseCutPoint[]>([]);
        // Auto-pause on silence. One watcher per lane: a dual recording is only
        // silent when BOTH are, because system audio alone (a video playing, the far side talking
        // while your mic is muted) is emphatically not silence. The machine is the SAME one the
        // web renderer runs — only the rendering differs (a notify card here, a toast there).
        const silence = {
          mic: new SilenceWatcher(),
          system: new SilenceWatcher(),
        } as const;
        const autoPause = new AutoPauseMachine({
          enabled: input.autoPause !== undefined,
          silenceSeconds: input.autoPause?.silenceSeconds ?? AUTO_PAUSE_DEFAULTS.silenceSeconds,
          graceSeconds: input.autoPause?.graceSeconds ?? AUTO_PAUSE_DEFAULTS.graceSeconds,
          autoStopAfterPausedMinutes:
            input.autoPause?.autoStopAfterPausedMinutes ??
            AUTO_PAUSE_DEFAULTS.autoStopAfterPausedMinutes,
          minSessionSeconds: MIN_SESSION_SECONDS_BEFORE_AUTO_PAUSE,
        });
        const frameGate = yield* Effect.makeSemaphore(1);

        /**
         * Apply what the auto-pause machine emitted. `pause`/`stop` are declared later in this
         * scope, so they arrive through a ref the definitions fill in — the same shape the web
         * hook uses, and for the same reason.
         */
        const autoActions = yield* Ref.make<{
          readonly pause: Effect.Effect<boolean>;
          readonly stop: Effect.Effect<void>;
        }>({ pause: Effect.succeed(false), stop: Effect.void });

        const applyAutoPause = (effects: readonly AutoPauseEffect[]): Effect.Effect<void> =>
          Effect.forEach(
            effects,
            effect => {
              if (effect.kind === 'show-grace') {
                return setState({
                  autoPausePrompt: { graceMs: effect.graceMs, deadlineMs: effect.deadlineMs },
                });
              }
              if (effect.kind === 'hide-grace') return setState({ autoPausePrompt: null });
              if (effect.kind === 'pause') {
                return Ref.get(autoActions).pipe(
                  Effect.flatMap(a => a.pause),
                  // A refused pause must rearm the machine, or it sits in 'committing' and
                  // auto-pause is silently dead for the rest of the session.
                  Effect.tap(ok =>
                    ok ? Effect.void : Effect.sync(() => autoPause.notePauseFailed())
                  ),
                  Effect.asVoid
                );
              }
              return Ref.get(autoActions).pipe(Effect.flatMap(a => a.stop));
            },
            { discard: true }
          );

        /** Feed one lane's frame to the detector and act on the result. */
        const observeSilence = (
          lane: 'mic' | 'system',
          samples: Float32Array
        ): Effect.Effect<readonly AutoPauseEffect[]> =>
          Effect.sync(() => {
            silence[lane].push(samples, CAPTURE_SAMPLE_RATE);
            // Dual: both lanes must be quiet. Mic-only/system-only sessions pass a single watcher,
            // and combinedSilentSeconds skips lanes that have never produced audio — otherwise an
            // absent system lane would pin the figure at 0 and disable the feature outright.
            const watchers = mode === 'dual' ? [silence.mic, silence.system] : [silence[lane]];
            const effects = autoPause.observe({
              silentSeconds: combinedSilentSeconds(watchers),
              elapsedSeconds: silence[lane].elapsedSeconds,
              nowMs: Date.now(),
            });
            return effects;
          });

        // Advance `lastChunkIndex` ONLY through a contiguous run of resolved chunks:
        // a retryable-failed (or dropped) chunk leaves a gap that freezes the cursor,
        // so the drain re-sends from there — no audio dropped past the cursor.
        const advanceCursor = (index: number): Effect.Effect<void> =>
          Ref.get(expectedNextRef).pipe(
            Effect.flatMap(expected =>
              index !== expected
                ? Effect.void
                : Ref.set(cursorRef, index).pipe(
                    Effect.zipRight(Ref.set(expectedNextRef, index + 1)),
                    Effect.zipRight(
                      db
                        .updateRecoveryOutbox(recordingId, { lastChunkIndex: index })
                        .pipe(Effect.catchAll(() => Effect.void))
                    )
                  )
            )
          );

        const uploadChunk = (chunk: PendingChunk): Effect.Effect<void> =>
          Effect.gen(function* () {
            // Creation is a prerequisite. The full WAV retains chunks until the
            // recovery worker can replay the durable create intent.
            if (!created || uploadsHalted) return;
            // Keep capture and Stop responsive during provider cooldown. The WAV
            // retains skipped chunks and the unchanged cursor makes recovery replay them.
            if ((yield* Clock.currentTimeMillis) < nextUploadAt) return;
            const res = yield* transcriber.transcribeChunk(
              recordingId,
              { chunkIndex: chunk.index, chunkStartMs: chunk.chunkStartMs, source: chunk.source },
              { samples: chunk.samples, sampleRate: CAPTURE_SAMPLE_RATE },
              engine
            );
            if (!res.ok) {
              failedStage ??= 'transcription';
              if (!res.retryable && isSessionTranscriptionFailure(res.failure))
                uploadsHalted = true;
              yield* deferRetry(res.failure);
              yield* log.warn('chunk processing failed — retained for recovery', {
                context: { recordingId, index: chunk.index, failure: res.failure },
              });
              return;
            }
            if (res.value.length > 0) {
              yield* appendSegments(res.value);
              if (engine.engine === 'cloud') {
                yield* persistBestEffort(recordingId, store.segmentsReceived(res.value));
              } else if (
                !(yield* persistRequired(recordingId, store.segmentsReceived(res.value)))
              ) {
                failedStage ??= 'storage';
                return;
              }
              if (mirrorToCore) {
                const mirrored = yield* mirrorSegmentsToCore(
                  coreClient,
                  log,
                  recordingId,
                  res.value
                );
                if (!mirrored.ok) return;
              }
            }
            yield* advanceCursor(chunk.index);
          });

        // Dual capture publishes only complete mic/system pairs so recovery cannot
        // assign a shared chunk index to the other source after a mic stall.
        const cutComplete = mode === 'dual' ? cutPaired : cutAll;
        const enqueueChunks = (chunks: readonly PendingChunk[]): Effect.Effect<void> =>
          Queue.offerAll(uploadQueue, chunks).pipe(Effect.asVoid);

        // Once capture is quiescent, cut every remaining complete chunk. Unequal
        // final lane lengths are safe here and must match recovery's final order.
        const flushComplete: Effect.Effect<void> = Ref.modify(pipeline, cutAll).pipe(
          Effect.flatMap(enqueueChunks)
        );

        // Pause or stop: emit each source's sub-CHUNK partial tail (one round,
        // mic before system), so the drain re-derives the SAME final sequence.
        const flushTail: Effect.Effect<void> = Ref.modify(pipeline, flushAll).pipe(
          Effect.flatMap(enqueueChunks)
        );

        const pauseRecording: Effect.Effect<boolean> = frameGate
          .withPermits(1)(
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(state);
              if (current.recordingId !== recordingId || current.status !== 'recording')
                return false;

              const samples = yield* Ref.get(acceptedSamplesRef);
              const previousCuts = yield* Ref.get(pauseCutPointsRef);
              const nextCuts = [...previousCuts, samples];
              const persisted = yield* db
                .updateRecoveryOutbox(recordingId, { pauseCutPoints: nextCuts })
                .pipe(
                  Effect.as(true),
                  Effect.catchAll(cause =>
                    log
                      .error('pause cut point persist failed — recording remains live', {
                        context: { recordingId },
                        error: cause,
                      })
                      .pipe(Effect.as(false))
                  )
                );
              if (!persisted) return false;

              const now = yield* Clock.currentTimeMillis;
              yield* Ref.set(pauseCutPointsRef, nextCuts);
              yield* Ref.set(pausedRef, true);
              yield* Ref.set(pausedAtRef, now);
              // Starts the auto-stop clock — for a USER pause too, because a session someone
              // paused and then abandoned deserves finalizing into a real note just as much as one
              // we paused ourselves. Also retracts the prompt if it happens to be up.
              yield* applyAutoPause(autoPause.notePaused(now));
              yield* SubscriptionRef.set(level, 0);
              yield* setState({
                status: 'paused',
                elapsedMs: mediaDurationMs(samples),
                elapsedAt: now,
              });
              return true;
            })
          )
          .pipe(
            Effect.flatMap(paused =>
              paused
                ? flushComplete.pipe(Effect.zipRight(flushTail), Effect.as(true))
                : Effect.succeed(false)
            )
          );

        const resumeRecording: Effect.Effect<boolean> = frameGate.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(state);
            if (
              current.recordingId !== recordingId ||
              current.status !== 'paused' ||
              current.autoStopRequested
            )
              return false;
            const now = yield* Clock.currentTimeMillis;
            const pausedAt = yield* Ref.get(pausedAtRef);
            const pausedMs = pausedAt === null ? 0 : Math.max(0, now - pausedAt);
            yield* Ref.set(pausedRef, false);
            yield* Ref.set(pausedAtRef, null);
            // Back to listening, and the silent run that caused the pause is cleared from both
            // lanes — otherwise the frames arriving right after a resume still carry it and the
            // user is asked again seconds after coming back.
            yield* Effect.sync(() => {
              silence.mic.noteTranscribedSpeech();
              silence.system.noteTranscribedSpeech();
              autoPause.noteResumed();
            });
            yield* setState({
              status: 'recording',
              elapsedAt: now,
              pausedAccumMs: current.pausedAccumMs + pausedMs,
            });
            return true;
          })
        );

        const keepRecording: Effect.Effect<boolean> = Effect.sync(() =>
          autoPause.keepRecording()
        ).pipe(
          Effect.flatMap(effects => applyAutoPause(effects)),
          Effect.as(true)
        );

        // The prompt's Pause button routes through the MACHINE (pauseNow) rather than straight to
        // pauseRecording, so the pause is attributed to the user — they consented — instead of
        // being reported as one we decided on.
        const pauseFromPrompt: Effect.Effect<boolean> = Effect.sync(() =>
          autoPause.pauseNow()
        ).pipe(
          Effect.flatMap(effects => applyAutoPause(effects)),
          Effect.as(true)
        );

        yield* Ref.set(autoActions, {
          pause: pauseRecording,
          // Main owns capture termination even when no renderer is mounted.
          // Completion is claimed independently by the owning UI when available.
          stop: setState({ autoStopRequested: true }).pipe(
            Effect.zipRight(Deferred.succeed(stopSignal, undefined)),
            Effect.asVoid
          ),
        });

        yield* Ref.set(
          controlsRef,
          Option.some({
            pause: pauseRecording,
            resume: resumeRecording,
            keepRecording,
            pauseFromPrompt,
          })
        );
        yield* Effect.addFinalizer(() => Ref.set(controlsRef, Option.none()));

        // Auto-stop uses the one wall-clock timer in the feature. Everything during
        // capture rides the audio clock precisely because it cannot be throttled or skewed, but a
        // paused session produces no frames, so the auto-stop deadline has nothing else to ride.
        // Scoped to the recording, so it dies with it.
        const autoPauseFiber = yield* Effect.forkScoped(
          synchronize(
            Clock.currentTimeMillis.pipe(Effect.flatMap(now => applyAutoPause(autoPause.tick(now))))
          ).pipe(Effect.delay(AUTO_STOP_POLL), Effect.forever)
        );

        // Upload in order independently of capture. Stop appends a sentinel after
        // its final chunks; workspace interruption cancels the worker and retains the WAV.
        const uploadFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) {
              const chunk = yield* Queue.take(uploadQueue);
              if (chunk === null) return;
              yield* uploadChunk(chunk);
            }
          })
        );

        // Frame consumer: route each frame → recovery WAV + chunk buffer. Never uploads.
        const onFrame = (frame: AudioFrame): Effect.Effect<void, RecoveryWriteError> => {
          const lane = laneForFrame(mode, frame.source);
          if (lane === null) return Effect.void;
          return synchronize(
            frameGate
              .withPermits(1)(
                Effect.uninterruptible(
                  Ref.get(pausedRef).pipe(
                    Effect.flatMap(paused =>
                      paused
                        ? Effect.succeed<readonly AutoPauseEffect[]>([])
                        : updateLevel(frame.samples).pipe(
                            Effect.zipRight(recovery.append(lane, frame.samples)),
                            Effect.zipRight(
                              Ref.update(pipeline, s => bufferSamples(s, lane, frame.samples))
                            ),
                            Effect.tap(() =>
                              Ref.update(acceptedSamplesRef, current => ({
                                ...current,
                                [lane === 'mic' ? 'micSamples' : 'systemSamples']:
                                  current[lane === 'mic' ? 'micSamples' : 'systemSamples'] +
                                  frame.samples.length,
                              }))
                            ),
                            Effect.zipRight(Ref.modify(pipeline, cutComplete)),
                            Effect.tap(enqueueChunks),
                            Effect.flatMap(chunks =>
                              chunks.length === 0
                                ? Effect.void
                                : Effect.all([
                                    Ref.get(acceptedSamplesRef),
                                    Clock.currentTimeMillis,
                                  ]).pipe(
                                    Effect.flatMap(([samples, now]) =>
                                      setState({
                                        elapsedMs: mediaDurationMs(samples),
                                        elapsedAt: now,
                                      })
                                    )
                                  )
                            ),
                            Effect.zipRight(observeSilence(lane, frame.samples))
                          )
                    )
                  )
                )
              )
              .pipe(Effect.flatMap(applyAutoPause))
          );
        };

        const commandFor = (binding: DesiredMicBinding, rev: number): MicBindingCommand =>
          binding.kind === 'device'
            ? { cmd: 'set-mic', uid: binding.uid, rev }
            : { cmd: 'follow-default', rev };

        const reassertDesired = SubscriptionRef.update(alignment, current => ({
          ...current,
          desiredRevision: current.desiredRevision + 1,
        }));

        const applyAlignment = (
          event: MicAlignmentEvent,
          nowMs: number
        ): Effect.Effect<{
          readonly ignored: boolean;
          readonly previous: MicAlignmentState;
          readonly next: MicAlignmentState;
        }> =>
          SubscriptionRef.modify(alignment, previous => {
            const ignored =
              event._tag === 'helper' &&
              event.event.kind === 'bound' &&
              event.event.rev !== undefined &&
              event.event.rev < previous.desiredRevision;
            const next = reduceMicAlignment(previous, event, nowMs);
            return [{ ignored, previous, next }, next] as const;
          }).pipe(
            Effect.tap(({ ignored, previous, next }) => {
              if (
                ignored ||
                event._tag !== 'snapshot' ||
                sameDesiredBinding(previous.desired, next.desired)
              )
                return Effect.void;
              const sameApp =
                previous.desired.kind === 'device' &&
                next.desired.kind === 'device' &&
                previous.desired.appBundleId === next.desired.appBundleId;
              const transition: PendingMicTransition = {
                from: previous.micSource,
                trigger: sameApp ? 'app-select' : 'app-start',
                detectMs: Math.max(0, nowMs - (event.snapshot.timestampMs ?? nowMs)),
              };
              return Ref.set(pendingMicTransition, transition);
            }),
            Effect.tap(({ ignored, previous, next }) =>
              ignored || previous.micSource === next.micSource
                ? Effect.void
                : setState({ micSource: next.micSource })
            )
          );

        // Detection is a replay-latest feed shared with meeting notifications.
        // A missing/stale value is intentionally a no-op mid-session: positive
        // identifiable context changes selection; ambiguity holds the binding.
        if (mode !== 'system') {
          yield* Effect.forkScoped(
            micActivity.latest.changes.pipe(
              Stream.runForEach(latest =>
                Option.match(latest, {
                  onNone: () => Effect.void,
                  onSome: value =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap(nowMs =>
                        nowMs - value.receivedAtMs > MIC_ACTIVITY_FRESH_MS
                          ? Effect.void
                          : applyAlignment(
                              { _tag: 'snapshot', snapshot: value.snapshot },
                              nowMs
                            ).pipe(Effect.asVoid)
                      )
                    ),
                })
              )
            )
          );
        }

        // Capture + bounded restart. Only completes via failure (restart-exhausted)
        // or external interruption — never a spurious success.
        const captureLoop = Effect.scoped(
          Effect.gen(function* () {
            const initialDesired = yield* SubscriptionRef.get(alignment);
            const session = yield* capture.capture(mode, {
              micDeviceUid:
                initialDesired.desired.kind === 'device' ? initialDesired.desired.uid : undefined,
            });

            // Reserve a fresh generation for every helper process before its
            // replay-latest command stream starts.
            yield* reassertDesired;

            const handleMicEvent = (event: MicCaptureEvent): Effect.Effect<void> =>
              Effect.gen(function* () {
                const nowMs = yield* Clock.currentTimeMillis;
                const { ignored, previous, next } = yield* applyAlignment(
                  { _tag: 'helper', event },
                  nowMs
                );
                if (ignored) return;

                if (event.kind === 'lost') {
                  yield* micLog.warn('fallback', {
                    context: { recordingId, reason: 'disconnected', uid: event.uid },
                  });
                } else if (event.kind === 'bind-failed') {
                  yield* micLog.warn('activation_failure', {
                    context: {
                      recordingId,
                      uid: event.uid,
                      os_status: event.osStatus,
                      reason: event.reason,
                      operation: event.operation,
                      fallback: next.desired.kind === 'default' ? 'default' : 'unbound',
                    },
                  });
                } else if (event.kind === 'unavailable') {
                  const unavailableAt = yield* Ref.get(unavailableSinceMs);
                  if (unavailableAt === null) yield* Ref.set(unavailableSinceMs, nowMs);
                  yield* micLog.warn('unavailable', { context: { recordingId } });
                } else if (event.kind === 'recovered') {
                  const unavailableAt = yield* Ref.get(unavailableSinceMs);
                  yield* Ref.set(unavailableSinceMs, null);
                  yield* micLog.info('recovered', {
                    context: {
                      recordingId,
                      uid: event.uid,
                      duration_ms: unavailableAt === null ? 0 : Math.max(0, nowMs - unavailableAt),
                    },
                  });
                } else if (event.kind === 'timeline-jump') {
                  yield* micLog.warn('timeline_jump', {
                    context: { recordingId, gap_ms: event.gapMs },
                  });
                } else if (event.kind === 'bound') {
                  const pending = yield* Ref.get(pendingMicTransition);
                  const trigger: MicTransitionTrigger =
                    event.reason === 'default-change'
                      ? 'default-change'
                      : event.reason === 'autonomous-fallback'
                        ? 'device-lost'
                        : (pending?.trigger ?? 'app-select');
                  const changedActual =
                    previous.actualUid !== null && previous.actualUid !== event.uid;
                  if (pending !== null || changedActual || event.reason !== 'command') {
                    yield* micLog.info('transition', {
                      context: {
                        recordingId,
                        from: pending?.from ?? previous.micSource,
                        to: next.micSource,
                        trigger,
                        detect_ms: pending?.detectMs ?? 0,
                        blackout_ms: event.blackoutMs ?? 0,
                        trimmed_ms: event.trimmedMs ?? 0,
                        ok: true,
                        uid: event.uid,
                        app: next.desired.kind === 'device' ? next.desired.appName : undefined,
                      },
                    });
                  }
                  yield* Ref.set(pendingMicTransition, null);

                  // A latest command response that still disagrees is the one
                  // reconciliation case that needs an immediate re-assertion.
                  const mismatch =
                    next.desired.kind === 'device'
                      ? event.uid !== next.desired.uid
                      : event.mode === 'fixed';
                  if (
                    mismatch &&
                    event.rev === previous.desiredRevision &&
                    sameDesiredBinding(previous.desired, next.desired)
                  ) {
                    yield* reassertDesired;
                  }
                }
              });

            yield* Effect.forkScoped(
              alignment.changes.pipe(
                Stream.map(current => commandFor(current.desired, current.desiredRevision)),
                Stream.changesWith((previous, next) => previous.rev === next.rev),
                Stream.runForEach(session.sendMicCommand)
              )
            );
            yield* Effect.forkScoped(
              Stream.fromQueue(session.micEvents).pipe(Stream.runForEach(handleMicEvent))
            );
            const paused = yield* Ref.get(pausedRef);
            if (paused) {
              yield* setState({ status: 'paused' });
            } else {
              const samples = yield* Ref.get(acceptedSamplesRef);
              const now = yield* Clock.currentTimeMillis;
              yield* setState({
                status: 'recording',
                elapsedMs: mediaDurationMs(samples),
                elapsedAt: now,
              });
            }
            const frameConsumer = Stream.fromQueue(session.frames).pipe(Stream.runForEach(onFrame));
            yield* Effect.raceFirst(
              session.awaitExit,
              frameConsumer.pipe(Effect.zipRight(Effect.never))
            );
          })
        ).pipe(
          Effect.tapError((error: CaptureError | RecoveryWriteError) => {
            if (error._tag === 'RecoveryWriteError') failedStage ??= 'storage';
            return log.warn('capture interrupted', { context: { recordingId }, error });
          }),
          Effect.retry({
            schedule: RESTART_SCHEDULE,
            while: error => error._tag !== 'RecoveryWriteError',
          })
        );

        // Stop and exhausted capture restarts both complete the captured audio.
        const captureExit = yield* (
          (yield* Deferred.isDone(stopSignal))
            ? Effect.void
            : Effect.raceFirst(Deferred.await(stopSignal), captureLoop)
        ).pipe(Effect.either);
        if (Either.isLeft(captureExit)) {
          yield* log.warn('capture ended — completing retained audio', {
            context: { recordingId },
            error: captureExit.left,
          });
          yield* Deferred.succeed(stopSignal, undefined);
        }

        yield* Fiber.interrupt(autoPauseFiber);
        yield* synchronize(
          applyAutoPause(autoPause.noteStopped()).pipe(
            Effect.zipRight(Ref.set(controlsRef, Option.none()))
          )
        );

        // ---- graceful stop path ----
        // `onFrame` is atomic once it owns this gate. Crossing it after capture
        // stops guarantees recovery WAVs, chunk buffers, and accepted-sample
        // counters all describe the same final frame boundary.
        yield* frameGate.withPermits(1)(Effect.void);
        const stoppingSamples = yield* Ref.get(acceptedSamplesRef);
        const stoppingAt = yield* Clock.currentTimeMillis;
        captureSummarized = true;
        yield* log.info('Recording capture ended', {
          context: {
            recordingId,
            operation: 'capture',
            outcome: Either.isLeft(captureExit) ? 'failure' : 'success',
            durationMs: Number((yield* Clock.currentTimeNanos) - attemptStarted) / 1_000_000,
            audioDurationMs: mediaDurationMs(stoppingSamples),
            ...(Either.isLeft(captureExit)
              ? {
                  failedStage:
                    captureExit.left._tag === 'RecoveryWriteError' ? 'storage' : 'capture',
                }
              : {}),
          },
          ...(Either.isLeft(captureExit) ? { error: captureExit.left } : {}),
        });
        yield* SubscriptionRef.set(level, 0);
        yield* setState({
          status: 'stopping',
          elapsedMs: mediaDurationMs(stoppingSamples),
          elapsedAt: stoppingAt,
        });
        yield* db
          .updateRecoveryOutbox(recordingId, {
            status: 'finalizing',
            endedAt: stoppingAt,
            durationMs: mediaDurationMs(stoppingSamples),
          })
          .pipe(Effect.catchAll(() => Effect.void));
        yield* synchronize(
          flushComplete.pipe(
            Effect.zipRight(flushTail),
            Effect.zipRight(Queue.offer(uploadQueue, null))
          )
        );
        yield* recovery.finalizeAndClose.pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              failedStage ??= 'storage';
            })
          )
        );
        // Capture is closed and its audio is durable. Processing retains the
        // workflow until finalization or recovery reports completion.
        yield* captureStopped(recordingId);
        yield* semaphore.withPermits(1)(
          SubscriptionRef.update(state, current => ({
            ...current,
            ...(current.recordingId === recordingId
              ? {
                  status: 'idle' as const,
                  autoPausePrompt: null,
                  autoStopRequested: false,
                }
              : {}),
          })).pipe(
            Effect.zipRight(
              Ref.update(activeRef, current =>
                Option.exists(current, active => active.recordingId === recordingId)
                  ? Option.none()
                  : current
              )
            )
          )
        );
        yield* Fiber.join(uploadFiber);

        const endedAt = stoppingAt;
        const acceptedSamples = yield* Ref.get(acceptedSamplesRef);
        const durationMs = mediaDurationMs(acceptedSamples);
        const cursor = yield* Ref.get(cursorRef);
        const finalPipeline = yield* Ref.get(pipeline);
        const totalAssigned = finalPipeline.nextIndex;
        const allAcked =
          created && (cursor === null ? totalAssigned === 0 : cursor + 1 === totalAssigned);

        // Persist the exact stop metadata before recovery takes ownership.
        const savedStop = yield* db
          .updateRecoveryOutbox(recordingId, {
            status: 'finalizing',
            phase: !created ? 'create' : allAcked ? 'finalize' : 'chunks',
            endedAt,
            durationMs,
            lastError: allAcked ? null : 'stop-incomplete',
          })
          .pipe(
            Effect.as(true),
            Effect.catchAll(cause =>
              log
                .warn('recording stop save failed — audio retained', {
                  context: { recordingId },
                  error: cause,
                })
                .pipe(Effect.as(false))
            )
          );

        if (!savedStop) failedStage ??= 'storage';
        if (!allAcked) failedStage ??= 'transcription';
        if (savedStop && allAcked) {
          let metaSaved = true;
          if (engine.engine !== 'cloud') {
            metaSaved = yield* persistRequired(
              recordingId,
              store.recordingMetaMerged(recordingId, {
                detectedSpeakerCount: detectedSpeakerCountFor(mode, liveSegments),
              })
            );
          }
          if (!metaSaved) failedStage ??= 'storage';
          if (metaSaved) {
            const finalized = yield* coreClient.finalizeRecording(recordingId, {
              endedAt,
              durationMs,
            });
            if (finalized.ok) {
              const completionSaved =
                engine.engine === 'cloud'
                  ? yield* persistBestEffort(
                      recordingId,
                      store.recordingCompleted(recordingId, { endedAt, durationMs })
                    ).pipe(Effect.as(true))
                  : yield* persistRequired(
                      recordingId,
                      store.recordingCompleted(recordingId, { endedAt, durationMs })
                    );
              if (!completionSaved) failedStage ??= 'storage';
              if (completionSaved) {
                yield* db.updateRecoveryOutbox(recordingId, { phase: 'cleanup' }).pipe(
                  Effect.tap(() => {
                    completed = true;
                    return log.info('Recording completed', {
                      context: {
                        recordingId,
                        operation: 'recording',
                        outcome: 'success',
                        audioDurationMs: durationMs,
                      },
                    });
                  }),
                  Effect.zipRight(resolveCompletion(recordingId, true)),
                  Effect.catchAll(cause => {
                    failedStage ??= 'storage';
                    return log.warn('recording progress save failed — retained for recovery', {
                      context: { recordingId },
                      error: cause,
                    });
                  })
                );
              }
            } else {
              failedStage ??= 'finalize';
              yield* deferRetry(finalized.failure);
              yield* log.warn('finalizeRecording failed — retained for recovery', {
                context: { recordingId, failure: finalized.failure },
              });
            }
          }
        } else {
          yield* log.warn('recording stopped with unresolved chunks — parked for drain', {
            context: { recordingId, cursor, totalAssigned },
          });
        }

        // The workspace recovery worker owns cleanup. No daemon may
        // outlive this workspace or compete with that worker for the WAV files.
        yield* captureStopped(recordingId);
        // Observable: idle, retaining the finished id + segments as the last snapshot.
        // (The level reset rides the body finalizer above — every exit path.)
        yield* setState({
          status: Either.isLeft(captureExit) ? 'error' : 'idle',
          elapsedMs: durationMs,
          elapsedAt: null,
          startedAt: null,
          pausedAccumMs: 0,
          micSource: 'system-default',
          autoPausePrompt: null,
          autoStopRequested: false,
        });
      });

      return Effect.scoped(body).pipe(
        Effect.catchAll((error: CaptureError | RecoveryWriteError) =>
          log.warn('recording stopped with unresolved recovery work', {
            context: { recordingId },
            error: error,
          })
        )
      );
    };

    // ---- public API ----
    const start: RecordingServiceApi['start'] = input =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(activeRef);
          if (Option.isSome(current)) {
            return yield* Effect.fail(
              new RecordingBusyError({ activeRecordingId: current.value.recordingId })
            );
          }

          // Finalization and recovery still own the recording workflow after native
          // capture closes. Tray/widget starts must obey the same admission as the app.
          for (const [recordingId, completion] of completions) {
            if (!(yield* Deferred.isDone(completion.ready)))
              return yield* Effect.fail(new RecordingBusyError({ activeRecordingId: recordingId }));
          }

          // A different window may hold the pending suggestion, or this window
          // may still be loading it. The workspace backend owns that decision.
          if (input.noteId) {
            const response = yield* coreClient.request({
              method: 'GET',
              path: '/apps/v1/me/skill-runs/pending',
              query: { noteId: input.noteId },
            });
            if ('ok' in response && response.status === 200) {
              const pending = PendingSkillResultsSchema.safeParse(response.bodyJson);
              if (pending.success && pending.data.results.length > 0)
                return yield* Effect.fail(
                  new RecordingStartError({ reason: 'suggestion-pending' })
                );
            }
          }

          // Resolve the mode the native binary can actually satisfy
          // (degrade system/dual → mic when system audio is unavailable) and
          // ensure the mic (prompt when not-determined). Fails PermissionError
          // BEFORE any id is minted / row written / child spawned.
          const resolved = yield* permission.effectiveCaptureMode(input.captureMode);
          const effectiveInput: StartRecordingInput = { ...input, captureMode: resolved.mode };

          const engine = resolveRecordingEngine(appMode, (yield* settings.get).transcription);
          if (
            engine.engine === 'local' &&
            Option.isNone(yield* models.installedPath(engine.modelId))
          ) {
            return yield* Effect.fail(new RecordingStartError({ reason: 'model-missing' }));
          }
          const transcriptionConfig = yield* resolveTranscriptionConfig(engine, coreClient);
          const nowMs = yield* Clock.currentTimeMillis;
          const latest = yield* SubscriptionRef.get(micActivity.latest);
          const initialSnapshot = Option.match(latest, {
            onNone: () => null,
            onSome: value =>
              nowMs - value.receivedAtMs <= MIC_ACTIVITY_FRESH_MS ? value.snapshot : null,
          });
          const initialAlignment = initialMicAlignmentState(
            resolved.mode === 'system' ? null : initialSnapshot,
            nowMs
          );
          let initialFallbackReason: InitialMicFallbackReason = null;
          if (resolved.mode !== 'system' && initialAlignment.desired.kind === 'default') {
            initialFallbackReason =
              initialSnapshot === null || initialSnapshot.apps.length === 0
                ? 'missing'
                : 'unidentified';
          }

          const recordingId = createId('recording');
          const completionReady = yield* Deferred.make<boolean>();
          completions.set(recordingId, {
            ready: completionReady,
            stopped: false,
            noteId: input.noteId ?? null,
            segments: 0,
          });
          const createInput: CreateRecordingInput = {
            recordingId,
            title: input.title ?? i18n.t('recording.untitledRecording'),
            captureMode: resolved.mode,
            noteId: input.noteId ?? null,
            startedAt: nowMs,
            transcriptionConfig,
          };
          const stopSignal = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          const controls = yield* Ref.make<Option.Option<RecordingControls>>(Option.none());
          const stopping = yield* Ref.make(false);
          const commandSemaphore = yield* Effect.makeSemaphore(1);
          const synchronize: ActiveRecording['synchronize'] = effect =>
            commandSemaphore.withPermits(1)(effect);
          yield* Ref.set(
            activeRef,
            Option.some({
              recordingId,
              stopSignal,
              done,
              controls,
              stopping,
              synchronize,
            })
          );

          // Reserve control ownership and publish a complete snapshot before the
          // durable row becomes visible to recovery or another window can Stop.
          const previousState = yield* SubscriptionRef.get(state);
          yield* SubscriptionRef.update(state, current => ({
            ...idleRecordingState,
            finalizingRecordingIds: current.finalizingRecordingIds,
            completedRecordings: current.completedRecordings,
            status: 'starting' as const,
            recordingId,
            captureMode: resolved.mode,
            requestedCaptureMode: resolved.requested,
            spendsCloudQuota: transcriptionConfig.provider === 'prismical-cloud',
            quotaRemainingAtStartSeconds: input.quotaRemainingAtStartSeconds ?? null,
            noteId: createInput.noteId ?? null,
            startedAt: nowMs,
            elapsedAt: nowMs,
            micSource: initialAlignment.micSource,
          }));
          yield* db
            .insertRecoveryOutbox({
              recordingId,
              noteId: createInput.noteId ?? null,
              captureMode: resolved.mode,
              wavPath: path.join(recoveryRoot, recordingId),
              engine: engine.engine,
              status: 'capturing',
              owner,
              createInput,
              engineConfig: engine,
              phase: 'create',
            })
            .pipe(
              Effect.onError(() =>
                Ref.set(activeRef, Option.none()).pipe(
                  Effect.zipRight(resolveCompletion(recordingId, false)),
                  Effect.zipRight(
                    SubscriptionRef.update(state, current => ({
                      ...previousState,
                      finalizingRecordingIds: current.finalizingRecordingIds,
                      completedRecordings: current.completedRecordings,
                    }))
                  ),
                  Effect.zipRight(Deferred.succeed(done, undefined))
                )
              ),
              Effect.mapError(() => new RecordingStartError({ reason: 'storage-unavailable' }))
            );

          const program = run(
            recordingId,
            effectiveInput,
            resolved.requested,
            initialAlignment,
            initialFallbackReason,
            stopSignal,
            controls,
            createInput,
            engine,
            synchronize
          ).pipe(
            Effect.ensuring(
              Ref.update(activeRef, cur =>
                Option.exists(cur, a => a.recordingId === recordingId) ? Option.none() : cur
              ).pipe(
                Effect.zipRight(Deferred.succeed(done, undefined))
              )
            )
          );
          yield* FiberMap.run(fibers, recordingId, program);
          yield* log.info('recording started', {
            context: {
              recordingId,
              requested: resolved.requested,
              mode: resolved.mode,
              degraded: resolved.degraded,
            },
          });
          return recordingId;
        })
      );

    const stop: RecordingServiceApi['stop'] = recordingId =>
      Ref.get(activeRef).pipe(
        Effect.flatMap(current =>
          Option.isNone(current) || current.value.recordingId !== recordingId
            ? log.warn('stop: no matching active recording', { context: { recordingId } })
            : current.value
                .synchronize(
                  Ref.set(current.value.stopping, true).pipe(
                    Effect.zipRight(Deferred.succeed(current.value.stopSignal, undefined))
                  )
                )
                .pipe(Effect.zipRight(Deferred.await(current.value.done)))
        )
      );

    const runControl = (
      recordingId: string,
      select: (controls: RecordingControls) => Effect.Effect<boolean>
    ): Effect.Effect<boolean> =>
      Ref.get(activeRef).pipe(
        Effect.flatMap(current => {
          if (Option.isNone(current) || current.value.recordingId !== recordingId) {
            return Effect.succeed(false);
          }
          return current.value.synchronize(
            Ref.get(current.value.stopping).pipe(
              Effect.flatMap(stopping => {
                if (stopping) return Effect.succeed(false);
                return Ref.get(current.value.controls).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.succeed(false),
                      onSome: select,
                    })
                  )
                );
              })
            )
          );
        })
      );

    const pause: RecordingServiceApi['pause'] = recordingId =>
      runControl(recordingId, controls => controls.pause);
    const resume: RecordingServiceApi['resume'] = recordingId =>
      runControl(recordingId, controls => controls.resume);
    const keepRecording: RecordingServiceApi['keepRecording'] = recordingId =>
      runControl(recordingId, controls => controls.keepRecording);
    const pauseFromPrompt: RecordingServiceApi['pauseFromPrompt'] = recordingId =>
      runControl(recordingId, controls => controls.pauseFromPrompt);

    const api: RecordingServiceApi = {
      start,
      stop,
      resolveCompletion,
      claimCompletion: recordingId =>
        Effect.gen(function* () {
          const completion = completions.get(recordingId);
          if (!completion?.stopped) return false;
          if (!(yield* Deferred.await(completion.ready))) return false;
          // Several windows can wait on the same readiness signal; one wins.
          const claimed = yield* Effect.sync(() => {
            if (completions.get(recordingId) !== completion) return false;
            completions.delete(recordingId);
            return true;
          });
          if (claimed)
            yield* SubscriptionRef.update(state, current => ({
              ...current,
              completedRecordings: current.completedRecordings.filter(
                result => result.recordingId !== recordingId
              ),
            }));
          return claimed;
        }),
      pause,
      resume,
      keepRecording,
      pauseFromPrompt,
      state,
      level,
    };
    // Publish into the boot-scoped bridge for the session's lifetime: the
    // boot IPC handlers + state push fiber reach THIS session's service; the
    // compare-and-clear release drops it when the session scope closes.
    yield* bridge.register(api);
    return api;
  })
);
