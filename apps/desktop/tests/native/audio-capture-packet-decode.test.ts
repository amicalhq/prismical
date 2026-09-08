import { Effect } from 'effect';
import { makeTestLogger } from '../helpers/test-layers';
import { MainLogger, LoggingTransport } from '../../src/main/infra/logging/service';
import { describe, expect, it } from 'vitest';
import { NativeAudioCaptureClient } from '../../src/main/infra/audio-capture/native-audio-capture-client';
import type { AudioFrame } from '../../src/types/meeting';

/**
 * Golden packet fixtures for the imported native capture wire protocol
 * The 32-byte little-endian header is the contract:
 *
 *   [0]  u8   version          (must be 1)
 *   [1]  u8   source           (1 = mic_raw, 2 = system, 3 = mic_processed)
 *   [2]  u8   format           (must be 1 = float32)
 *   [3]  u8   channels         (must be 1)
 *   [4]  u32  sampleRate       (must be 48000)
 *   [8]  u32  sequenceNum
 *   [12] u32  durationMs
 *   [16] u64  timestampMs
 *   [24] u32  payload length in bytes
 *   [28] u32  sampleStartIndex
 *
 * The client's stdout buffer/parse path is exercised directly — no process
 * spawn, no Electron.
 */

interface PacketFields {
  version?: number;
  source?: number;
  format?: number;
  channels?: number;
  sampleRate?: number;
  sequenceNum?: number;
  durationMs?: number;
  timestampMs?: bigint;
  sampleStartIndex?: number;
  samples?: Float32Array;
}

function buildPacket(fields: PacketFields = {}): Buffer {
  const samples = fields.samples ?? new Float32Array([0, 0.25, -0.25, 1, -1, 0.5]);
  const payload = Buffer.from(samples.buffer.slice(0), 0, samples.byteLength);

  const header = Buffer.alloc(32);
  header.writeUInt8(fields.version ?? 1, 0);
  header.writeUInt8(fields.source ?? 1, 1);
  header.writeUInt8(fields.format ?? 1, 2);
  header.writeUInt8(fields.channels ?? 1, 3);
  header.writeUInt32LE(fields.sampleRate ?? 48_000, 4);
  header.writeUInt32LE(fields.sequenceNum ?? 0, 8);
  header.writeUInt32LE(fields.durationMs ?? 10, 12);
  header.writeBigUInt64LE(fields.timestampMs ?? 0n, 16);
  header.writeUInt32LE(payload.length, 24);
  header.writeUInt32LE(fields.sampleStartIndex ?? 0, 28);

  return Buffer.concat([header, payload]);
}

type ParserHarness = { handleStdoutData(chunk: Buffer): void };

function harness(): {
  feed: (chunk: Buffer) => void;
  frames: AudioFrame[];
} {
  const client = Effect.runSync(
    Effect.gen(function* () {
      return new NativeAudioCaptureClient(
        (yield* MainLogger).scopedSync('audio'),
        yield* LoggingTransport
      );
    }).pipe(Effect.provide(makeTestLogger().layer))
  );
  const frames: AudioFrame[] = [];
  client.on('frame', frame => frames.push(frame));
  const parser = client as unknown as ParserHarness;
  return { feed: chunk => parser.handleStdoutData(chunk), frames };
}

describe('NativeAudioCaptureClient packet decode', () => {
  it('decodes a mic_raw frame with all header fields', () => {
    const { feed, frames } = harness();
    const samples = new Float32Array([0.5, -0.5, 0.125, -0.125]);
    feed(
      buildPacket({
        source: 1,
        sequenceNum: 42,
        durationMs: 10,
        timestampMs: 1_730_000_000_123n,
        sampleStartIndex: 2016,
        samples,
      })
    );

    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.source).toBe('mic_raw');
    expect(frame.sampleRate).toBe(48_000);
    expect(frame.channels).toBe(1);
    expect(frame.sequenceNum).toBe(42);
    expect(frame.durationMs).toBe(10);
    expect(frame.timestampMs).toBe(1_730_000_000_123);
    expect(frame.sampleStartIndex).toBe(2016);
    expect(Array.from(frame.samples)).toEqual(Array.from(samples));
  });

  it('maps source ids 1/2/3 to mic_raw/system/mic_processed', () => {
    const { feed, frames } = harness();
    feed(buildPacket({ source: 1 }));
    feed(buildPacket({ source: 2 }));
    feed(buildPacket({ source: 3 }));
    expect(frames.map(f => f.source)).toEqual(['mic_raw', 'system', 'mic_processed']);
  });

  it('reassembles a frame delivered in arbitrary chunk splits', () => {
    const { feed, frames } = harness();
    const packet = buildPacket({ source: 2, sequenceNum: 7 });

    // Split inside the header, then inside the payload.
    feed(packet.subarray(0, 13));
    expect(frames).toHaveLength(0);
    feed(packet.subarray(13, 40));
    expect(frames).toHaveLength(0);
    feed(packet.subarray(40));
    expect(frames).toHaveLength(1);
    expect(frames[0].source).toBe('system');
    expect(frames[0].sequenceNum).toBe(7);
  });

  it('drains multiple packets from a single chunk in order', () => {
    const { feed, frames } = harness();
    feed(
      Buffer.concat([
        buildPacket({ source: 1, sequenceNum: 1 }),
        buildPacket({ source: 3, sequenceNum: 2 }),
      ])
    );
    expect(frames.map(f => [f.source, f.sequenceNum])).toEqual([
      ['mic_raw', 1],
      ['mic_processed', 2],
    ]);
  });

  it('rejects an unsupported packet version', () => {
    const { feed } = harness();
    expect(() => feed(buildPacket({ version: 2 }))).toThrow(/Unsupported audio packet version: 2/);
  });

  it('rejects an unsupported sample format', () => {
    const { feed } = harness();
    expect(() => feed(buildPacket({ format: 0 }))).toThrow(/Unsupported audio packet format: 0/);
  });

  it('rejects a non-48k or non-mono frame', () => {
    const { feed } = harness();
    expect(() => feed(buildPacket({ sampleRate: 44_100 }))).toThrow(/sampleRate=44100/);
    expect(() => feed(buildPacket({ channels: 2 }))).toThrow(/channels=2/);
  });

  it('rejects an unknown source id', () => {
    const { feed } = harness();
    expect(() => feed(buildPacket({ source: 9 }))).toThrow(/Unsupported audio packet source: 9/);
  });

  it('emits aec-mode from the stderr contract line (fragile regex — do not clean up)', () => {
    const client = Effect.runSync(
      Effect.gen(function* () {
        return new NativeAudioCaptureClient(
          (yield* MainLogger).scopedSync('audio'),
          yield* LoggingTransport
        );
      }).pipe(Effect.provide(makeTestLogger().layer))
    );
    const modes: string[] = [];
    client.on('aec-mode', mode => modes.push(mode));
    const parser = client as unknown as {
      handleStderrData(chunk: Buffer): void;
    };
    parser.handleStderrData(
      Buffer.from('Dual mode capture started: aec=webrtc-aec3\nother line\n')
    );
    expect(modes).toEqual(['webrtc-aec3']);
  });
});
