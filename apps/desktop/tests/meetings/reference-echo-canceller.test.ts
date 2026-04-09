import { describe, expect, it } from "vitest";
import { ReferenceEchoCanceller } from "../../src/main/meetings/reference-echo-canceller";

const SAMPLE_RATE = 48_000;
const FRAME_LENGTH = 1024;

describe("ReferenceEchoCanceller", () => {
  it("returns capture audio unchanged when no reference history exists", () => {
    const canceller = new ReferenceEchoCanceller();
    const capture = createSineWave(FRAME_LENGTH, 330, 0.12);

    const cleaned = canceller.processCaptureFrame(capture);

    expect(Array.from(cleaned)).toEqual(Array.from(capture));
  });

  it("reduces delayed far-end echo from capture frames", () => {
    const frameCount = 48;
    const totalSamples = frameCount * FRAME_LENGTH;
    const delaySamples = 1_440;
    const canceller = new ReferenceEchoCanceller({
      sampleRate: SAMPLE_RATE,
      maxDelayMs: 120,
      historyMs: 300,
    });
    const reference = createNoise(totalSamples + FRAME_LENGTH, 0.18, 7);
    const nearEnd = createSineWave(totalSamples, 310, 0.08);

    let rawError = 0;
    let cleanedError = 0;
    let measuredFrames = 0;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const start = frameIndex * FRAME_LENGTH;
      const systemFrame = reference.subarray(start, start + FRAME_LENGTH);
      const nearEndFrame = nearEnd.subarray(start, start + FRAME_LENGTH);
      const echoFrame = scaleSignal(
        sliceSignal(reference, start - delaySamples, FRAME_LENGTH),
        0.72,
      );
      const captureFrame = mixSignals(nearEndFrame, echoFrame);

      canceller.ingestReferenceFrame(systemFrame);
      const cleaned = canceller.processCaptureFrame(captureFrame);

      if (start >= delaySamples + FRAME_LENGTH) {
        rawError += meanSquaredError(captureFrame, nearEndFrame);
        cleanedError += meanSquaredError(cleaned, nearEndFrame);
        measuredFrames += 1;
      }
    }

    expect(measuredFrames).toBeGreaterThan(20);
    expect(cleanedError).toBeLessThan(rawError * 0.65);
  });

  it("keeps unrelated capture audio mostly intact", () => {
    const frameCount = 24;
    const totalSamples = frameCount * FRAME_LENGTH;
    const canceller = new ReferenceEchoCanceller();
    const reference = createNoise(totalSamples + FRAME_LENGTH, 0.18, 19);
    const unrelatedCapture = createSineWave(totalSamples, 880, 0.1);

    let accumulatedDelta = 0;
    let sampleCount = 0;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const start = frameIndex * FRAME_LENGTH;
      const systemFrame = reference.subarray(start, start + FRAME_LENGTH);
      const captureFrame = unrelatedCapture.subarray(
        start,
        start + FRAME_LENGTH,
      );

      canceller.ingestReferenceFrame(systemFrame);
      const cleaned = canceller.processCaptureFrame(captureFrame);

      accumulatedDelta += meanAbsoluteDifference(cleaned, captureFrame);
      sampleCount += 1;
    }

    expect(sampleCount).toBe(frameCount);
    expect(accumulatedDelta / sampleCount).toBeLessThan(0.01);
  });
});

function createSineWave(
  sampleCount: number,
  frequencyHz: number,
  amplitude: number,
): Float32Array {
  const output = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    output[index] =
      Math.sin((2 * Math.PI * frequencyHz * index) / SAMPLE_RATE) * amplitude;
  }

  return output;
}

function createNoise(
  sampleCount: number,
  amplitude: number,
  seed: number,
): Float32Array {
  const next = createPrng(seed);
  const output = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    output[index] = (next() * 2 - 1) * amplitude;
  }

  return output;
}

function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function sliceSignal(
  signal: Float32Array,
  startIndex: number,
  length: number,
): Float32Array {
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const sourceIndex = startIndex + index;
    if (sourceIndex >= 0 && sourceIndex < signal.length) {
      output[index] = signal[sourceIndex];
    }
  }

  return output;
}

function scaleSignal(signal: Float32Array, scale: number): Float32Array {
  const output = new Float32Array(signal.length);
  for (let index = 0; index < signal.length; index += 1) {
    output[index] = signal[index] * scale;
  }

  return output;
}

function mixSignals(
  primary: Float32Array,
  secondary: Float32Array,
): Float32Array {
  const output = new Float32Array(primary.length);
  for (let index = 0; index < primary.length; index += 1) {
    output[index] = primary[index] + secondary[index];
  }

  return output;
}

function meanSquaredError(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    total += delta * delta;
  }

  return total / left.length;
}

function meanAbsoluteDifference(
  left: Float32Array,
  right: Float32Array,
): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs(left[index] - right[index]);
  }

  return total / left.length;
}
