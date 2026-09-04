// Accumulates 16kHz mono PCM frames and decides chunk boundaries: never before the chunk's
// minimum, cut at the first quiet window after it (so we don't slice mid-word), hard cut at
// the chunk's maximum. Plain RMS threshold — deliberately no ML VAD in this implementation.
//
// Warm-up ramp: the minimum sets how soon a chunk's transcript can
// appear, and batching dominates perceived latency. So the
// first chunks cut early — ~1s, ~2s — ramping to the steady-state minimum within the warm-up
// window. Users see the first line in ~2s ("it's working"), and once trust is established the
// steady cadence (3s min) is fine. Warm-up chunks also get a tighter hard cap so continuous
// speech can't defer the first line to the 15s force-cut.

export interface ChunkerProfile {
  /** Seconds from recording start during which the ramp applies. */
  warmupWindowS: number;
  /** Minimum length of the FIRST chunk; doubles per chunk until it reaches steadyMinS. */
  warmupMinS: number;
  /** Minimum chunk length after the ramp. */
  steadyMinS: number;
  /** Hard cut for steady-state chunks (warm-up chunks cap at their min + 2s). */
  maxS: number;
}

const envNumber = (raw: string | undefined, fallback: number): number => {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// NEXT_PUBLIC_* reads must be static member expressions for Next's build-time inlining
// (the browser client transpiles app-client from source). The typeof guard keeps non-Next hosts
// (desktop renderer) on the code defaults. Changing these on web = rebuild + redeploy.
export function defaultChunkerProfile(): ChunkerProfile {
  const env = typeof process !== "undefined";
  return {
    warmupWindowS: envNumber(env ? process.env.NEXT_PUBLIC_TRANSCRIBE_WARMUP_WINDOW_S : undefined, 10),
    warmupMinS: envNumber(env ? process.env.NEXT_PUBLIC_TRANSCRIBE_WARMUP_MIN_S : undefined, 1),
    steadyMinS: envNumber(env ? process.env.NEXT_PUBLIC_TRANSCRIBE_MIN_S : undefined, 3),
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

  /** [min, max] seconds for the chunk being accumulated: 1s, 2s, … doubling up to steady. */
  private bounds(): [number, number] {
    const { warmupWindowS, warmupMinS, steadyMinS, maxS } = this.profile;
    const elapsedS = this.totalSamples / this.sampleRate;
    const warm = elapsedS < warmupWindowS;
    const minS = warm ? Math.min(steadyMinS, warmupMinS * 2 ** this.chunkOrdinal) : steadyMinS;
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
