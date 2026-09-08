/**
 * The recording chunker is the pure state that turns a
 * stream of decoded AudioFrames into fixed-cadence, per-source upload chunks.
 *
 * No Effect, no I/O: the RecordingService's frame fiber folds each frame in with
 * `bufferSamples`, then harvests COMPLETE fixed-size chunks for upload
 * (`flushAll` emits the sub-`CHUNK_SAMPLES` tail at pause or stop).
 * Keeping it pure makes the cadence / index / chunkStartMs accounting
 * unit-testable without a clock or a device.
 *
 * Key invariants the recovery drain inherits:
 *  - `nextIndex` is ONE monotonic counter shared across sources — the server's
 *    transcribe idempotency is keyed on (recordingId, chunkIndex), so mic and
 *    system must never collide on an index. Within a round, mic is cut before
 *    system (mic gets the lower index).
 *  - `chunkStartMs` is per-source cumulative: the offset (ms) of already-cut
 *    audio for THAT source, so each source carries its own timeline.
 */
import type { CapturedAudioSource, MeetingCaptureMode } from '@/types/meeting';

/** The transcribe `source` a chunk carries (a DUAL recording fans both). */
export type ChunkSource = 'mic' | 'system';

/** Native capture is fixed at 48 kHz mono — the packet reader enforces it. */
export const CAPTURE_SAMPLE_RATE = 48_000;

/**
 * Fixed audio span shared by live capture and recovery. Capture cuts complete
 * chunks as samples arrive and queues them for upload. Recovery feeds the same
 * chunker in CHUNK_SAMPLES-sized windows, preserving chunk indices and offsets.
 * Both paths cut mic before system and flush partial tails at pause and stop.
 */
export const CHUNK_INTERVAL_SECONDS = 15;
export const CHUNK_SAMPLES = CHUNK_INTERVAL_SECONDS * CAPTURE_SAMPLE_RATE;

/**
 * Which transcribe lane a decoded frame feeds, or `null` to drop it:
 *  - `mic` mode:    `mic_raw` → 'mic'  (no AEC; `mic_processed` never arrives)
 *  - `system` mode: `system` → 'system'
 *  - `dual` mode:   `mic_processed` → 'mic', `system` → 'system'  — `mic_raw`
 *    is DROPPED (dual consumes the post-AEC3 mic per the helper contract).
 * Any other pairing (a stray source for the mode) is dropped defensively.
 */
export const laneForFrame = (
  mode: MeetingCaptureMode,
  source: CapturedAudioSource
): ChunkSource | null => {
  if (source === 'system') return mode === 'system' || mode === 'dual' ? 'system' : null;
  if (source === 'mic_processed') return mode === 'dual' ? 'mic' : null;
  if (source === 'mic_raw') return mode === 'mic' ? 'mic' : null;
  return null;
};

export interface PendingChunk {
  readonly index: number;
  readonly source: ChunkSource;
  /** Offset (ms) of this chunk's first sample within the source's timeline. */
  readonly chunkStartMs: number;
  readonly samples: Float32Array;
}

interface SourceAccum {
  readonly buffers: readonly Float32Array[];
  readonly buffered: number;
  /** Cumulative samples already cut into chunks for this source (drives chunkStartMs). */
  readonly cut: number;
}

export interface PipelineState {
  readonly nextIndex: number;
  readonly mic: SourceAccum;
  readonly system: SourceAccum;
}

const emptyAccum: SourceAccum = { buffers: [], buffered: 0, cut: 0 };

export const initialPipeline: PipelineState = {
  nextIndex: 0,
  mic: emptyAccum,
  system: emptyAccum,
};

const chunkStartMs = (accum: SourceAccum): number =>
  Math.round((accum.cut / CAPTURE_SAMPLE_RATE) * 1000);

/** Append every captured sample; completed chunks leave the buffer when cut. */
export const bufferSamples = (
  state: PipelineState,
  lane: ChunkSource,
  samples: Float32Array
): PipelineState => {
  const accum = state[lane];
  return {
    ...state,
    [lane]: {
      buffers: [...accum.buffers, samples],
      buffered: accum.buffered + samples.length,
      cut: accum.cut,
    },
  };
};

const flatten = (accum: SourceAccum): Float32Array => {
  if (accum.buffers.length === 1) return accum.buffers[0];
  const out = new Float32Array(accum.buffered);
  let offset = 0;
  for (const part of accum.buffers) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

type CutResult = { readonly chunk: PendingChunk | null; readonly state: PipelineState };

/**
 * Cut ONE fixed `CHUNK_SAMPLES` chunk off a source — the boundary the drain
 * re-derives. Only fires when the source holds a full chunk (`buffered >=
 * CHUNK_SAMPLES`): it takes the first `CHUNK_SAMPLES` samples and LEAVES the
 * remainder buffered for the next cut, so the cadence never drifts. Returns
 * `null` (state unchanged) when the source is short of a full chunk.
 */
const cutFixed = (state: PipelineState, lane: ChunkSource, index: number): CutResult => {
  const accum = state[lane];
  if (accum.buffered < CHUNK_SAMPLES) return { chunk: null, state };
  const all = flatten(accum);
  const chunk: PendingChunk = {
    index,
    source: lane,
    chunkStartMs: chunkStartMs(accum),
    samples: all.subarray(0, CHUNK_SAMPLES),
  };
  const remainder = all.subarray(CHUNK_SAMPLES);
  const next: SourceAccum = {
    buffers: [remainder],
    buffered: remainder.length,
    cut: accum.cut + CHUNK_SAMPLES,
  };
  return { chunk, state: { ...state, [lane]: next } };
};

/**
 * Flush ALL of a source's remaining buffer as one final (sub-`CHUNK_SAMPLES`)
 * chunk — the partial tail at pause, graceful stop, or drain end.
 * Returns `null` when the buffer is empty; buffered silence still uploads.
 */
const flushLane = (state: PipelineState, lane: ChunkSource, index: number): CutResult => {
  const accum = state[lane];
  if (accum.buffered === 0) return { chunk: null, state };
  const samples = flatten(accum);
  const chunk: PendingChunk = { index, source: lane, chunkStartMs: chunkStartMs(accum), samples };
  const next: SourceAccum = {
    buffers: [],
    buffered: 0,
    cut: accum.cut + samples.length,
  };
  return { chunk, state: { ...state, [lane]: next } };
};

/**
 * Harvest every COMPLETE fixed-size chunk available, round by round — mic before
 * system within each round (mic gets the lower index), mirroring
 * `deriveDrainChunks`' round order. Emits 0+ chunks per call and leaves each
 * source's sub-`CHUNK_SAMPLES` remainder buffered for the next frame. Shaped for
 * `Ref.modify`: returns `[chunks, nextState]`.
 */
export const cutAll = (
  state: PipelineState
): readonly [readonly PendingChunk[], PipelineState] => {
  const chunks: PendingChunk[] = [];
  let index = state.nextIndex;
  let next = state;

  // Each round drains at most one full chunk per source; the loop condition
  // guarantees progress (some source holds >= CHUNK_SAMPLES ⇒ it gets cut), so a
  // backlog of several intervals cuts multiple whole chunks in a single call.
  while (next.mic.buffered >= CHUNK_SAMPLES || next.system.buffered >= CHUNK_SAMPLES) {
    const mic = cutFixed(next, 'mic', index);
    if (mic.chunk) {
      chunks.push(mic.chunk);
      index += 1;
      next = mic.state;
    }
    const system = cutFixed(next, 'system', index);
    if (system.chunk) {
      chunks.push(system.chunk);
      index += 1;
      next = system.state;
    }
  }

  return [chunks, { ...next, nextIndex: index }];
};

/**
 * Dual-mode cut: release only complete mic/system pairs. The faster
 * lane remains buffered until its partner reaches the same fixed boundary, so
 * live upload and recovery assign the shared indices to the same sources.
 */
export const cutPaired = (
  state: PipelineState
): readonly [readonly PendingChunk[], PipelineState] => {
  const chunks: PendingChunk[] = [];
  let index = state.nextIndex;
  let next = state;

  while (next.mic.buffered >= CHUNK_SAMPLES && next.system.buffered >= CHUNK_SAMPLES) {
    const mic = cutFixed(next, 'mic', index);
    if (mic.chunk === null) break;
    const system = cutFixed(mic.state, 'system', index + 1);
    if (system.chunk === null) break;
    chunks.push(mic.chunk, system.chunk);
    index += 2;
    next = system.state;
  }

  return [chunks, { ...next, nextIndex: index }];
};

/**
 * Flush the final partial tail — ONE round: mic then system (at most one
 * sub-`CHUNK_SAMPLES` chunk each), sharing the monotonic index mic-before-system.
 * Run once after the last `cutAll` (so each buffer is already below
 * `CHUNK_SAMPLES`): the live path at pause or stop, the drain after its window
 * loop. Shaped for `Ref.modify`: returns `[chunks, nextState]`.
 */
export const flushAll = (
  state: PipelineState
): readonly [readonly PendingChunk[], PipelineState] => {
  const chunks: PendingChunk[] = [];
  let index = state.nextIndex;
  let next = state;

  const mic = flushLane(next, 'mic', index);
  if (mic.chunk) {
    chunks.push(mic.chunk);
    index += 1;
    next = mic.state;
  }
  const system = flushLane(next, 'system', index);
  if (system.chunk) {
    chunks.push(system.chunk);
    index += 1;
    next = system.state;
  }

  return [chunks, { ...next, nextIndex: index }];
};
