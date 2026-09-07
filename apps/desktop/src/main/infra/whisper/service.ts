import { Context, Data, type Effect } from 'effect';
import type { WhisperDecodeOptions, WorkerTranscription } from './protocol';

/**
 * Why a WhisperEngine call did not succeed:
 *  - `spawn-failed`      the worker never came up: fork threw, the sidecar is missing
 *                        (ENOENT on execPath), or the worker died before its first
 *                        message (whisper.node failed to load at require time).
 *  - `worker-crashed`    the worker exited / errored with a call in flight, or the
 *                        IPC channel refused the message.
 *  - `timeout`           a call exceeded the budget — the worker is presumed stuck
 *                        in a synchronous decode and is killed (the next call re-forks).
 *  - `inference-failed`  the worker answered with an error (model failed to load,
 *                        decode threw) — deterministic, so NOT retryable.
 * The local lane maps these onto RecordingLaneFailure (`kind: 'engine'`).
 */
export class WhisperEngineError extends Data.TaggedError('WhisperEngineError')<{
  readonly reason: 'spawn-failed' | 'worker-crashed' | 'timeout' | 'inference-failed';
  readonly detail?: string;
}> {}

/**
 * The boot-scoped whisper.cpp worker host: ONE lazily forked worker under the
 * Node sidecar, one call in flight at a time (Semaphore(1) — `full()` blocks
 * the worker's event loop anyway), the loaded model cached by path and
 * re-initialized on change, killed when the boot scope closes. Boot-scoped
 * because a loaded model is device state worth keeping across workspace
 * rebuilds (org switch / sign-out) and both modes use it.
 */
export interface WhisperEngineApi {
  /**
   * Load `modelPath` into the worker (forking it first if needed). A no-op
   * when that path is already loaded; a different path frees the old model
   * and loads the new one. Remembered across a worker crash: the next
   * `transcribe` re-loads it transparently.
   */
  readonly ensureModel: (modelPath: string) => Effect.Effect<void, WhisperEngineError>;
  /**
   * Decode ONE buffer of 16 kHz mono Float32 audio (resample BEFORE calling —
   * the samples cross IPC as a JSON number array). The worker pads to ≥1.25 s,
   * runs the shared hallucination filter and clamps timestamps;
   * `text` is the kept segments joined.
   */
  readonly transcribe: (
    audio16k: Float32Array,
    options: WhisperDecodeOptions
  ) => Effect.Effect<WorkerTranscription, WhisperEngineError>;
  /** Kill the worker now (the scope finalizer does the same); the next call re-forks. */
  readonly dispose: Effect.Effect<void>;
}

export class WhisperEngine extends Context.Tag('desktop/WhisperEngine')<
  WhisperEngine,
  WhisperEngineApi
>() {}
