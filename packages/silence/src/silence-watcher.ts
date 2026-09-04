/**
 * Silence detection for auto-pause.
 *
 * Deliberately NOT the chunker's quiet-boundary test. `ChunkBoundaryPicker` asks "is this a safe
 * place to slice so we don't cut mid-word?" against a fixed `QUIET_RMS = 0.015` over 0.3s — a
 * heuristic that is allowed to be wrong, because a bad cut costs an awkward chunk boundary. An
 * auto-pause decision is not allowed to be wrong the same way, and a fixed absolute threshold
 * fails in BOTH directions:
 *
 *  - room tone from a fan / AC / a hot mic gain stage sits ABOVE 0.015 — exactly the "left it
 *    running" rooms, where auto-pause would then never fire;
 *  - a soft speaker on a far-field mic (with the noiseSuppression + autoGainControl we request)
 *    averages BELOW 0.015 between syllables — so a fixed threshold eventually pauses on someone
 *    who is actually talking.
 *
 * So the gate is RELATIVE to a tracked noise floor. AGC makes that mandatory rather than merely
 * nicer: in a quiet room it RAISES gain until the noise floor is audible, so the absolute level of
 * "silence" drifts upward during exactly the situation we want to detect.
 *
 * THE FLOOR IS A WINDOWED MINIMUM, NOT AN AVERAGING FOLLOWER. This is the load-bearing detail. A
 * one-pole follower — even a heavily asymmetric one — converges onto whatever is sustained, so a
 * person talking continuously for a couple of minutes drags the floor up to their own level and is
 * then classified as silent. (Measured on the first implementation of this file: 120s of
 * continuous 0.05-RMS speech ⇒ 116.7s counted as "silence".) A minimum over a sliding window
 * cannot do that: speech has breaths and phrase gaps, and the quietest moment in the last minute is
 * the room, not the speaker. Continuous room tone has no such gaps, so it IS the minimum, and the
 * fan room still reads as silent. That asymmetry is the whole trick.
 *
 * LEVEL IS DC-REMOVED (standard deviation, not raw RMS). A mic with a DC bias otherwise reports a
 * floor that includes the bias, and speech riding on top of it fails the relative test.
 *
 * THE CLOCK IS AUDIO TIME, never `Date.now()` / `setTimeout`. Browsers throttle timers in
 * background tabs while audio keeps flowing, so a wall-clock timer would fire late precisely when
 * the user has tabbed away — the common case. Counting audio also puts the countdown on the same
 * pause-compressed media timeline as chunk offsets and `durationMs`. It is accumulated in SECONDS
 * as it arrives (rather than as a sample count divided at read time) so that a mid-session sample
 * rate change — a Bluetooth headset connecting — cannot retroactively rescale the whole history.
 *
 * Pure and runtime-agnostic: the same class runs in the web renderer (16 kHz worklet frames) and in
 * the desktop MAIN process (48 kHz native frames), and its behaviour is frame-size independent —
 * every constant below is in seconds, never per-frame. See index.ts for the dual-lane rule.
 */

/** Absolute floor: below this we are in digital-ish silence and no relative gate applies. */
export const FRAME_RMS_FLOOR = 3e-4;
/** A frame counts as voice at ~11 dB over the tracked noise floor. */
export const SPEECH_OVER_FLOOR = 3.5;
/** Sliding window the noise floor is the minimum of. Long enough to span phrases and pauses. */
export const FLOOR_WINDOW_S = 60;
/** Resolution of that window: one retained minimum per bucket. */
export const FLOOR_BUCKET_S = 1;

export interface SilenceWatcherOptions {
  /** Overrides for tests; production uses the module constants. */
  readonly speechOverFloor?: number;
  readonly floorWindowS?: number;
}

/**
 * DC-removed level of one frame: the standard deviation, i.e. sqrt(E[x²] - E[x]²). Returns 0 for an
 * empty frame, and **NaN** for a frame containing a non-finite sample — the caller drops those
 * (see `push`). NaN rather than 0 because a pure DC signal legitimately has a level of exactly 0,
 * and conflating the two would make a biased-but-silent mic invisible instead of silent.
 */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] ?? 0;
    sum += s;
    sumSq += s * s;
  }
  const mean = sum / frame.length;
  const variance = sumSq / frame.length - mean * mean;
  return Math.sqrt(Math.max(0, variance));
}

export class SilenceWatcher {
  /** Per-bucket minima; the floor is the smallest of these. */
  private readonly buckets: number[] = [];
  private bucketMin = Infinity;
  private bucketElapsedS = 0;
  /** Uninterrupted silence, in audio seconds — the authoritative clock. */
  private silentS = 0;
  /** All-time audio seconds, for the "never fire in the first N seconds" rule. */
  private elapsedS = 0;
  private readonly speechOverFloor: number;
  private readonly maxBuckets: number;

  constructor(options: SilenceWatcherOptions = {}) {
    this.speechOverFloor = options.speechOverFloor ?? SPEECH_OVER_FLOOR;
    this.maxBuckets = Math.max(1, Math.round((options.floorWindowS ?? FLOOR_WINDOW_S) / FLOOR_BUCKET_S));
  }

  /**
   * Feed one captured frame. Returns the current uninterrupted silent duration in seconds.
   * `sampleRate` is per call so a caller can feed lanes at different rates (desktop is 48 kHz,
   * web 16 kHz) without a second class.
   */
  push(frame: Float32Array, sampleRate: number): number {
    if (frame.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return this.silentS;
    const seconds = frame.length / sampleRate;
    // A frame carrying NaN/Infinity is a broken capture — neither silence nor speech. Drop it
    // rather than let it advance either clock or poison the floor: one NaN sample used to make the
    // floor NaN permanently, after which every comparison failed and even shouting read as silent.
    const level = frameRms(frame);
    if (!Number.isFinite(level)) return this.silentS;

    this.elapsedS += seconds;
    this.trackFloor(level, seconds);

    const floor = this.floor;
    const speechish = level > Math.max(FRAME_RMS_FLOOR, floor * this.speechOverFloor);
    // Reset on ANY above-threshold frame — no sustained-onset requirement. The earlier version
    // demanded 300ms of UNBROKEN voice, which meant back-channels ("yeah", "mhm") never reset the
    // countdown at all and a session could accumulate two minutes of "silence" while two people
    // talked. Erring toward not-pausing is the correct direction for this feature: the cost of a
    // late pause is a few wasted seconds, the cost of an early one is lost audio.
    if (speechish) this.silentS = 0;
    else this.silentS += seconds;
    return this.silentS;
  }

  /** Roll the per-bucket minima that the floor is drawn from. */
  private trackFloor(level: number, seconds: number): void {
    if (level < this.bucketMin) this.bucketMin = level;
    this.bucketElapsedS += seconds;
    if (this.bucketElapsedS < FLOOR_BUCKET_S) return;
    this.buckets.push(this.bucketMin);
    if (this.buckets.length > this.maxBuckets) this.buckets.shift();
    this.bucketMin = Infinity;
    this.bucketElapsedS = 0;
  }

  /**
   * The ASR returned text for audio in this window — someone was talking and the energy gate was
   * wrong. Cancels the countdown regardless of level (the two-signal rule).
   */
  noteTranscribedSpeech(): void {
    this.silentS = 0;
  }

  get silentSeconds(): number {
    return this.silentS;
  }

  get elapsedSeconds(): number {
    return this.elapsedS;
  }

  /**
   * Current noise floor: the minimum level seen in the window, including the bucket still being
   * filled (so the first second of a session already has a usable floor). Exposed for tests and
   * telemetry, not for control flow.
   */
  get floor(): number {
    let min = this.bucketMin;
    for (const b of this.buckets) if (b < min) min = b;
    return Number.isFinite(min) ? min : FRAME_RMS_FLOOR;
  }
}
