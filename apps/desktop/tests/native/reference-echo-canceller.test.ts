import { describe, expect, it } from "vitest";
import { ReferenceEchoCanceller } from "../../src/main/infra/audio-capture/reference-echo-canceller";

/**
 * Pure-DSP smoke for the imported JS fallback echo canceller
 * No processes, no Electron — synthetic signals only.
 */

function rms(samples: Float32Array): number {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / Math.max(1, samples.length));
}

/** Deterministic pseudo-noise via a fixed LCG — no Math.random in fixtures. */
function pseudoNoise(length: number, amplitude: number): Float32Array {
  const out = new Float32Array(length);
  let state = 0x12345678;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = ((state / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

describe("ReferenceEchoCanceller", () => {
  it("passes silence through as silence", () => {
    const canceller = new ReferenceEchoCanceller();
    const silence = new Float32Array(4800);
    const out = canceller.processCaptureFrame(silence);
    expect(Array.from(out).every((sample) => sample === 0)).toBe(true);
  });

  it("attenuates an echo of the ingested reference signal", () => {
    const canceller = new ReferenceEchoCanceller();
    const reference = pseudoNoise(24_000, 0.5); // 500 ms @ 48 kHz
    canceller.ingestReferenceFrame(reference);

    // The capture frame is a scaled copy of the most recent reference audio —
    // a pure echo with no near-end speech.
    const echoScale = 0.6;
    const capture = new Float32Array(4800);
    for (let i = 0; i < capture.length; i += 1) {
      capture[i] = reference[reference.length - capture.length + i] * echoScale;
    }

    const inputRms = rms(capture);
    expect(inputRms).toBeGreaterThan(0.05);

    const out = canceller.processCaptureFrame(capture);
    expect(rms(out)).toBeLessThan(inputRms * 0.15); // > ~16 dB attenuation
  });

  it("leaves uncorrelated capture audio untouched", () => {
    const canceller = new ReferenceEchoCanceller();
    canceller.ingestReferenceFrame(pseudoNoise(24_000, 0.5));

    // Different LCG stream — uncorrelated with the reference.
    const unrelated = new Float32Array(4800);
    let state = 0x0badf00d;
    for (let i = 0; i < unrelated.length; i += 1) {
      state = (Math.imul(state, 22695477) + 1) >>> 0;
      unrelated[i] = ((state / 0xffffffff) * 2 - 1) * 0.3;
    }

    const out = canceller.processCaptureFrame(unrelated);
    // Below the correlation gate the input frame is returned unmodified.
    expect(out).toBe(unrelated);
  });

  it("resets its reference history", () => {
    const canceller = new ReferenceEchoCanceller();
    const reference = pseudoNoise(24_000, 0.5);
    canceller.ingestReferenceFrame(reference);
    canceller.reset();

    const capture = new Float32Array(4800);
    for (let i = 0; i < capture.length; i += 1) {
      capture[i] = reference[reference.length - capture.length + i] * 0.6;
    }
    // With cleared history there is nothing to align against — pass-through.
    const out = canceller.processCaptureFrame(capture);
    expect(out).toBe(capture);
  });
});
