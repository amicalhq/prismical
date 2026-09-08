import { Context, Data, type Effect, type Option, type Queue, type Scope } from "effect";
import type { AudioFrame, MeetingCaptureMode } from "@/types/meeting";

/**
 * The native-capture provider: the Effect wrap that turns
 * the transplanted `audio-capture` helper into a supervised, interruptible
 * stream of decoded audio frames. It owns exactly ONE thing — spawning the
 * child, decoding its 32-byte wire protocol into a bounded frame queue, and
 * reaping it on scope close. The RecordingService consumes a session and
 * layers the WAV writer / cloud upload / outbox on top; restart-on-exit policy
 * (Schedule.exponential + cap, "only while signed in") also lives there and
 * re-acquires a fresh session — this provider surfaces an unexpected exit as a
 * terminal CaptureError rather than restarting silently.
 */

/**
 * Acquire-time failure: the binary could not be located/launched (missing
 * helper, unspawnable command). Fails the scoped `capture` effect itself, so no
 * child and no finalizer are ever registered.
 */
export class CaptureSpawnError extends Data.TaggedError("CaptureSpawnError")<{
  readonly mode: MeetingCaptureMode;
  readonly reason: string;
}> {}

/** The child emitted a process `error` (async spawn failure, IO error). */
export class CaptureCrashError extends Data.TaggedError("CaptureCrashError")<{
  readonly reason: string;
}> {}

/** The child exited on its own — not through our stop/teardown (a crash/kill). */
export class CaptureExitError extends Data.TaggedError("CaptureExitError")<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {}

/**
 * A non-conforming packet reached the decoder (bad version/format/rate/channels/
 * source). The reader throws on the raw callback edge; the wrapper catches it
 * here and tears the capture down so the frame consumer never trips on it.
 */
export class CaptureProtocolError extends Data.TaggedError("CaptureProtocolError")<{
  readonly reason: string;
}> {}

/** The ways a live capture can terminate abnormally (surfaced via `awaitExit`). */
export type CaptureRuntimeError =
  | CaptureCrashError
  | CaptureExitError
  | CaptureProtocolError;

/** Every failure the provider can produce. */
export type CaptureError = CaptureSpawnError | CaptureRuntimeError;

export interface CaptureOptions {
  readonly debugArtifactsDir?: string;
  readonly aecRenderHoldbackMs?: number;
  readonly aecRenderWaitTimeoutMs?: number;
  /** Native-helper fast path; the supervisor still re-asserts the desired binding after spawn. */
  readonly micDeviceUid?: string;
}

export type MicBindingCommand =
  | { readonly cmd: "set-mic"; readonly uid: string; readonly rev: number }
  | { readonly cmd: "follow-default"; readonly rev: number };

export type MicCaptureEvent =
  | {
      readonly kind: "bound";
      readonly uid: string;
      readonly name?: string;
      readonly mode?: string;
      readonly rev?: number;
      readonly reason?: string;
      readonly blackoutMs?: number;
      readonly trimmedMs?: number;
    }
  | { readonly kind: "lost"; readonly uid: string; readonly rev?: number }
  | {
      readonly kind: "bind-failed";
      readonly uid: string;
      readonly osStatus?: number;
      readonly reason?: string;
      readonly operation?: string;
      readonly rev?: number;
    }
  | { readonly kind: "unavailable"; readonly rev?: number }
  | { readonly kind: "recovered"; readonly uid?: string; readonly rev?: number }
  | { readonly kind: "timeline-jump"; readonly gapMs: number; readonly rev?: number };

export interface CaptureSession {
  /** The mode the child was spawned with (drives which `frame.source`s arrive). */
  readonly mode: MeetingCaptureMode;
  /**
   * Unbounded queue of decoded frames across all sources. Each frame identifies
   * its source; a stalled consumer retains every frame in arrival order.
   */
  readonly frames: Queue.Dequeue<AudioFrame>;
  /**
   * The AEC state scraped from the dual-mode stderr `aec=` contract line; None
   * until the helper reports it (mic/system mode never do).
   */
  readonly aec: Effect.Effect<Option.Option<string>>;
  /** Sparse control-plane events emitted by the native helper on stderr. */
  readonly micEvents: Queue.Dequeue<MicCaptureEvent>;
  /** Declaratively assert the desired macOS/Windows microphone binding. A no-op elsewhere. */
  readonly sendMicCommand: (command: MicBindingCommand) => Effect.Effect<void>;
  /**
   * Resolves void on a clean stop (scope close / teardown); fails typed the
   * moment the child crashes, exits unexpectedly, or emits a malformed packet.
   * The consumer races frame consumption against this to react to a dead helper
   * without the queue silently going quiet.
   */
  readonly awaitExit: Effect.Effect<void, CaptureRuntimeError>;
}

export interface CaptureApi {
  /**
   * Spawn the helper for `mode` and hand back a live session. SCOPED: the child
   * is acquired into the caller's Scope and its finalizer reaps it
   * (SIGTERM → grace → SIGKILL) on scope close or interruption, so a session
   * can never outlive its scope or orphan a process.
   */
  readonly capture: (
    mode: MeetingCaptureMode,
    options?: CaptureOptions,
  ) => Effect.Effect<CaptureSession, CaptureSpawnError, Scope.Scope>;
}

export class Capture extends Context.Tag("desktop/recording/Capture")<
  Capture,
  CaptureApi
>() {}
