// Accumulates 16kHz mono PCM frames and decides chunk boundaries: never before the chunk's
// minimum, cut at the first quiet window after it (so we don't slice mid-word), hard cut at
// the chunk's maximum. Plain RMS threshold — deliberately no ML VAD in this implementation.
//
// Give isolated transcription requests enough speech context before the first result.
// The first chunk has a tighter cap to bound initial latency; subsequent chunks
// keep the same minimum and wait longer for a natural pause.

export interface ChunkerProfile {
  /** Maximum recording age at which the first-chunk timing applies. */
  warmupWindowS: number;
  /** Minimum length of the first chunk. */
  warmupMinS: number;
  /** Minimum chunk length after the first chunk. */
  steadyMinS: number;
  /** Hard cut for steady-state chunks (the first chunk caps at its min + 2s). */
  maxS: number;
}

const envNumber = (raw: string | undefined, fallback: number): number => {
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// NEXT_PUBLIC_* reads must be static member expressions for Next's build-time inlining
// (the browser client transpiles app-client from source). The typeof guard keeps non-Next hosts
// (desktop renderer) on the code defaults. Changing these on web = rebuild + redeploy.
export function defaultChunkerProfile(): ChunkerProfile {
  const env = typeof process !== 'undefined';
  return {
    warmupWindowS: envNumber(
      env ? process.env.NEXT_PUBLIC_TRANSCRIBE_WARMUP_WINDOW_S : undefined,
      10
    ),
    warmupMinS: envNumber(env ? process.env.NEXT_PUBLIC_TRANSCRIBE_WARMUP_MIN_S : undefined, 4),
    steadyMinS: envNumber(env ? process.env.NEXT_PUBLIC_TRANSCRIBE_MIN_S : undefined, 4),
    maxS: envNumber(env ? process.env.NEXT_PUBLIC_TRANSCRIBE_MAX_S : undefined, 15),
  };
}

const QUIET_WINDOW_S = 0.3;
const QUIET_RMS = 0.015;

export class ChunkBoundaryPicker {
  private buffers: Float32Array[] = [];
  private samples = 0;
  /** All-time samples pushed (across cut chunks), for the warm-up window check. */
  private totalSamples = 0;
  /** 0-based ordinal of the chunk currently being accumulated. */
  private chunkOrdinal = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly profile: ChunkerProfile = defaultChunkerProfile()
  ) {}

  /** Feed one worklet frame; returns a finished chunk when a boundary is hit, else null. */
  push(frame: Float32Array): Float32Array | null {
    this.buffers.push(frame);
    this.samples += frame.length;
    this.totalSamples += frame.length;
    const seconds = this.samples / this.sampleRate;
    const [minS, maxS] = this.bounds();
    if (seconds < minS) return null;
    if (seconds >= maxS) return this.take();
    return this.recentRms(QUIET_WINDOW_S) < QUIET_RMS ? this.take() : null;
  }

  /** Drain whatever is buffered (recording stopped). */
  flush(): Float32Array | null {
    return this.samples > 0 ? this.take() : null;
  }

  /** Only the first chunk gets the shorter latency cap. */
  private bounds(): [number, number] {
    const { warmupWindowS, warmupMinS, steadyMinS, maxS } = this.profile;
    const elapsedS = this.totalSamples / this.sampleRate;
    const warm = this.chunkOrdinal === 0 && elapsedS < warmupWindowS;
    const minS = warm ? Math.min(steadyMinS, warmupMinS) : steadyMinS;
    return [minS, warm ? Math.min(minS + 2, maxS) : maxS];
  }

  private take(): Float32Array {
    const out = new Float32Array(this.samples);
    let off = 0;
    for (const b of this.buffers) {
      out.set(b, off);
      off += b.length;
    }
    this.buffers = [];
    this.samples = 0;
    this.chunkOrdinal++;
    return out;
  }

  private recentRms(windowS: number): number {
    let need = Math.floor(windowS * this.sampleRate);
    let sum = 0;
    let count = 0;
    for (let i = this.buffers.length - 1; i >= 0 && need > 0; i--) {
      const b = this.buffers[i];
      if (!b) continue;
      const take = Math.min(b.length, need);
      for (let j = b.length - take; j < b.length; j++) {
        const s = b[j] ?? 0;
        sum += s * s;
      }
      count += take;
      need -= take;
    }
    return count ? Math.sqrt(sum / count) : 0;
  }
}
