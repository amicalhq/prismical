import { describe, expect, it } from 'vitest';
import { downsample48To16 } from '../../src/main/infra/audio/downsample-48-to-16';

const tone = (frequency: number, length = 48_000): Float32Array =>
  Float32Array.from({ length }, (_, i) => 0.5 * Math.cos((2 * Math.PI * frequency * i) / 48_000));

// Exclude the first/last 10ms: a finite chunk's endpoint extension is a transient.
const rms = (samples: Float32Array): number => {
  let energy = 0;
  for (let i = 160; i < samples.length - 160; i += 1) energy += samples[i] ** 2;
  return Math.sqrt(energy / (samples.length - 320));
};

describe('48 kHz → 16 kHz anti-aliased downsampling', () => {
  it.each([100, 1_000, 3_000, 5_000, 6_000])('preserves a %i Hz speech-band tone', frequency => {
    const output = downsample48To16(tone(frequency));
    expect(rms(output) / (0.5 / Math.sqrt(2))).toBeCloseTo(1, 3);
    // Centered filtering must not shift the chunk's timeline.
    expect(output[8_000]).toBeCloseTo(0.5, 3);
  });

  it.each([8_000, 8_250, 9_000, 10_000, 12_000, 16_000, 20_000, 23_000])(
    'attenuates %i Hz by at least 60 dB before it can alias into speech',
    frequency => {
      const output = downsample48To16(tone(frequency));
      expect(rms(output) / (0.5 / Math.sqrt(2))).toBeLessThan(0.001);
    }
  );

  it.each([0, 1, 2, 3, 4, 71, 144, 145, 146, 48_001, 720_000])(
    'preserves DC and duration for %i input samples, including short pause/stop tails',
    length => {
      const input = new Float32Array(length).fill(0.25);
      const output = downsample48To16(input);
      expect(output.length).toBe(Math.ceil(length / 3));
      expect(output.every(value => Math.abs(value - 0.25) < 1e-6)).toBe(true);
      expect(input.every(value => value === 0.25)).toBe(true);
      expect(output.buffer).not.toBe(input.buffer);
    }
  );

  it('keeps silence silent and does not carry samples between chunks or sources', () => {
    const input = tone(1_000, 480);
    const before = input.slice();
    const first = downsample48To16(input);
    const silence = downsample48To16(new Float32Array(480));
    expect(silence.every(value => value === 0)).toBe(true);
    expect(downsample48To16(input)).toEqual(first);
    expect(input).toEqual(before);
  });
});
