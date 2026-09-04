/**
 * RecordingServiceLive — the session-scoped supervisor.
 *
 * Wires capture → recovery WAV (recovery-writer) → chunk upload lane →
 * recovery outbox. One `FiberMap<recordingId>` + a `Semaphore(1)` (one active
 * recording). Every timer uses Clock/Schedule, not raw timers, so TestClock
 * drives chunk cadence + restart backoff. The whole thing lives in the session
 * scope, so sign-out / org-switch / quit interrupts the native child, parks the
 * outbox `interrupted`, and retains the WAV for the next session's drain.
 *
 * Termination model (the load-bearing part):
 *  - graceful `stop`   → fulfils a stopSignal; the body flushes the tail, finalizes,
 *                        and (all chunks acked + finalize ok) deletes the WAV + row;
 *  - capture gives up  → the restart Schedule exhausts, the body FAILS → the scope's
 *                        park finalizer marks the row `failed` (WAV retained), state `error`;
 *  - interrupt         → the session scope closes → the body is interrupted → the park
 *                        finalizer marks the row `interrupted` (WAV retained). `kill -9`
 *                        skips the finalizer, but the row already exists (written before
 *                        the first frame), so the drain resolves it on the next signed-in session.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Ref,
  Schedule,
  Stream,
  SubscriptionRef,
} from 'effect';
import { createId } from '@prismical/id';
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
import { readStagingLanes } from './staging-lanes';
import {
  Capture,
  type CaptureError,
  type MicBindingCommand,
  type MicCaptureEvent,
} from './capture/service';
import { PermissionService } from './permission/service';
import { WorkspaceBackend } from '../transport/service';
import { RecordingStore } from './store';
import { AppModeService } from '../app-mode/service';
import { DesktopI18n } from '../i18n/service';
import { SettingsService } from '../settings/service';
import { resolveRecordingEngine, transcriptionConfigFor } from '../transcriber/engine';
import { detectedSpeakerCountFor } from '../transcriber/segment';
import { Transcriber } from '../transcriber/service';
import { mirrorSegmentsToCore } from './segment-mirror';
import {
  CAPTURE_SAMPLE_RATE,
  CHUNK_INTERVAL_SECONDS,
  bufferSamples,
  cutAll,
  cutPaired,
  droppedSamples,
  flushAll,
  initialPipeline,
  laneForFrame,
  type PendingChunk,
} from './chunker';
import { makeRecoveryWavSet } from './recovery-writer';
import {
  RecordingBusyError,
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

/** Fixed chunk cadence. Every chunk is a valid standalone WAV. The seconds
 * live in chunker.ts so the drain re-chunks on the same boundary. */
const CHUNK_INTERVAL = Duration.seconds(CHUNK_INTERVAL_SECONDS);

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
> = Layer.scoped(
  RecordingService,
  Effect.gen(function* () {
    const coreClient = yield* WorkspaceBackend;
    const store = yield* RecordingStore;
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

    const setState = (patch: Partial<RecordingState>): Effect.Effect<void> =>
      SubscriptionRef.update(state, current => ({ ...current, ...patch }));

    // Product-store writes are best-effort at every call site: a
    // DbError folds to a warn with the recording context and the audio path
    // continues untouched — persistence never gates capture or upload.
    const persistBestEffort = (
      recordingId: string,
      effect: Effect.Effect<void, ProductDbError>
    ): Effect.Effect<void> =>
      effect.pipe(
        Effect.catchAll(error =>
          log.warn('recording persistence failed', {
            recordingId,
            op: error.op,
            cause: String(error.cause),
          })
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
      controlsRef: Ref.Ref<Option.Option<RecordingControls>>
    ): Effect.Effect<void> => {
      const mode = input.captureMode;
      const noteId = input.noteId ?? null;
      const wavDir = path.join(recoveryRoot, recordingId);

      const appendSegments = (segments: RecordingState['segments']): Effect.Effect<void> =>
        SubscriptionRef.update(state, current => ({
          ...current,
          segments: [...current.segments, ...segments],
        }));

      // Interrupt/failure park (success is a no-op — the graceful path already
      // resolved or parked the row). Runs as a scope finalizer with the exit.
      const parkOnExit = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> => {
        if (Exit.isSuccess(exit)) return Effect.void;
        // An interrupted Exit is ALSO an Exit.Failure (Cause.Interrupt) — a genuine
        // capture give-up is `failed`, a sign-out/quit interruption is `interrupted`.
        const failed = !Exit.isInterrupted(exit);
        return db.getRecoveryOutbox(recordingId).pipe(
          Effect.flatMap(row =>
            row === null
              ? Effect.void
              : db.updateRecoveryOutbox(recordingId, {
                  status: failed ? 'failed' : 'interrupted',
                  lastError: failed ? 'capture-gave-up' : 'interrupted',
                })
          ),
          Effect.zipRight(failed ? setState({ status: 'error' }) : Effect.void),
          // A genuine give-up also fails the product-store row (an
          // interruption stays 'recording' — the drain resolves it later).
          Effect.zipRight(
            failed
              ? persistBestEffort(recordingId, store.recordingFailed(recordingId))
              : Effect.void
          ),
          Effect.zipRight(
            log.info('recording parked for recovery', {
              recordingId,
              outcome: failed ? 'failed' : 'interrupted',
            })
          ),
          Effect.catchAll(() => Effect.void)
        );
      };

      const body = Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;

        // The transcription engine is read from the preference once, before
        // the outbox row opens, and FROZEN for this recording (a settings
        // change mid-recording never re-routes chunks). Kept in the fiber's
        // closure — RecordingState's view schema is .strict(), and the
        // renderer does not need it. Local mode coerces the 'cloud' default to
        // 'local' (no cloud transcriber there).
        const engine = resolveRecordingEngine(appMode, (yield* settings.get).transcription);
        const transcriptionConfig = transcriptionConfigFor(engine);
        // Cloud mode + a non-cloud engine: core never sees the audio, so the
        // device mirrors each segment it mints (segment-mirror.ts) BEFORE the
        // finalize PUT, and never stages the WAVs for a server re-transcription.
        const mirrorToCore = appMode === 'cloud' && engine.engine !== 'cloud';

        // 1) durable recovery row BEFORE the first frame (kill -9 ⇒ recoverable
        // row) — carrying the frozen engine KIND so the drain re-drives this
        // row under the engine that produced it, never the current preference.
        yield* db
          .insertRecoveryOutbox({
            recordingId,
            noteId,
            captureMode: mode,
            wavPath: wavDir,
            engine: engine.engine,
            status: 'capturing',
          })
          .pipe(
            Effect.catchAll(cause =>
              log.error('outbox insert failed', { recordingId, cause: String(cause) })
            )
          );
        yield* Effect.addFinalizer(parkOnExit);
        // Reset the level on EVERY exit path (graceful stop, capture give-up,
        // interruption) — the next recording must not inherit a dead one's EMA.
        yield* Effect.addFinalizer(() => SubscriptionRef.set(level, 0));
        yield* SubscriptionRef.set(state, {
          recordingId,
          status: 'starting',
          captureMode: mode,
          requestedCaptureMode: requestedMode,
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
          recordingId,
          mode: initialAlignment.micSource,
          app:
            initialAlignment.desired.kind === 'device'
              ? initialAlignment.desired.appName
              : undefined,
        });
        if (initialFallbackReason !== null) {
          yield* micLog.info('fallback', {
            recordingId,
            reason: initialFallbackReason,
          });
        }

        yield* log.info('recording engine resolved', {
          recordingId,
          engine: engine.engine,
          ...(engine.engine === 'local' ? { modelId: engine.modelId } : {}),
        });

        // 2) create the cloud recording (best-effort; the pipeline runs either way).
        const createRes = yield* coreClient.createRecording({
          recordingId,
          title: input.title ?? i18n.t('recording.untitledRecording'),
          captureMode: mode,
          noteId,
          startedAt,
          transcriptionConfig,
        });
        if (!createRes.ok) {
          yield* log.warn('createRecording failed — capturing anyway', {
            recordingId,
            failure: createRes.failure,
          });
        }
        // Mirror the recording row into the workspace product store
        // (local.db / the cloud cache) with the SAME fields the cloud create
        // body carries — best-effort, the pipeline runs either way.
        yield* persistBestEffort(
          recordingId,
          store.recordingStarted({
            id: recordingId,
            title: input.title ?? i18n.t('recording.untitledRecording'),
            captureMode: mode,
            status: 'recording',
            noteId,
            startedAt,
            transcriptionConfig,
          })
        );

        // 3) shared pipeline resources (survive capture restarts).
        const recovery = yield* makeRecoveryWavSet({ dir: wavDir, mode, log });
        const pipeline = yield* Ref.make(initialPipeline);
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
        ): Effect.Effect<void> =>
          Effect.suspend(() => {
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
            return effects.length === 0 ? Effect.void : applyAutoPause(effects);
          });

        const cutGate = yield* Effect.makeSemaphore(1);

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
            // Through the Transcriber seam, the cloud lane WAV-encodes and
            // uploads exactly as before; an on-device lane transcribes here.
            const res = yield* transcriber.transcribeChunk(
              recordingId,
              { chunkIndex: chunk.index, chunkStartMs: chunk.chunkStartMs, source: chunk.source },
              { samples: chunk.samples, sampleRate: CAPTURE_SAMPLE_RATE },
              engine
            );
            if (res.ok) {
              if (res.value.length > 0) {
                yield* appendSegments(res.value);
                // Cache the returned wire rows (best-effort).
                yield* persistBestEffort(recordingId, store.segmentsReceived(res.value));
                // In cloud mode with a non-cloud engine, the server never saw this chunk;
                // mirror the minted rows (best-effort, sequential, before finalize).
                if (mirrorToCore) {
                  yield* mirrorSegmentsToCore(coreClient, log, recordingId, res.value);
                }
              }
              yield* advanceCursor(chunk.index);
            } else if (res.retryable) {
              // Do NOT advance the cursor — the WAV holds this audio; the drain re-sends.
              yield* log.warn('chunk upload retryable — deferred to drain', {
                recordingId,
                index: chunk.index,
                failure: res.failure,
              });
            } else {
              // Non-retryable (404/410/422/…): the segment is lost but the recording
              // continues; let the cursor pass so the drain does not re-try a doomed chunk.
              yield* log.warn('chunk upload permanently failed — segment lost', {
                recordingId,
                index: chunk.index,
                failure: res.failure,
              });
              yield* advanceCursor(chunk.index);
            }
          });

        // Dual ticks publish only complete mic/system pairs so recovery cannot
        // assign a shared chunk index to the other source after a mic stall.
        const periodicCut = mode === 'dual' ? cutPaired : cutAll;
        const flush: Effect.Effect<void> = cutGate.withPermits(1)(
          Ref.modify(pipeline, periodicCut).pipe(
            Effect.flatMap(chunks => Effect.forEach(chunks, uploadChunk, { discard: true })),
            Effect.zipRight(
              Effect.all([
                Ref.get(acceptedSamplesRef),
                Clock.currentTimeMillis,
                Ref.get(pausedRef),
              ]).pipe(
                Effect.flatMap(([samples, now, paused]) =>
                  paused
                    ? Effect.void
                    : setState({ elapsedMs: mediaDurationMs(samples), elapsedAt: now })
                )
              )
            )
          )
        );

        // Once capture is quiescent, cut every remaining complete chunk. Unequal
        // final lane lengths are safe here and must match recovery's final order.
        const flushComplete: Effect.Effect<void> = Ref.modify(pipeline, cutAll).pipe(
          Effect.flatMap(chunks => Effect.forEach(chunks, uploadChunk, { discard: true }))
        );

        // Graceful-stop only: emit each source's sub-CHUNK partial tail (one round,
        // mic before system), so the drain re-derives the SAME final sequence.
        const flushTail: Effect.Effect<void> = Ref.modify(pipeline, flushAll).pipe(
          Effect.flatMap(chunks => Effect.forEach(chunks, uploadChunk, { discard: true }))
        );

        const pauseRecording: Effect.Effect<boolean> = frameGate
          .withPermits(1)(
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(state);
              if (current.status !== 'recording') return false;

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
                        recordingId,
                        cause: String(cause),
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
                ? cutGate.withPermits(1)(
                    flushComplete.pipe(Effect.zipRight(flushTail), Effect.as(true))
                  )
                : Effect.succeed(false)
            )
          );

        const resumeRecording: Effect.Effect<boolean> = frameGate.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(state);
            if (current.status !== 'paused') return false;
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
          // REQUEST the stop; do not perform it. The renderer owns the post-stop work (completed
          // analytics, cache invalidation, auto-enhance), so stopping here would finalize the
          // recording into a transcript that never becomes a note — the very thing auto-stop is
          // for. The renderer answers by calling the ordinary stop verb, which lands right back
          // in this fiber's graceful path.
          stop: setState({ autoStopRequested: true }),
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
        yield* Effect.forkScoped(
          Clock.currentTimeMillis.pipe(
            Effect.flatMap(now => applyAutoPause(autoPause.tick(now))),
            Effect.delay(AUTO_STOP_POLL),
            Effect.forever
          )
        );

        // Periodic cut+upload (outer scope: survives capture restarts, drained sequentially).
        const uploadFiber = yield* Effect.forkScoped(
          flush.pipe(Effect.delay(CHUNK_INTERVAL), Effect.forever)
        );

        // Frame consumer: route each frame → recovery WAV + chunk buffer. Never uploads.
        const onFrame = (frame: AudioFrame): Effect.Effect<void> => {
          const lane = laneForFrame(mode, frame.source);
          if (lane === null) return Effect.void;
          return frameGate.withPermits(1)(
            Effect.uninterruptible(
              Ref.get(pausedRef).pipe(
                Effect.flatMap(paused =>
                  paused
                    ? Effect.void
                    : updateLevel(frame.samples).pipe(
                        Effect.zipRight(observeSilence(lane, frame.samples)),
                        Effect.zipRight(recovery.append(lane, frame.samples)),
                        Effect.zipRight(
                          Ref.modify(pipeline, s => {
                            const next = bufferSamples(s, lane, frame.samples);
                            return [next.dropped, next.state] as const;
                          })
                        ),
                        Effect.tap(() =>
                          Ref.update(acceptedSamplesRef, current => ({
                            ...current,
                            [lane === 'mic' ? 'micSamples' : 'systemSamples']:
                              current[lane === 'mic' ? 'micSamples' : 'systemSamples'] +
                              frame.samples.length,
                          }))
                        ),
                        Effect.flatMap(dropped =>
                          dropped > 0
                            ? log.warn(
                                'recording buffer overflow — dropped samples (recovery WAV retains them)',
                                {
                                  recordingId,
                                  dropped,
                                }
                              )
                            : Effect.void
                        )
                      )
                )
              )
            )
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
                    recordingId,
                    reason: 'disconnected',
                    uid: event.uid,
                  });
                } else if (event.kind === 'bind-failed') {
                  yield* micLog.warn('activation_failure', {
                    recordingId,
                    uid: event.uid,
                    os_status: event.osStatus,
                    reason: event.reason,
                    operation: event.operation,
                    fallback: next.desired.kind === 'default' ? 'default' : 'unbound',
                  });
                } else if (event.kind === 'unavailable') {
                  const unavailableAt = yield* Ref.get(unavailableSinceMs);
                  if (unavailableAt === null) yield* Ref.set(unavailableSinceMs, nowMs);
                  yield* micLog.warn('unavailable', { recordingId });
                } else if (event.kind === 'recovered') {
                  const unavailableAt = yield* Ref.get(unavailableSinceMs);
                  yield* Ref.set(unavailableSinceMs, null);
                  yield* micLog.info('recovered', {
                    recordingId,
                    uid: event.uid,
                    duration_ms: unavailableAt === null ? 0 : Math.max(0, nowMs - unavailableAt),
                  });
                } else if (event.kind === 'timeline-jump') {
                  yield* micLog.warn('timeline_jump', {
                    recordingId,
                    gap_ms: event.gapMs,
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
          Effect.tapError((error: CaptureError) =>
            log.warn('capture terminated — restart per policy', { recordingId, error: error._tag })
          ),
          Effect.retry(RESTART_SCHEDULE)
        );

        // Graceful stop wins → fall through to finalize; capture give-up FAILS past here.
        yield* Effect.raceFirst(Deferred.await(stopSignal), captureLoop);

        // ---- graceful stop path ----
        // `onFrame` is atomic once it owns this gate. Crossing it after capture
        // stops guarantees recovery WAVs, chunk buffers, and accepted-sample
        // counters all describe the same final frame boundary.
        yield* frameGate.withPermits(1)(Effect.void);
        const stoppingSamples = yield* Ref.get(acceptedSamplesRef);
        const stoppingAt = yield* Clock.currentTimeMillis;
        yield* SubscriptionRef.set(level, 0);
        yield* setState({
          status: 'stopping',
          elapsedMs: mediaDurationMs(stoppingSamples),
          elapsedAt: stoppingAt,
        });
        yield* db
          .updateRecoveryOutbox(recordingId, { status: 'finalizing' })
          .pipe(Effect.catchAll(() => Effect.void));
        yield* Fiber.interrupt(uploadFiber); // stop the periodic loop before the final cut
        yield* cutGate.withPermits(1)(
          flushComplete.pipe(
            // any now-complete fixed chunk(s)
            Effect.zipRight(flushTail) // then the sub-CHUNK partial tail (mic before system)
          )
        );

        const endedAt = yield* Clock.currentTimeMillis;
        const acceptedSamples = yield* Ref.get(acceptedSamplesRef);
        const durationMs = mediaDurationMs(acceptedSamples);
        // A non-cloud engine derives the speaker count from the channels
        // (the server derives it from diarization for the cloud engine) and
        // writes it BEFORE finalize so it is durable even if finalize parks the
        // row for the drain (whose max-merge can only raise it).
        if (engine.engine !== 'cloud') {
          const { segments } = yield* SubscriptionRef.get(state);
          yield* persistBestEffort(
            recordingId,
            store.recordingMetaMerged(recordingId, {
              detectedSpeakerCount: detectedSpeakerCountFor(mode, segments),
            })
          );
        }
        // `stagingExpected` means "the cloud engine transcribed and main
        // will stage the WAVs for the finalize pass". A non-cloud engine sends
        // false so core settles the finalize row as skipped at once — no
        // awaiting-upload readiness gate and no server re-transcription.
        const finalizeRes = yield* coreClient.finalizeRecording(recordingId, {
          endedAt,
          durationMs,
          stagingExpected: engine.engine === 'cloud',
          transcriptionDeferred: false,
        });
        if (!finalizeRes.ok) {
          yield* log.warn('finalizeRecording failed', {
            recordingId,
            failure: finalizeRes.failure,
          });
        } else {
          // Mark the product-store row completed (best-effort).
          yield* persistBestEffort(
            recordingId,
            store.recordingCompleted(recordingId, { endedAt, durationMs })
          );
        }

        // Delete the WAV + row only when nothing is left to recover —
        // every cut chunk acked and the finalize landed (or the recording is gone).
        const cursor = yield* Ref.get(cursorRef);
        const finalPipeline = yield* Ref.get(pipeline);
        const totalAssigned = finalPipeline.nextIndex;
        // An OOM-valve drop means the cut chunks silently skipped audio
        // that only the recovery WAV still holds — however contiguous the
        // cursor looks, the recording is NOT fully acked and the WAV must
        // survive this stop for the drain.
        const droppedTotal = droppedSamples(finalPipeline);
        const allAcked =
          droppedTotal === 0 &&
          (cursor === null ? totalAssigned === 0 : cursor + 1 === totalAssigned);
        const recordingGone = !finalizeRes.ok && !finalizeRes.retryable;
        if ((finalizeRes.ok && allAcked) || recordingGone) {
          yield* recovery.finalizeAndClose;
          if (recordingGone) {
            yield* Effect.sync(() => fs.rmSync(wavDir, { recursive: true, force: true }));
            yield* db.deleteRecoveryOutbox(recordingId).pipe(Effect.catchAll(() => Effect.void));
            yield* log.info('recording gone — recovery artifact deleted', {
              recordingId,
              durationMs,
            });
          } else {
            // Stage the full-session WAVs for the finalize (diarization) pass
            // before deleting recovery data, in a daemon fiber so stop() resolves now (a full-session
            // upload can take minutes; the renderer must not sit in "stopping"). Staged, staging
            // disabled, or deterministically rejected → delete exactly as before; a transient
            // failure (network, sign-out mid-upload) parks the row + WAVs for the next-session
            // drain, which re-stages and then deletes.
            yield* Effect.forkDaemon(
              Effect.gen(function* () {
                // Only the cloud engine stages — a device-transcribed recording
                // must never be re-transcribed server-side, so its WAVs are not even
                // read; it takes the 'staging-disabled' abandon path (core answers
                // `unchanged` for the already-skipped finalize row) and deletes.
                const lanes =
                  engine.engine === 'cloud'
                    ? yield* Effect.sync(() => readStagingLanes(wavDir, durationMs))
                    : null;
                const res =
                  lanes === null || lanes.length === 0
                    ? ({ ok: true, value: { staged: false } } as const)
                    : yield* coreClient.stageRecordingAudio(recordingId, lanes);
                if (res.ok || !res.retryable) {
                  const abandon =
                    lanes !== null && lanes.length === 0
                      ? yield* coreClient.abandonRecordingStaging(recordingId, 'no-audio')
                      : res.ok && !res.value.staged
                        ? yield* coreClient.abandonRecordingStaging(recordingId, 'staging-disabled')
                        : !res.ok
                          ? yield* coreClient.abandonRecordingStaging(recordingId, 'upload-failed')
                          : null;
                  const abandonRecordingGone =
                    abandon !== null &&
                    !abandon.ok &&
                    abandon.failure.kind === 'http' &&
                    (abandon.failure.status === 404 || abandon.failure.status === 410);
                  if (abandon && !abandon.ok && !abandonRecordingGone) {
                    yield* db
                      .updateRecoveryOutbox(recordingId, {
                        status: 'finalizing',
                        lastError: 'staging-abandon-incomplete',
                      })
                      .pipe(Effect.catchAll(() => Effect.void));
                    yield* log.warn('staging abandon incomplete — WAVs parked for drain', {
                      recordingId,
                      failure: abandon.failure,
                    });
                    return;
                  }
                  yield* Effect.sync(() => fs.rmSync(wavDir, { recursive: true, force: true }));
                  yield* db
                    .deleteRecoveryOutbox(recordingId)
                    .pipe(Effect.catchAll(() => Effect.void));
                  yield* log.info('recording finalized — recovery artifact deleted', {
                    recordingId,
                    durationMs,
                    staged: res.ok && res.value.staged,
                  });
                } else {
                  yield* db
                    .updateRecoveryOutbox(recordingId, {
                      status: 'finalizing',
                      lastError: 'staging-incomplete',
                    })
                    .pipe(Effect.catchAll(() => Effect.void));
                  yield* log.warn('staging incomplete — WAVs parked for drain', {
                    recordingId,
                    failure: res.failure,
                  });
                }
              }).pipe(
                // A defect anywhere above (fs blowup, etc.) must not strand the daemon silently
                // mid-resolve — park for the drain, same as a transient staging failure.
                Effect.catchAllDefect(defect =>
                  db
                    .updateRecoveryOutbox(recordingId, {
                      status: 'finalizing',
                      lastError: 'staging-incomplete',
                    })
                    .pipe(
                      Effect.catchAll(() => Effect.void),
                      Effect.zipRight(
                        log.warn('staging daemon defect — parked for drain', {
                          recordingId,
                          defect,
                        })
                      )
                    )
                )
              )
            );
          }
        } else {
          // finalize retryable, unacked chunks, or overflow-dropped audio →
          // leave the row + WAV for the drain. A drop diverges the live
          // chunk boundaries from the WAV past the first dropped frame, so the
          // cursor is RESET: the drain re-transcribes the FULL recording from
          // the retained WAV (chunk re-sends are idempotent per index).
          const overflowed = droppedTotal > 0;
          yield* db
            .updateRecoveryOutbox(recordingId, {
              status: 'finalizing',
              ...(overflowed ? { lastChunkIndex: null } : {}),
              lastError: overflowed ? 'buffer-overflow' : 'stop-incomplete',
            })
            .pipe(Effect.catchAll(() => Effect.void));
          yield* log.warn('recording stopped with unresolved chunks — parked for drain', {
            recordingId,
            cursor,
            totalAssigned,
            droppedSamples: droppedTotal,
          });
        }

        // Observable: idle, retaining the finished id + segments as the last snapshot.
        // (The level reset rides the body finalizer above — every exit path.)
        yield* setState({
          status: 'idle',
          elapsedMs: durationMs,
          elapsedAt: null,
          startedAt: null,
          pausedAccumMs: 0,
          micSource: 'system-default',
        });
      });

      return Effect.scoped(body).pipe(
        Effect.catchAll((error: CaptureError) =>
          log.warn('recording ended after capture gave up', { recordingId, error: error._tag })
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

          // Resolve the mode the native binary can actually satisfy
          // (degrade system/dual → mic when system audio is unavailable) and
          // ensure the mic (prompt when not-determined). Fails PermissionError
          // BEFORE any id is minted / row written / child spawned.
          const resolved = yield* permission.effectiveCaptureMode(input.captureMode);
          const effectiveInput: StartRecordingInput = { ...input, captureMode: resolved.mode };

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
          const stopSignal = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          const controls = yield* Ref.make<Option.Option<RecordingControls>>(Option.none());
          const stopping = yield* Ref.make(false);
          const commandSemaphore = yield* Effect.makeSemaphore(1);
          yield* Ref.set(
            activeRef,
            Option.some({
              recordingId,
              stopSignal,
              done,
              controls,
              stopping,
              synchronize: effect => commandSemaphore.withPermits(1)(effect),
            })
          );

          const program = run(
            recordingId,
            effectiveInput,
            resolved.requested,
            initialAlignment,
            initialFallbackReason,
            stopSignal,
            controls
          ).pipe(
            Effect.ensuring(
              Ref.update(activeRef, cur =>
                Option.exists(cur, a => a.recordingId === recordingId) ? Option.none() : cur
              ).pipe(Effect.zipRight(Deferred.succeed(done, undefined)))
            )
          );
          yield* FiberMap.run(fibers, recordingId, program);
          yield* log.info('recording started', {
            recordingId,
            requested: resolved.requested,
            mode: resolved.mode,
            degraded: resolved.degraded,
          });
          return recordingId;
        })
      );

    const stop: RecordingServiceApi['stop'] = recordingId =>
      Ref.get(activeRef).pipe(
        Effect.flatMap(current =>
          Option.isNone(current) || current.value.recordingId !== recordingId
            ? log.warn('stop: no matching active recording', { recordingId })
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
