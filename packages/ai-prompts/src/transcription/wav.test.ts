import { describe, it, expect } from 'vitest';
import { parseWavHeader, pcmPeak, WavParseError } from './wav.js';
import { buildTestWav } from '../testing/wav.js';

describe('parseWavHeader', () => {
  it('parses a 1s 16kHz mono PCM wav', () => {
    const info = parseWavHeader(buildTestWav({}));
    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.durationMs).toBe(1000);
  });

  it('computes duration from data length and sample rate', () => {
    // 8000 samples at 16kHz = 500ms
    const info = parseWavHeader(buildTestWav({ sampleCount: 8000 }));
    expect(info.durationMs).toBe(500);
  });

  it('accepts other sample rates (e.g. 48kHz)', () => {
    const info = parseWavHeader(buildTestWav({ sampleRate: 48000, sampleCount: 48000 }));
    expect(info.sampleRate).toBe(48000);
    expect(info.durationMs).toBe(1000);
  });

  it('rejects non-RIFF garbage', () => {
    expect(() => parseWavHeader(Buffer.from('not a wav file at all, sorry'))).toThrow(WavParseError);
  });

  it('rejects stereo', () => {
    expect(() => parseWavHeader(buildTestWav({ channels: 2 }))).toThrow(WavParseError);
  });

  it('rejects non-integer-PCM format codes', () => {
    expect(() => parseWavHeader(buildTestWav({ formatCode: 3 }))).toThrow(WavParseError);
  });

  it('rejects a truncated header', () => {
    expect(() => parseWavHeader(buildTestWav({}).subarray(0, 20))).toThrow(WavParseError);
  });

  it('handles zero-length data (0ms duration)', () => {
    const info = parseWavHeader(buildTestWav({ sampleCount: 0 }));
    expect(info.durationMs).toBe(0);
  });
});

describe('pcmPeak silence guard', () => {
  it('reads 0 on silence and the fill amplitude on speech-like data', () => {
    expect(pcmPeak(buildTestWav({}))).toBe(0);
    expect(pcmPeak(buildTestWav({ fill: 8000 }))).toBe(8000);
  });

  it('a quiet-noise-floor chunk stays under the guard threshold, real speech clears it', () => {
    expect(pcmPeak(buildTestWav({ fill: 100 }))).toBeLessThan(330);
    expect(pcmPeak(buildTestWav({ fill: 1000 }))).toBeGreaterThan(330);
  });
});
