import { describe, expect, it } from 'vitest';
import {
  DeadMicWatcher,
  DEAD_MIC_PEAK,
  DEAD_MIC_RECOVERY_SECONDS,
  DEAD_MIC_SECONDS,
} from './dead-mic-watcher';

const RATE = 16_000;
const FRAME = 512; // what the web capture worklet actually emits: 32ms at 16 kHz

function level(amplitude: number, length = FRAME): Float32Array {
  const f = new Float32Array(length);
  for (let i = 0; i < length; i++) f[i] = i % 2 === 0 ? amplitude : -amplitude;
  return f;
}

/** Feed `seconds` of one level; returns every transition `push` reported, in order. */
function feed(w: DeadMicWatcher, amplitude: number, seconds: number, rate = RATE): boolean[] {
  const transitions: boolean[] = [];
  for (let i = 0; i < Math.round((seconds * rate) / FRAME); i++) {
    const t = w.push(level(amplitude), rate);
    if (t !== null) transitions.push(t);
  }
  return transitions;
}

describe('DeadMicWatcher', () => {
  it('starts alive and reports nothing until the threshold is crossed', () => {
    const w = new DeadMicWatcher();
    expect(w.isDead).toBe(false);
    expect(feed(w, 0, DEAD_MIC_SECONDS - 0.5)).toEqual([]);
    expect(w.isDead).toBe(false);
  });

  it('raises once after sustained digital zero, and does not repeat the transition', () => {
    const w = new DeadMicWatcher();
    expect(feed(w, 0, DEAD_MIC_SECONDS + 2)).toEqual([true]);
    expect(w.isDead).toBe(true);
  });

  it('never raises for a quiet but real microphone', () => {
    // A dead-quiet room still sits around 1e-3 — three orders of magnitude over the gate.
    const w = new DeadMicWatcher();
    expect(feed(w, 1e-3, DEAD_MIC_SECONDS * 3)).toEqual([]);
    expect(w.isDead).toBe(false);
  });

  it('gates on magnitude, well clear of the float32 boundary', () => {
    // The exact boundary cannot be hit: the nearest float32 to DEAD_MIC_PEAK is below it, so no
    // Float32Array input can distinguish `>` from `>=`. Assert the decision that IS observable —
    // a trickle an order of magnitude under the gate is no signal, an order over it is signal.
    expect(Math.fround(DEAD_MIC_PEAK)).toBeLessThan(DEAD_MIC_PEAK);
    expect(feed(new DeadMicWatcher(), DEAD_MIC_PEAK / 10, DEAD_MIC_SECONDS + 1)).toEqual([true]);
    expect(feed(new DeadMicWatcher(), DEAD_MIC_PEAK * 10, DEAD_MIC_SECONDS + 1)).toEqual([]);
  });

  it('clears after sustained signal and can raise again in the same session', () => {
    const w = new DeadMicWatcher();
    expect(feed(w, 0, DEAD_MIC_SECONDS)).toEqual([true]);
    expect(feed(w, 0.05, DEAD_MIC_RECOVERY_SECONDS + 0.1)).toEqual([false]);
    expect(w.isDead).toBe(false);
    expect(feed(w, 0, DEAD_MIC_SECONDS)).toEqual([true]);
    expect(w.isDead).toBe(true);
  });

  it('does not clear on bursts shorter than the recovery window', () => {
    const w = new DeadMicWatcher();
    feed(w, 0, DEAD_MIC_SECONDS);
    // Three bursts, each under the window, each separated by silence that resets the run.
    for (let i = 0; i < 3; i++) {
      expect(feed(w, 0.05, DEAD_MIC_RECOVERY_SECONDS / 2)).toEqual([]);
      expect(feed(w, 0, 0.1)).toEqual([]);
    }
    expect(w.isDead).toBe(true);
  });

  it('ignores an empty frame instead of counting it as silence', () => {
    // The capture path flushes a final frame on pause/stop that is empty when the worklet buffer
    // happens to be drained. Counting it would discard whichever run was accumulating.
    const w = new DeadMicWatcher();
    feed(w, 0, DEAD_MIC_SECONDS);
    expect(w.isDead).toBe(true);
    feed(w, 0.05, DEAD_MIC_RECOVERY_SECONDS - 0.1); // partway through recovery
    expect(w.push(new Float32Array(0), RATE)).toBeNull();
    // The recovery run survived the flush, so a little more audio still clears it.
    expect(feed(w, 0.05, 0.2)).toEqual([false]);
  });

  it('ignores a non-positive sample rate rather than dividing by it', () => {
    const w = new DeadMicWatcher();
    expect(w.push(level(0), 0)).toBeNull();
    expect(w.push(level(0), -1)).toBeNull();
    expect(w.push(level(0), Number.NaN)).toBeNull();
    expect(w.isDead).toBe(false);
  });

  it('treats NaN samples as no signal rather than as audio', () => {
    const w = new DeadMicWatcher();
    const nan = new Float32Array(FRAME).fill(Number.NaN);
    for (let i = 0; i < Math.round((DEAD_MIC_SECONDS * RATE) / FRAME); i++) w.push(nan, RATE);
    expect(w.isDead).toBe(true);
  });

  it('is frame-size and sample-rate independent', () => {
    // The thresholds are in seconds, so a different rate or frame size cannot rescale them.
    const w = new DeadMicWatcher();
    const rate = 48_000;
    const big = new Float32Array(rate * (DEAD_MIC_SECONDS - 1)); // one 3s frame of zeros
    expect(w.push(big, rate)).toBeNull();
    expect(w.push(new Float32Array(rate), rate)).toBe(true); // 1s more crosses 4s
  });
});
