/**
 * Dead-mic detection.
 *
 * Deliberately NOT SilenceWatcher. That class answers "is anyone talking?" against a tracked,
 * relative noise floor, so it reads a quiet room as silent — which is the whole point of
 * auto-pause. This one answers a different and much narrower question: "is the capture stream
 * delivering any signal at all?" A frame of exact zeros is not a quiet room, it is a broken
 * stream — most commonly the OS revoking the browser's microphone access, where getUserMedia
 * still resolves and the recording UI looks live while the tab records nothing. A real
 * microphone in a dead-quiet room never reads 0; its noise floor sits around 1e-3, three orders
 * of magnitude above the gate below. Only a dead stream, a hardware-muted device, or an idle
 * virtual/loopback device reaches it.
 *
 * The state is NOT a latch. It follows the stream in both directions, because it drives a
 * present-tense warning ("no audio is reaching your microphone") and a stream that recovered is
 * not blocked — telling the user to go fix their system permissions would send them after a
 * problem that no longer exists. The failure this actually detects, a wedged permission, never
 * recovers on its own, so that case still stays raised for as long as it lasts.
 *
 * The two thresholds are asymmetric on purpose: raising takes DEAD_MIC_SECONDS of uninterrupted
 * zeros, clearing takes only DEAD_MIC_RECOVERY_SECONDS of signal. Once samples are flowing the
 * stream is provably alive, so there is nothing to be cautious about in that direction, while a
 * short burst of signal inside a dead stretch cannot clear the warning. That does not make
 * flapping impossible — a stream alternating four seconds of zeros with a full second of audio
 * will raise and clear on every cycle — so a caller that must not re-notify needs its own
 * suppression; it only means brief blips are absorbed.
 *
 * Pure and runtime-agnostic like the rest of this package, and frame-size independent because
 * both constants are in seconds rather than per-frame. Note what that does and does not mean
 * today: browser capture feeds microphone frames; native capture feeds raw microphone frames
 * before echo cancellation. System audio does not contribute to this detector.
 */

/**
 * Peak amplitude at or below which a frame carries no signal whatsoever.
 *
 * The exact boundary is unreachable and therefore untestable from real input: frames are
 * Float32Array, and the nearest float32 to 1e-6 is 9.999999974752427e-7, just BELOW the gate. So
 * `>` versus `>=` here is unobservable — do not read the comparison as a decision. What matters is
 * only the magnitude: a working microphone's noise floor is ~1e-3, three orders of magnitude up.
 *
 * `>` for "audible" does still decide one real case: a NaN sample fails every comparison, so it
 * falls through as no signal rather than being mistaken for audio.
 */
export const DEAD_MIC_PEAK = 1e-6;
/** Uninterrupted zero-signal audio needed to raise the warning. */
export const DEAD_MIC_SECONDS = 4;
/** Uninterrupted signal needed to clear it again. See the asymmetry note above. */
export const DEAD_MIC_RECOVERY_SECONDS = 0.5;

/**
 * Tracks the two mutually exclusive runs — consecutive seconds of no signal, and consecutive
 * seconds of signal — and reports only the transitions between them.
 *
 * `push` returning a transition rather than the current state is the load-bearing part of the
 * API. Both callers turn this into a state write (a React `setState`, a snapshot `publish`), and
 * frames arrive tens of times per second for the entire length of a recording; a caller that read
 * a plain `isDead` getter would have to remember to diff it itself, every time, in both capture
 * paths. Returning `null` for "nothing changed" makes the cheap thing the default one.
 */
export class DeadMicWatcher {
  #silentSeconds = 0;
  #liveSeconds = 0;
  #dead = false;

  /** Whether the stream is currently delivering no signal. */
  get isDead(): boolean {
    return this.#dead;
  }

  /**
   * Observe one captured frame.
   *
   * Returns the NEW state on a transition, or `null` when nothing changed — so a caller can write
   * its state unconditionally on a non-null result and do nothing the rest of the time.
   *
   * An empty frame is ignored rather than counted as silence. The web capture path flushes a
   * final frame on pause and on stop that is empty whenever the worklet's buffer happens to be
   * drained, and treating that as evidence would reset whichever run was accumulating — so a
   * pause landing mid-recovery would throw the recovery away.
   */
  push(frame: Float32Array, sampleRate: number): boolean | null {
    if (frame.length === 0 || !(sampleRate > 0)) return null;
    let peak = 0;
    for (let i = 0; i < frame.length; i++) {
      const a = Math.abs(frame[i] ?? 0);
      if (a > peak) peak = a;
    }
    const seconds = frame.length / sampleRate;
    const audible = peak > DEAD_MIC_PEAK;
    this.#silentSeconds = audible ? 0 : this.#silentSeconds + seconds;
    this.#liveSeconds = audible ? this.#liveSeconds + seconds : 0;
    if (this.#dead) {
      if (this.#liveSeconds < DEAD_MIC_RECOVERY_SECONDS) return null;
      this.#dead = false;
      return false;
    }
    if (this.#silentSeconds < DEAD_MIC_SECONDS) return null;
    this.#dead = true;
    return true;
  }
}
