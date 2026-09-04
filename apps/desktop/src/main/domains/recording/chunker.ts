/**
 * The recording chunker is the pure state that turns a
 * stream of decoded AudioFrames into fixed-cadence, per-source upload chunks.
 *
 * No Effect, no I/O: the RecordingService's frame fiber folds each frame in with
 * `bufferSamples`, and its chunk-cut fiber harvests COMPLETE fixed-size chunks
 * on a Clock tick (`flushAll` emits the sub-`CHUNK_SAMPLES` tail once at stop).
 * Keeping it pure makes the cadence / index / chunkStartMs accounting
 * unit-testable without a clock or a device.
 *
 * Key invariants the recovery drain inherits:
 *  - `nextIndex` is ONE monotonic counter shared across sources — the server's
 *    transcribe idempotency is keyed on (recordingId, chunkIndex), so mic and
 *    system must never collide on an index. Within a tick, mic is cut before
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
 * The fixed chunk cadence — SINGLE SOURCE OF TRUTH for the boundary the live
 * loop and the recovery drain must agree on. RecordingServiceLive cuts on a
 * Clock tick every `CHUNK_INTERVAL_SECONDS`, harvesting only COMPLETE
 * `CHUNK_SAMPLES`-sized chunks (`cutPaired` for dual mode) and carrying the
 * remainder to the next tick; the drain re-derives chunks from the retained WAV
 * by feeding `CHUNK_SAMPLES`-sized windows through this same chunker, so its chunkIndex /
 * chunkStartMs land on the same boundaries — the server dedupes per (recordingId,
 * chunkIndex), so the two MUST match or a re-sent chunk would collide with a
 * different span.
 *
 * Both paths cut fixed complete chunks round-by-round
 * (mic before system) and flush the sub-`CHUNK_SAMPLES` tail exactly ONCE at the
 * end (`flushAll`) — the live path at graceful stop, the drain after its window
 * loop. For identical per-source sample counts the two produce the IDENTICAL chunk
 * sequence (index / source / chunkStartMs / bytes), so a crash-recovery seam
 * continues seamlessly from `lastChunkIndex+1` with no duplicate/gap. (Previously
 * the live tick flushed whatever had accumulated — a VARIABLE span drifting over
 * `CHUNK_SAMPLES` via `delay(5s).forever` — so it diverged from the drain's fixed
 * windows at the seam.)
 *
 * Overflow drops: under a sustained stall the OOM
 * valve (`bufferSamples` drop-newest at `MAX_BUFFERED_SAMPLES`) drops samples
 * the live path never chunks, so live chunk boundaries diverge from the WAV
 * past the first dropped frame. The chunker COUNTS drops per source
 * (`SourceAccum.dropped`, summed by `droppedSamples`); the graceful-stop path
 * treats ANY drop as not-fully-acked, resets the drain cursor, and parks the
 * row (`buffer-overflow`) so the drain re-transcribes the FULL recording from
 * the retained WAV instead of deleting it.
 */
export const CHUNK_INTERVAL_SECONDS = 5;
export const CHUNK_SAMPLES = CHUNK_INTERVAL_SECONDS * CAPTURE_SAMPLE_RATE;

/**
 * Cap on buffered (un-cut) samples per source — the OOM valve (no unbounded
 * backlog). The cut fiber drains every chunk interval, so in normal operation
 * the buffer holds well under one interval; this is only approached under a
 * SUSTAINED upload stall. Excess samples are dropped from the in-memory buffer
 * (they still live in the recovery WAV, so the drain re-sends them) and metered.
 * ~30 s at 48 kHz.
 */
export const MAX_BUFFERED_SAMPLES = 30 * CAPTURE_SAMPLE_RATE;

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
  /** Cumulative samples the OOM valve dropped for this source — any drop means
   * the cut chunks skipped audio only the recovery WAV still holds. */
  readonly dropped: number;
}

export interface PipelineState {
  readonly nextIndex: number;
  readonly mic: SourceAccum;
  readonly system: SourceAccum;
}

const emptyAccum: SourceAccum = { buffers: [], buffered: 0, cut: 0, dropped: 0 };

export const initialPipeline: PipelineState = {
  nextIndex: 0,
  mic: emptyAccum,
  system: emptyAccum,
};

const chunkStartMs = (accum: SourceAccum): number =>
  Math.round((accum.cut / CAPTURE_SAMPLE_RATE) * 1000);

/**
 * Fold one frame's samples into a source's buffer. Returns the next state and
 * how many samples were DROPPED (the OOM valve fired) — the caller meters drops
 * and freezes the drain cursor so the drain re-covers them from the recovery WAV.
 */
export const bufferSamples = (
  state: PipelineState,
  lane: ChunkSource,
  samples: Float32Array
): { readonly state: PipelineState; readonly dropped: number } => {
  const accum = state[lane];
  const headroom = MAX_BUFFERED_SAMPLES - accum.buffered;
  if (headroom <= 0) {
    return {
      state: { ...state, [lane]: { ...accum, dropped: accum.dropped + samples.length } },
      dropped: samples.length,
    };
  }
  const dropped = Math.max(0, samples.length - headroom);
  const kept = dropped === 0 ? samples : samples.subarray(0, headroom);
  const next: SourceAccum = {
    buffers: [...accum.buffers, kept],
    buffered: accum.buffered + kept.length,
    cut: accum.cut,
    dropped: accum.dropped + dropped,
  };
  return { state: { ...state, [lane]: next }, dropped };
};

/** Total samples the OOM valve dropped across both sources — non-zero means the
 * cut chunk sequence is NOT the full recording (only the recovery WAV is). */
export const droppedSamples = (state: PipelineState): number =>
  state.mic.dropped + state.system.dropped;

const flatten = (accum: SourceAccum): Float32Array => {
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
    dropped: accum.dropped,
  };
  return { chunk, state: { ...state, [lane]: next } };
};

/**
 * Flush ALL of a source's remaining buffer as one final (sub-`CHUNK_SAMPLES`)
 * chunk — the partial tail, used ONCE at the end (graceful stop / drain end).
 * Returns `null` when the buffer is empty (silence never uploads).
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
    dropped: accum.dropped,
  };
  return { chunk, state: { ...state, [lane]: next } };
};

/**
 * Harvest every COMPLETE fixed-size chunk available, round by round — mic before
 * system within each round (mic gets the lower index), mirroring
 * `deriveDrainChunks`' round order. Emits 0+ chunks per call and leaves each
 * source's sub-`CHUNK_SAMPLES` remainder buffered for the next tick. Shaped for
 * `Ref.modify`: returns `[chunks, nextState]`. Cut on the Clock tick.
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
 * Periodic dual-mode cut: release only complete mic/system pairs. The faster
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
 * `CHUNK_SAMPLES`): the live path at graceful stop, the drain after its window
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
