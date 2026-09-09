import { Context, Data, type Effect, type SubscriptionRef } from 'effect';
import type { MeetingCaptureMode } from '@/types/meeting';
import type { RecordingSegment } from '../transport/service';
import type { PermissionError } from './permission/service';
import type { MicSource } from './mic-alignment';

/**
 * The RecordingService is the session-scoped supervisor that ties native capture
 * → a recovery-scoped WAV → chunked cloud upload → the recovery outbox into one
 * meeting-recording pipeline. It owns a
 * `FiberMap<recordingId>` (each recording a supervised fiber) guarded by a
 * `Semaphore(1)` (one active recording), and an observable `state` that the
 * widget and transcript UI read.
 *
 * Mounted in the SignedInRuntime (workspace-layer.ts): every recording fiber
 * lives in the per-session scope, so sign-out / org-switch / quit interrupts the
 * native child, parks the outbox row `interrupted`, and retains the WAV for the
 * next session's drain — the "logout/quit interrupts every native child
 * with no artifact loss beyond policy" guarantee.
 */

/** A second `start` while capture, finalization, or recovery still owns a recording. */
export class RecordingBusyError extends Data.TaggedError('RecordingBusyError')<{
  readonly activeRecordingId: string;
}> {}

export class RecordingStartError extends Data.TaggedError('RecordingStartError')<{
  readonly reason: 'model-missing' | 'storage-unavailable' | 'suggestion-pending';
}> {}

export type RecordingStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'error';

/**
 * The observable recording state (a SubscriptionRef): the widget waveform/pill
 * and transcript dock read `.get` / subscribe to `.changes`. `segments`
 * accumulates the live transcript segments the cloud lane returns during THIS
 * recording (reset on the next `start`); `elapsedMs` is derived from accepted
 * capture samples, so paused wall time is compressed out of the media timeline.
 */
export interface RecordingState {
  readonly recordingId: string | null;
  /** Live processing jobs still own their recovery audio after capture closes. */
  readonly finalizingRecordingIds: readonly string[];
  /** Completed work stays visible to late subscribers until one window claims it. */
  readonly completedRecordings: readonly {
    readonly recordingId: string;
    readonly noteId: string | null;
    readonly segments: number;
  }[];
  readonly status: RecordingStatus;
  /** The mode actually capturing — may be a degraded `requestedCaptureMode`. */
  readonly captureMode: MeetingCaptureMode | null;
  /**
   * The mode the caller asked for. When it differs from `captureMode` the
   * permission gate degraded system/dual → mic (system audio unavailable), so
   * the UI can show "mic only".
   */
  readonly requestedCaptureMode: MeetingCaptureMode | null;
  /** Whether the configuration fixed at Start spends the workspace's Cloud allowance. */
  readonly spendsCloudQuota?: boolean | null;
  /** Cached allowance supplied at Start; null when unavailable. UI metadata only. */
  readonly quotaRemainingAtStartSeconds?: number | null;
  readonly noteId: string | null;
  readonly segments: readonly RecordingSegment[];
  readonly elapsedMs: number;
  /** Epoch ms when `elapsedMs` was sampled; renderers can tick locally while recording. */
  readonly elapsedAt: number | null;
  /**
   * Recording start (epoch ms), stamped once per recording. Null while idle;
   * renderers use `elapsedMs` + `elapsedAt` for the pause-aware display clock.
   */
  readonly startedAt: number | null;
  /** Paused wall time accumulated so far (widget compatibility/diagnostics). */
  readonly pausedAccumMs: number;
  /** Current microphone-selection mode; unavailable keeps the session alive. */
  readonly micSource: MicSource;
  /**
   * The live "Still there?" countdown, or null when none is running. The decision is
   * made in @prismical/silence inside the capture fiber — this field only publishes it, so the
   * notify layer can project it into an `auto-pause` card exactly the way it projects meeting
   * detection into a `call-detected` one. `deadlineMs` drives the card's loader; the pause itself
   * commits off the audio clock, not this timestamp.
   */
  readonly autoPausePrompt: { readonly graceMs: number; readonly deadlineMs: number } | null;
  /**
   * The paused session has passed its auto-stop deadline. Main requests rather than
   * stopping itself: the renderer owns everything that surrounds a stop — the completed analytics,
   * the transcript/recordings cache invalidations, and auto-enhance — so a main-side
   * stop would finalize the recording into a transcript that never becomes a note, which is the
   * exact outcome auto-stop exists to prevent. The renderer answers with the normal stop verb.
   */
  readonly autoStopRequested: boolean;
}

export const idleRecordingState: RecordingState = {
  recordingId: null,
  finalizingRecordingIds: [],
  completedRecordings: [],
  status: 'idle',
  captureMode: null,
  requestedCaptureMode: null,
  spendsCloudQuota: null,
  quotaRemainingAtStartSeconds: null,
  noteId: null,
  segments: [],
  elapsedMs: 0,
  elapsedAt: null,
  startedAt: null,
  pausedAccumMs: 0,
  micSource: 'system-default',
  autoPausePrompt: null,
  autoStopRequested: false,
};

export interface StartRecordingInput {
  readonly captureMode: MeetingCaptureMode;
  /** Owning note's cloud id (WRITE-checked server-side), or null/omitted for standalone. */
  readonly noteId?: string | null;
  /** Recording title (defaults to "Untitled recording"). */
  readonly title?: string;
  /** Cached workspace allowance for warning projection; never sent to the recording API. */
  readonly quotaRemainingAtStartSeconds?: number | null;
  /**
   * Auto-pause policy for this session, resolved renderer-side from the org's
   * feature gate + tuning. Passed per-start rather than fetched by main: the renderer already
   * holds it, it makes the rules immutable for the session's lifetime, and main's recording
   * service stays free of policy lookups. Omitted ⇒ the feature is off.
   */
  readonly autoPause?: {
    readonly silenceSeconds: number;
    readonly graceSeconds: number;
    readonly autoStopAfterPausedMinutes: number;
  };
}

export interface RecordingServiceApi {
  /**
   * Resolve the effective capture mode through the permission gate:
   * degrade system/dual → mic when system audio is unavailable, prompt/ensure
   * the mic), then mint a recordingId, open the recovery-outbox row BEFORE the
   * first frame, create the cloud recording, acquire the CaptureSession, and run
   * the capture → WAV → chunk → upload pipeline in a supervised fiber. Returns
   * the minted id. Fails `RecordingBusyError` if a recording is already active,
   * `PermissionError` if the mic is denied, or `RecordingStartError` if the
   * selected local model or durable job storage is unavailable. None spawns capture.
   */
  readonly start: (
    input: StartRecordingInput
  ) => Effect.Effect<string, RecordingBusyError | RecordingStartError | PermissionError>;
  /**
   * Stop capture, drain in-flight uploads, and flush the final partial chunk.
   * Resolves after the initial finalization attempt and durable handoff; the
   * workspace worker owns retries and cleanup. A no-op when
   * `recordingId` is not active.
   */
  readonly stop: (recordingId: string) => Effect.Effect<void>;
  /** Wait for a stopped recording's required work, then claim completion once across windows. */
  readonly claimCompletion: (recordingId: string) => Effect.Effect<boolean>;
  /** Main-only recovery handoff; false refuses completion after a terminal processing failure. */
  readonly resolveCompletion: (recordingId: string, ready: boolean) => Effect.Effect<void>;
  /** Pause the matching active recording without finalizing it. */
  readonly pause: (recordingId: string) => Effect.Effect<boolean>;
  /**
   * "Keep recording" on the auto-pause prompt. Any interaction with that card except
   * its Pause button routes here — touching it proves a human is present, which is the exact
   * question the detector was guessing at — and it suppresses auto-pause for the rest of the
   * session rather than asking again in two minutes.
   */
  readonly keepRecording: (recordingId: string) => Effect.Effect<boolean>;
  /** The auto-pause prompt's explicit Pause button — a consented, user-attributed pause. */
  readonly pauseFromPrompt: (recordingId: string) => Effect.Effect<boolean>;
  /** Resume the matching paused recording, preserving its id and chunk timeline. */
  readonly resume: (recordingId: string) => Effect.Effect<boolean>;
  /** The observable recording state for the widget + transcript UI. */
  readonly state: SubscriptionRef.SubscriptionRef<RecordingState>;
  /**
   * The live capture level: a smoothed 0..1 RMS updated from
   * every audio frame, kept OUT of `state` so the ~12 Hz churn never spams the
   * state subscribers. 0 while nothing is capturing. The dock's waveform push
   * fiber throttles + fans this to the pill.
   */
  readonly level: SubscriptionRef.SubscriptionRef<number>;
}

export class RecordingService extends Context.Tag('desktop/recording/RecordingService')<
  RecordingService,
  RecordingServiceApi
>() {}
