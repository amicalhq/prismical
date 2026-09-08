import { describe, it, expect } from 'vitest';
import { parseWavHeader, pcmPeak, wavPcmPayload, WavParseError } from './wav.js';
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

  it('reports the data offset and exposes the header-free PCM payload', () => {
    const wav = buildTestWav({ sampleCount: 4, fill: 1234 });
    const info = parseWavHeader(wav);
    expect(info.dataOffset).toBe(44);
    expect(info.dataBytes).toBe(8);
    const pcm = wavPcmPayload(wav, info);
    expect(pcm.length).toBe(8);
    expect(pcm.readInt16LE(0)).toBe(1234);
    expect(pcm.readInt16LE(6)).toBe(1234);
    // A view, not a copy: the payload shares memory with the source buffer.
    expect(pcm.buffer).toBe(wav.buffer);
  });

  it('locates the data chunk after an interleaved LIST chunk', () => {
    const plain = buildTestWav({ sampleCount: 2, fill: 7 });
    // Splice a 6-byte (word-aligned to 6) LIST chunk between `fmt ` and `data`.
    const list = Buffer.alloc(8 + 6);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(6, 4);
    const wav = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
    wav.writeUInt32LE(wav.length - 8, 4);
    const info = parseWavHeader(wav);
    expect(info.dataOffset).toBe(44 + list.length);
    expect(info.dataBytes).toBe(4);
    expect(wavPcmPayload(wav, info).readInt16LE(2)).toBe(7);
  });

  it('truncated data chunks clamp the payload to the bytes actually present', () => {
    const wav = buildTestWav({ sampleCount: 100 }).subarray(0, 44 + 10);
    const info = parseWavHeader(wav);
    expect(info.dataBytes).toBe(10);
    expect(wavPcmPayload(wav, info).length).toBe(10);
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
