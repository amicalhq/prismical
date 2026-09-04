import { describe, expect, it } from 'vitest';
import { SilenceWatcher, frameRms } from './silence-watcher';

const RATE = 16_000;
const FRAME = 128; // the AudioWorklet render quantum

/** A frame of constant-amplitude noise-ish signal (alternating sign ⇒ rms == amplitude). */
function level(amplitude: number, length = FRAME): Float32Array {
  const f = new Float32Array(length);
  for (let i = 0; i < length; i++) f[i] = i % 2 === 0 ? amplitude : -amplitude;
  return f;
}

/** Feed `seconds` worth of frames at one level; returns the final silentSeconds. */
function feed(w: SilenceWatcher, amplitude: number, seconds: number, rate = RATE): number {
  const frames = Math.round((seconds * rate) / FRAME);
  let out = 0;
  for (let i = 0; i < frames; i++) out = w.push(level(amplitude), rate);
  return out;
}

describe('frameRms', () => {
  it('is 0 for an empty frame and the amplitude for a square-ish frame', () => {
    expect(frameRms(new Float32Array(0))).toBe(0);
    expect(frameRms(level(0.1))).toBeCloseTo(0.1, 6);
  });
});

describe('SilenceWatcher', () => {
  it('accumulates silence on digital zero', () => {
    const w = new SilenceWatcher();
    expect(feed(w, 0, 5)).toBeCloseTo(5, 1);
  });

  it('accumulates silence on a steady room-tone floor ABOVE the chunker threshold', () => {
    // 0.02 rms sits above the chunker's QUIET_RMS=0.015, so a fixed absolute gate would never fire
    // here — this is the fan/AC room the feature exists for. The floor needs a few seconds to climb
    // from its initial value (FLOOR_DECAY is deliberately slow so speech can't inflate it), which is
    // irrelevant against a 100s threshold; measure the STEADY-STATE rate, not the settling period.
    const w = new SilenceWatcher();
    feed(w, 0.02, 5);
    const settled = w.silentSeconds;
    expect(feed(w, 0.02, 10) - settled).toBeCloseTo(10, 1);
  });

  it('does NOT accumulate silence while someone is talking', () => {
    const w = new SilenceWatcher();
    feed(w, 0.0005, 5); // settle the floor low
    const silent = feed(w, 0.05, 3); // clearly above floor
    expect(silent).toBe(0);
  });

  it('treats a QUIET speaker over a quiet floor as speech, not silence', () => {
    // Below the chunker's 0.015 absolute threshold, but ~20x the tracked floor.
    const w = new SilenceWatcher();
    feed(w, 0.0004, 5);
    expect(feed(w, 0.008, 2)).toBe(0);
  });

  it('resets on ANY above-floor audio, including a back-channel too short to be a phrase', () => {
    // The first implementation demanded 300ms of UNBROKEN voice before resetting, which meant
    // "yeah"/"mhm" never reset the countdown and two people could talk through the whole window.
    // Erring toward not-pausing is the correct direction: a late pause costs seconds, an early one
    // costs audio.
    const w = new SilenceWatcher();
    feed(w, 0.0005, 5);
    feed(w, 0, 30);
    expect(w.silentSeconds).toBeGreaterThan(25);
    feed(w, 0.4, 0.05); // 50ms
    expect(w.silentSeconds).toBe(0);
  });

  it('re-baselines when the room gets quieter', () => {
    const w = new SilenceWatcher();
    feed(w, 0.05, 5); // loud room
    feed(w, 0.002, 3); // moved somewhere quiet
    // The window minimum has followed down, so the new quiet level now reads as silence.
    expect(feed(w, 0.002, 5)).toBeGreaterThan(3);
  });

  it('resets on transcribed speech regardless of level', () => {
    const w = new SilenceWatcher();
    feed(w, 0, 10);
    expect(w.silentSeconds).toBeGreaterThan(5);
    w.noteTranscribedSpeech();
    expect(w.silentSeconds).toBe(0);
  });

  it('counts elapsed independently of silence, and works at 48kHz', () => {
    const w = new SilenceWatcher();
    feed(w, 0, 4, 48_000);
    expect(w.elapsedSeconds).toBeCloseTo(4, 1);
    expect(w.silentSeconds).toBeCloseTo(4, 1);
  });

  it('is inert for empty frames and non-positive sample rates', () => {
    const w = new SilenceWatcher();
    expect(w.push(new Float32Array(0), RATE)).toBe(0);
    expect(w.push(level(0), 0)).toBe(0);
    expect(w.elapsedSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Adversarial regression cases. Each FAILED against the original
// one-pole-follower implementation.
// ---------------------------------------------------------------------------
describe('SilenceWatcher — adversarial regressions', () => {
  it('never calls a talking person silent, however long they talk', () => {
    // THE critical one. A one-pole floor follower converges onto sustained speech: measured on the
    // first implementation, 120s of continuous audio produced 116.7s of "silence", i.e. the grace
    // card fired on a single person mid-monologue. Real speech is amplitude-modulated — syllables,
    // stops, breaths — and it is those troughs that hold the windowed minimum down at the room.
    const w = new SilenceWatcher();
    feed(w, 0.0005, 3); // a quiet moment before they start
    let silent = 0;
    for (let i = 0; i < 600; i++) {
      silent = feed(w, i % 2 === 0 ? 0.08 : 0.01, 0.3); // ~3 minutes of syllabic speech
    }
    // The troughs themselves count as silence — correctly — so the run never exceeds one gap. What
    // matters is that it stays orders of magnitude below the 100s threshold instead of marching up
    // to it, which is what the old follower did.
    expect(silent).toBeLessThan(1);
  });

  it('DOES eventually call a perfectly constant tone silent — that is room tone, by design', () => {
    // Documenting the boundary rather than pretending it isn't there: a signal with no variation
    // whatsoever for a full window IS indistinguishable from a fan by level alone. No human voice
    // produces that, and the ASR transcript gate (the second signal) covers the case if one
    // somehow did — the machine cancels the countdown when text comes back.
    const w = new SilenceWatcher();
    feed(w, 0.0005, 3);
    expect(feed(w, 0.05, 180)).toBeGreaterThan(60);
  });

  it('never calls a phrasal speaker silent (speech with breaths between phrases)', () => {
    const w = new SilenceWatcher();
    let silent = 0;
    for (let i = 0; i < 90; i++) {
      silent = feed(w, 0.05, 1.9); // a phrase
      silent = feed(w, 0.001, 0.1); // a breath
    }
    // The breaths are what keep the floor pinned at the room, so every phrase still reads as voice.
    expect(silent).toBeLessThan(1);
  });

  it('hears speech OVER loud room tone', () => {
    const w = new SilenceWatcher();
    feed(w, 0.05, 60); // 60s of loud room tone establishes the floor…
    expect(w.silentSeconds).toBeGreaterThan(55);
    expect(feed(w, 0.4, 5)).toBe(0); // …and someone talking over it is still speech
  });

  it('hears speech riding on a DC bias', () => {
    // Raw RMS includes the bias, so the floor swallows the speech; the level must be DC-removed.
    const w = new SilenceWatcher();
    const biased = (amplitude: number) => {
      const f = new Float32Array(FRAME);
      for (let i = 0; i < FRAME; i++) f[i] = 0.02 + (i % 2 === 0 ? amplitude : -amplitude);
      return f;
    };
    for (let i = 0; i < 30 * (RATE / FRAME); i++) w.push(biased(0), RATE); // DC only
    expect(w.silentSeconds).toBeGreaterThan(25);
    for (let i = 0; i < (RATE / FRAME) * 2; i++) w.push(biased(0.03), RATE); // speech on the bias
    expect(w.silentSeconds).toBe(0);
  });

  it('survives a NaN/Infinity sample instead of being poisoned forever', () => {
    // One bad sample used to make the floor NaN permanently, after which EVERY frame — including
    // shouting — compared false and counted as silence.
    const w = new SilenceWatcher();
    feed(w, 0.0005, 3);
    const bad = new Float32Array(FRAME);
    bad[10] = Number.NaN;
    w.push(bad, RATE);
    const worse = new Float32Array(FRAME);
    worse[10] = Number.POSITIVE_INFINITY;
    w.push(worse, RATE);
    expect(Number.isFinite(w.floor)).toBe(true);
    expect(feed(w, 0.4, 3)).toBe(0); // still hears real audio
  });

  it('does not rescale its history when the sample rate changes mid-session', () => {
    // A Bluetooth headset connecting used to make 40s of silence read as 120s instantly, because
    // the accumulated SAMPLE count was divided by the new rate at read time.
    const w = new SilenceWatcher();
    feed(w, 0, 40, 48_000);
    const before = w.silentSeconds;
    expect(before).toBeCloseTo(40, 0);
    w.push(new Float32Array(128), 16_000);
    expect(w.silentSeconds).toBeCloseTo(before + 128 / 16_000, 3);
  });

  it('behaves the same at any frame size (the three runtimes must agree)', () => {
    // Per-FRAME follower constants made a 480-sample buffer and a 4800-sample buffer disagree 6x.
    const small = new SilenceWatcher();
    const large = new SilenceWatcher();
    for (let i = 0; i < 5 * (48_000 / 480); i++) small.push(level(0.02, 480), 48_000);
    for (let i = 0; i < 5 * (48_000 / 4800); i++) large.push(level(0.02, 4800), 48_000);
    expect(small.silentSeconds).toBeCloseTo(large.silentSeconds, 1);
    expect(small.floor).toBeCloseTo(large.floor, 4);
  });
});
