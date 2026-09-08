/**
 * The Whisper worker's IPC protocol — shared by the
 * worker entry (whisper-worker-fork.ts, bundled for the Node sidecar) and the
 * main-process host (engine.ts). Types + the one serialization rule only: NO
 * Electron dependencies. Diagnostic frames use the pure shared wire contract.
 *
 *   request   { id, method, args }        main → worker
 *   response  { id, result } | { id, error }   worker → main
 *   log       { type: 'log', ...LogWire }   worker → main (routed to MainLogger)
 *
 * Float32Array arguments cross process IPC as `{ __type: 'Float32Array', data:
 * number[] }` (JSON has no typed arrays). ~240k numbers per 15 s chunk at 16 kHz
 * — which is why the host resamples to 16 kHz BEFORE sending, never 48 kHz.
 */

import type { LogWire, Level } from '@desktop/logging/wire';

export interface WorkerRequest {
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface WorkerResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: string;
}

export type WorkerLogLevel = Level;
export type WorkerLogFrame = LogWire & { readonly type: 'log' };

export interface SerializedFloat32Array {
  readonly __type: 'Float32Array';
  readonly data: number[];
}

export const serializeArg = (arg: unknown): unknown =>
  arg instanceof Float32Array
    ? ({ __type: 'Float32Array', data: Array.from(arg) } satisfies SerializedFloat32Array)
    : arg;

export const isSerializedFloat32Array = (arg: unknown): arg is SerializedFloat32Array =>
  typeof arg === 'object' &&
  arg !== null &&
  (arg as { __type?: unknown }).__type === 'Float32Array' &&
  Array.isArray((arg as { data?: unknown }).data);

export const isWorkerLogFrame = (msg: unknown): msg is WorkerLogFrame =>
  typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'log';

/**
 * whisper.cpp decode options as the addon's `full()` accepts them. The five
 * named keys are what the local lane sends today; every other addon key
 * (`n_threads`, `beam_size`, the `vad_*` family) passes through
 * VERBATIM, so widening the option set never touches the worker or the host.
 */
export interface WhisperDecodeOptions {
  readonly language?: string;
  readonly initial_prompt?: string;
  readonly suppress_blank?: boolean;
  readonly suppress_non_speech_tokens?: boolean;
  readonly no_timestamps?: boolean;
  readonly [key: string]: unknown;
}

/** One whisper segment after the worker's filter + clamp, ms relative to the audio start. */
export interface WorkerTranscriptionSegment {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  readonly noSpeechProb?: number;
}

/** `transcribeAudio`'s answer: the kept segments' text joined + the segments themselves. */
export interface WorkerTranscription {
  readonly text: string;
  readonly segments: readonly WorkerTranscriptionSegment[];
}
