/**
 * WAV encoder, chunker, and recovery-writer units.
 *
 * No device, no cloud: prove the bytes the pipeline produces are valid and the
 * chunk accounting (index / chunkStartMs / per-source fan-out / overflow) is
 * correct — the pieces the RecordingService and the drain both depend on.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';
import type { ScopedLog } from '../../src/main/infra/logging/service';
import { encodeWavPcm16 } from '../../src/main/domains/recording/wav';
import {
  CAPTURE_SAMPLE_RATE,
  CHUNK_SAMPLES,
  MAX_BUFFERED_SAMPLES,
  bufferSamples,
  cutAll,
  cutPaired,
  droppedSamples,
  flushAll,
  initialPipeline,
  laneForFrame,
  type PendingChunk,
} from '../../src/main/domains/recording/chunker';
import { deriveDrainChunks } from '../../src/main/domains/recording/recovery-drain';
import { makeRecoveryWavSet } from '../../src/main/domains/recording/recovery-writer';

// --- WAV parser (the "parse it back" gate) ---------------------------------
interface ParsedWav {
  readonly riffSize: number;
  readonly format: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitDepth: number;
  readonly dataSize: number;
  readonly samples: number[];
}

const parseWav = (bytes: Buffer): ParsedWav => {
  assert.strictEqual(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(bytes.toString('ascii', 12, 16), 'fmt ');
  assert.strictEqual(bytes.toString('ascii', 36, 40), 'data');
  const dataSize = bytes.readUInt32LE(40);
  const samples: number[] = [];
  for (let i = 0; i < dataSize / 2; i += 1) samples.push(bytes.readInt16LE(44 + i * 2));
  return {
    riffSize: bytes.readUInt32LE(4),
    format: bytes.readUInt16LE(20),
    channels: bytes.readUInt16LE(22),
    sampleRate: bytes.readUInt32LE(24),
    byteRate: bytes.readUInt32LE(28),
    blockAlign: bytes.readUInt16LE(32),
    bitDepth: bytes.readUInt16LE(34),
    dataSize,
    samples,
  };
};

describe('encodeWavPcm16', () => {
  it('produces a byte-valid standalone WAV with correct header sizes', () => {
    const wav = Buffer.from(encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 1, -1]), 48_000));
    const parsed = parseWav(wav);
    const dataBytes = 5 * 2;
    assert.strictEqual(parsed.format, 1, 'integer PCM');
    assert.strictEqual(parsed.channels, 1, 'mono');
    assert.strictEqual(parsed.sampleRate, 48_000);
    assert.strictEqual(parsed.byteRate, 48_000 * 2);
    assert.strictEqual(parsed.blockAlign, 2);
    assert.strictEqual(parsed.bitDepth, 16);
    assert.strictEqual(parsed.dataSize, dataBytes, 'data size filled in (not a placeholder)');
    assert.strictEqual(parsed.riffSize, dataBytes + 36);
    assert.strictEqual(wav.length, 44 + dataBytes);
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const wav = Buffer.from(encodeWavPcm16(new Float32Array([2, -2, 0]), 48_000));
    const { samples } = parseWav(wav);
    assert.deepStrictEqual(samples, [32_767, -32_768, 0]);
  });

  it('an empty chunk is still a valid (0-data) WAV', () => {
    const wav = Buffer.from(encodeWavPcm16(new Float32Array([]), 48_000));
    const parsed = parseWav(wav);
    assert.strictEqual(parsed.dataSize, 0);
    assert.strictEqual(wav.length, 44);
  });
});

describe('laneForFrame', () => {
  it('maps each source to a transcribe lane per mode (dual drops mic_raw)', () => {
    assert.strictEqual(laneForFrame('mic', 'mic_raw'), 'mic');
    assert.strictEqual(laneForFrame('mic', 'mic_processed'), null);
    assert.strictEqual(laneForFrame('system', 'system'), 'system');
    assert.strictEqual(laneForFrame('dual', 'mic_processed'), 'mic');
    assert.strictEqual(laneForFrame('dual', 'system'), 'system');
    assert.strictEqual(laneForFrame('dual', 'mic_raw'), null, 'dual consumes post-AEC mic only');
    assert.strictEqual(laneForFrame('system', 'mic_raw'), null);
  });
});

describe('chunker (bufferSamples / cutAll / flushAll)', () => {
  it('cutAll cuts fixed CHUNK_SAMPLES chunks (mic before system) and carries the remainder', () => {
    let state = initialPipeline;
    // 6 s per lane: one full 5 s chunk each + a 1 s remainder that must carry.
    state = bufferSamples(state, 'mic', new Float32Array(6 * CAPTURE_SAMPLE_RATE)).state;
    state = bufferSamples(state, 'system', new Float32Array(6 * CAPTURE_SAMPLE_RATE)).state;

    const [chunks, next] = cutAll(state);
    // mic gets the lower index (cut first per round) — indices are globally unique.
    assert.deepStrictEqual(
      chunks.map(c => [c.source, c.index, c.chunkStartMs, c.samples.length]),
      [
        ['mic', 0, 0, CHUNK_SAMPLES],
        ['system', 1, 0, CHUNK_SAMPLES],
      ]
    );
    assert.strictEqual(next.nextIndex, 2, 'index advances across the tick');
    // The 1 s remainder is retained — a partial never cuts on a tick.
    assert.strictEqual(next.mic.buffered, CAPTURE_SAMPLE_RATE);
    assert.strictEqual(next.system.buffered, CAPTURE_SAMPLE_RATE);
    assert.deepStrictEqual(cutAll(next)[0], [], 'a sub-CHUNK remainder is not cut on a tick');

    // flushAll (graceful stop / drain end) emits the remainder as the partial tail.
    const [tail, done] = flushAll(next);
    assert.deepStrictEqual(
      tail.map(c => [c.source, c.index, c.chunkStartMs, c.samples.length]),
      [
        ['mic', 2, 5000, CAPTURE_SAMPLE_RATE],
        ['system', 3, 5000, CAPTURE_SAMPLE_RATE],
      ]
    );
    assert.strictEqual(done.nextIndex, 4);
    assert.deepStrictEqual(flushAll(done)[0], [], 'nothing left to flush');
  });

  it('cutAll drains a multi-interval backlog into several complete chunks in one call', () => {
    let state = initialPipeline;
    // 11 s buffered on mic (a stalled tick): two full 5 s chunks + a 1 s remainder.
    state = bufferSamples(state, 'mic', new Float32Array(11 * CAPTURE_SAMPLE_RATE)).state;
    const [chunks, next] = cutAll(state);
    assert.deepStrictEqual(
      chunks.map(c => [c.index, c.chunkStartMs, c.samples.length]),
      [
        [0, 0, CHUNK_SAMPLES],
        [1, 5000, CHUNK_SAMPLES],
      ]
    );
    assert.strictEqual(next.mic.buffered, CAPTURE_SAMPLE_RATE, '1 s remainder carried, not cut');
    assert.strictEqual(next.nextIndex, 2);
  });

  it('cutPaired holds the faster dual lane until both complete the boundary', () => {
    let state = initialPipeline;
    state = bufferSamples(state, 'mic', new Float32Array(4 * CAPTURE_SAMPLE_RATE)).state;
    state = bufferSamples(state, 'system', new Float32Array(6 * CAPTURE_SAMPLE_RATE)).state;

    const [waiting, held] = cutPaired(state);
    assert.deepStrictEqual(waiting, []);
    assert.strictEqual(held.mic.buffered, 4 * CAPTURE_SAMPLE_RATE);
    assert.strictEqual(held.system.buffered, 6 * CAPTURE_SAMPLE_RATE);
    assert.strictEqual(held.nextIndex, 0);

    state = bufferSamples(held, 'mic', new Float32Array(2 * CAPTURE_SAMPLE_RATE)).state;
    const [paired, next] = cutPaired(state);
    assert.deepStrictEqual(
      paired.map(c => [c.source, c.index, c.chunkStartMs, c.samples.length]),
      [
        ['mic', 0, 0, CHUNK_SAMPLES],
        ['system', 1, 0, CHUNK_SAMPLES],
      ]
    );
    assert.strictEqual(next.mic.buffered, CAPTURE_SAMPLE_RATE);
    assert.strictEqual(next.system.buffered, CAPTURE_SAMPLE_RATE);
  });

  it('advances chunkStartMs per source cumulatively (fixed cuts + fractional tail)', () => {
    let state = initialPipeline;
    state = bufferSamples(state, 'mic', new Float32Array(CHUNK_SAMPLES)).state; // 5 s
    const first = cutAll(state);
    state = first[1];
    assert.strictEqual(first[0][0].chunkStartMs, 0);
    assert.strictEqual(first[0][0].index, 0);

    state = bufferSamples(state, 'mic', new Float32Array(CHUNK_SAMPLES + 24_000)).state; // 5.5 s more
    const second = cutAll(state);
    assert.strictEqual(second[0][0].chunkStartMs, 5000, 'starts where the previous cut ended');
    assert.strictEqual(second[0][0].index, 1, 'index kept climbing');
    state = second[1];

    const [tail] = flushAll(state);
    assert.strictEqual(tail[0].chunkStartMs, 10_000, 'the tail starts after two 5 s chunks');
    assert.strictEqual(tail[0].samples.length, 24_000, 'the 0.5 s fractional partial');
    assert.strictEqual(tail[0].index, 2);
  });

  it('bounds the per-source buffer and reports dropped samples (OOM valve)', () => {
    const overflow = bufferSamples(
      initialPipeline,
      'mic',
      new Float32Array(MAX_BUFFERED_SAMPLES + 5_000)
    );
    assert.strictEqual(overflow.dropped, 5_000, 'excess is dropped from the in-memory buffer');
    assert.strictEqual(overflow.state.mic.buffered, MAX_BUFFERED_SAMPLES, 'buffer stays capped');
    assert.strictEqual(overflow.state.mic.dropped, 5_000, 'per-source dropped counter accumulates');
    // A further append when already full drops entirely.
    const again = bufferSamples(overflow.state, 'mic', new Float32Array(10));
    assert.strictEqual(again.dropped, 10);
    assert.strictEqual(again.state.mic.dropped, 5_010, 'a full-buffer drop is counted too');
    assert.strictEqual(again.state.system.dropped, 0, 'the other source is untouched');
    assert.strictEqual(droppedSamples(again.state), 5_010);
    // The counter is cumulative for the recording — cut/flush carry it along,
    // so the graceful-stop path can read it after the final flush.
    const [, afterCut] = cutAll(again.state);
    const [, afterFlush] = flushAll(afterCut);
    assert.strictEqual(droppedSamples(afterFlush), 5_010);
  });
});

// The live cut loop and recovery drain must produce the identical chunk sequence
// for the same per-source sample counts, so crash recovery resumes from
// lastChunkIndex+1 with no duplicate or gap. Variable-span `cutAll` chunks do not
// land on CHUNK_SAMPLES boundaries, so this contract requires fixed-size cuts.
describe('live and drain boundary invariant', () => {
  // A per-position ramp so any 1-sample misalignment changes the encoded bytes.
  const ramp = (n: number): Float32Array => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i += 1) a[i] = ((i % 2000) - 1000) / 1000;
    return a;
  };

  // Live simulation: feed lockstep increments across ticks, pairing periodic
  // dual cuts, then use unrestricted cutAll + flushAll at graceful stop.
  const simulateLive = (
    mic: Float32Array | null,
    system: Float32Array | null,
    step: number
  ): readonly PendingChunk[] => {
    let state = initialPipeline;
    const chunks: PendingChunk[] = [];
    const micLen = mic?.length ?? 0;
    const sysLen = system?.length ?? 0;
    const periodicCut = mic !== null && system !== null ? cutPaired : cutAll;
    for (let off = 0; off < micLen || off < sysLen; off += step) {
      if (mic && off < micLen) {
        state = bufferSamples(state, 'mic', mic.subarray(off, Math.min(off + step, micLen))).state;
      }
      if (system && off < sysLen) {
        state = bufferSamples(state, 'system', system.subarray(off, Math.min(off + step, sysLen))).state;
      }
      const [cut, next] = periodicCut(state);
      chunks.push(...cut);
      state = next;
    }
    const [cutFinal, afterCut] = cutAll(state); // grab any now-complete chunk at stop
    chunks.push(...cutFinal);
    const [tail] = flushAll(afterCut); // then the sub-CHUNK partial tail
    chunks.push(...tail);
    return chunks;
  };

  const encode = (c: PendingChunk): string =>
    Buffer.from(encodeWavPcm16(c.samples, CAPTURE_SAMPLE_RATE)).toString('base64');
  const shape = (chunks: readonly PendingChunk[]): unknown =>
    chunks.map(c => ({ index: c.index, source: c.source, chunkStartMs: c.chunkStartMs, wav: encode(c) }));

  const S = CAPTURE_SAMPLE_RATE;
  const micWithSwitchGap = ramp(8 * S);
  // The helper emits real-time silence while rebinding. This gap crosses the
  // first 5 s cut, which is where unequal lane progress used to corrupt the
  // shared mic/system chunk-index interleave during recovery.
  micWithSwitchGap.fill(0, 4 * S, 6 * S);
  const CASES: Array<{ name: string; mic: Float32Array | null; system: Float32Array | null }> = [
    { name: 'exact multiples of CHUNK_SAMPLES (2 chunks each)', mic: ramp(2 * CHUNK_SAMPLES), system: ramp(2 * CHUNK_SAMPLES) },
    { name: 'non-multiples with a partial tail (7 s each)', mic: ramp(7 * S), system: ramp(7 * S) },
    { name: 'mic longer than system (12 s vs 6 s)', mic: ramp(12 * S), system: ramp(6 * S) },
    { name: 'system longer than mic (12 s vs 6 s)', mic: ramp(6 * S), system: ramp(12 * S) },
    { name: 'one source empty (mic-only, 8 s)', mic: ramp(8 * S), system: null },
    {
      name: 'dual mic-switch silence straddles a 5 s cut',
      mic: micWithSwitchGap,
      system: ramp(8 * S),
    },
  ];

  // A non-divisor step so the live sim also exercises the remainder carry.
  const STEP = 70_000;

  for (const c of CASES) {
    it(`live == drain — ${c.name}`, () => {
      const live = simulateLive(c.mic, c.system, STEP);
      const drain = deriveDrainChunks(c.mic, c.system);
      assert.isAbove(live.length, 0, 'produced chunks');
      assert.deepStrictEqual(shape(live), shape(drain), 'identical index/source/chunkStartMs/bytes');
    });
  }

  it('live == drain when system crosses a boundary during a mic callback stall', () => {
    const mic = ramp(8 * S);
    const system = ramp(8 * S);
    mic.fill(0, 4 * S, 6 * S); // silence inserted when the watchdog detects the stall

    let state = initialPipeline;
    const live: PendingChunk[] = [];
    state = bufferSamples(state, 'mic', mic.subarray(0, 4 * S)).state;
    state = bufferSamples(state, 'system', system.subarray(0, 6 * S)).state;

    const [whileStalled, held] = cutPaired(state);
    assert.deepStrictEqual(whileStalled, [], 'system does not consume the mic-first index');

    state = bufferSamples(held, 'mic', mic.subarray(4 * S, 6 * S)).state;
    const [caughtUp, afterCatchUp] = cutPaired(state);
    live.push(...caughtUp);

    state = bufferSamples(afterCatchUp, 'mic', mic.subarray(6 * S)).state;
    state = bufferSamples(state, 'system', system.subarray(6 * S)).state;
    const [complete, afterComplete] = cutAll(state);
    live.push(...complete);
    const [tail] = flushAll(afterComplete);
    live.push(...tail);

    assert.deepStrictEqual(
      shape(live),
      shape(deriveDrainChunks(mic, system)),
      'asynchronous live arrival keeps recovery identities stable'
    );
  });
});

describe('makeRecoveryWavSet (recovery-scoped on-disk WAV)', () => {
  const noopLog: ScopedLog = {
    debug: () => Effect.void,
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
  };
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'prismical-recovery-'));

  it.effect('lazily writes per-source WAVs and finalizes valid, parseable files', () =>
    Effect.gen(function* () {
      const dir = path.join(tmpBase, 'lazy');
      const scope = yield* Scope.make();
      const set = yield* makeRecoveryWavSet({ dir, mode: 'dual', log: noopLog, sampleRate: CAPTURE_SAMPLE_RATE }).pipe(
        Scope.extend(scope)
      );

      yield* set.append('mic', new Float32Array([0.5, -0.5]));
      yield* set.append('system', new Float32Array([1, -1, 0]));
      yield* set.append('mic', new Float32Array([0.25]));

      // Scope close runs the finalizer → headers patched, files retained + valid.
      yield* Scope.close(scope, Exit.void);

      const mic = parseWav(fs.readFileSync(path.join(dir, 'mic.wav')));
      assert.strictEqual(mic.sampleRate, CAPTURE_SAMPLE_RATE);
      assert.strictEqual(mic.dataSize, 3 * 2, 'both mic appends landed');
      assert.deepStrictEqual(mic.samples, [16_383, -16_384, 8_191]);

      const system = parseWav(fs.readFileSync(path.join(dir, 'system.wav')));
      assert.strictEqual(system.dataSize, 3 * 2);
      // A mic-only recording would never create system.wav; dual did.
      assert.isTrue(fs.existsSync(path.join(dir, 'system.wav')));
    })
  );

  it.effect('append after finalizeAndClose is a no-op (idempotent close)', () =>
    Effect.gen(function* () {
      const dir = path.join(tmpBase, 'closed');
      const scope = yield* Scope.make();
      const set = yield* makeRecoveryWavSet({ dir, mode: 'mic', log: noopLog }).pipe(Scope.extend(scope));

      yield* set.append('mic', new Float32Array([0.5]));
      yield* set.finalizeAndClose;
      yield* set.append('mic', new Float32Array([0.9])); // ignored (closed)
      yield* set.finalizeAndClose; // second close is a no-op

      yield* Scope.close(scope, Exit.void);
      const mic = parseWav(fs.readFileSync(path.join(dir, 'mic.wav')));
      assert.strictEqual(mic.dataSize, 2, 'only the pre-close sample is present');
    })
  );
});
