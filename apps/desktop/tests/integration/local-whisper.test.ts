import { testTelemetryLayer } from '../helpers/telemetry';
/**
 * The real local-whisper integration proof, run via
 * `pnpm test:local-asr`, never in the default suite): LocalWhisperLive over
 * the REAL WhisperEngine host, which forks the REAL built worker
 * (.vite/build/whisper-worker-fork.js) under the DEV Node sidecar and loads
 * the REAL ggml-base.en model — then feeds the committed two-speaker fixture
 * as production-shaped 5 s / 48 kHz chunks and asserts a non-empty transcript
 * persisted through the RecordingStore into a real (in-memory) product DB.
 *
 * Prerequisites are asserted LOUDLY (no conditional skips):
 *   model    ~/.cache/prismical/models/ggml-base.en.bin   (`pnpm fetch-eval-model`)
 *   vad      ~/.cache/prismical/models/ggml-silero-v5.1.2.bin
 *            (`pnpm fetch-eval-model --model silero-vad-v5`; VAD variant only)
 *   sidecar  apps/desktop/node-binaries/<platform>-<arch>/node   (`pnpm download-node`)
 *   worker   apps/desktop/.vite/build/whisper-worker-fork.js    (`pnpm build:worker` —
 *            the test:local-asr script builds it first)
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { asc, eq } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { makeFakeWorkspaceBackend } from '../helpers/fake-recording';
import { fakeModelManagerLayer } from '../helpers/fake-workspace-env';
import { AppModeService, makeAppMode } from '../../src/main/domains/app-mode/service';
import { RECOMMENDED_MODEL_ID, VAD_MODEL_ID } from '../../src/main/domains/models/catalogue';
import { CAPTURE_SAMPLE_RATE, CHUNK_SAMPLES } from '../../src/main/domains/recording/chunker';
import { RecordingStore } from '../../src/main/domains/recording/store';
import { RecordingStoreLive } from '../../src/main/domains/recording/store-live';
import type { RecordingEngine } from '../../src/main/domains/transcriber/engine';
import { LocalWhisperLive } from '../../src/main/domains/transcriber/local';
import { LocalTranscriberLane } from '../../src/main/domains/transcriber/service';
import { makeWhisperEngineLive } from '../../src/main/infra/whisper/engine';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb } from '../../src/main/infra/product-db/service';

const desktopRoot = path.resolve(__dirname, '..', '..');

const modelPath = path.join(homedir(), '.cache', 'prismical', 'models', 'ggml-base.en.bin');
const vadModelPath = path.join(
  homedir(),
  '.cache',
  'prismical',
  'models',
  'ggml-silero-v5.1.2.bin'
);
const nodeBinaryPath = path.join(
  desktopRoot,
  'node-binaries',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'node.exe' : 'node'
);
const workerPath = path.join(desktopRoot, '.vite', 'build', 'whisper-worker-fork.js');
const fixturePath = path.join(desktopRoot, 'tests', 'fixtures', 'two-speaker.wav');

const require16k = (label: string, file: string, fix: string): void => {
  if (!existsSync(file)) {
    throw new Error(`missing ${label}: ${file}\n  fix: ${fix}`);
  }
};

/** The fixture is 16 kHz mono PCM16 — read it and fail loudly on anything else. */
const readFixtureFloat32 = (): Float32Array => {
  const buf = readFileSync(fixturePath);
  assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      assert.deepStrictEqual(fmt, { format: 1, channels: 1, sampleRate: 16_000, bits: 16 });
      const samples = Math.floor(size / 2);
      const out = new Float32Array(samples);
      for (let i = 0; i < samples; i += 1) out[i] = buf.readInt16LE(body + i * 2) / 32768;
      return out;
    }
    offset = body + size + (size % 2);
  }
  throw new Error('no data chunk in fixture');
};

/** 16 kHz → 48 kHz by linear interpolation — the capture-shaped input the lane resamples back. */
const upsampleTo48k = (audio16k: Float32Array): Float32Array => {
  const out = new Float32Array(audio16k.length * 3);
  for (let i = 0; i < audio16k.length; i += 1) {
    const a = audio16k[i];
    const b = i + 1 < audio16k.length ? audio16k[i + 1] : a;
    out[i * 3] = a;
    out[i * 3 + 1] = a + (b - a) / 3;
    out[i * 3 + 2] = a + ((b - a) * 2) / 3;
  }
  return out;
};

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The fixture as production-shaped 5 s / 48 kHz chunks. */
const cutChunks = (
  audio48k: Float32Array
): Array<{ index: number; startMs: number; samples: Float32Array }> => {
  const chunks: Array<{ index: number; startMs: number; samples: Float32Array }> = [];
  for (let offset = 0, index = 0; offset < audio48k.length; offset += CHUNK_SAMPLES, index += 1) {
    chunks.push({
      index,
      startMs: Math.round((offset / CAPTURE_SAMPLE_RATE) * 1000),
      samples: audio48k.subarray(offset, Math.min(offset + CHUNK_SAMPLES, audio48k.length)),
    });
  }
  return chunks;
};

/**
 * Deterministic uniform noise at `amplitude` peak — loud enough to pass the
 * near-silence guard (peak ≥ ~0.0100) yet plainly not speech.
 */
const noiseChunk = (samples: number, amplitude: number): Float32Array => {
  const out = new Float32Array(samples);
  let x = 123456789 >>> 0;
  for (let i = 0; i < samples; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = ((x / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
};

const ENGINE: RecordingEngine = {
  engine: 'local',
  modelId: RECOMMENDED_MODEL_ID,
  byokBaseUrl: null,
  byokModel: null,
};

describe('local whisper end to end (sidecar → worker → whisper.node → product store)', () => {
  it.live('transcribes the two-speaker fixture chunk-by-chunk into a persisted transcript', () =>
    Effect.gen(function* () {
      require16k(
        'eval model',
        modelPath,
        'pnpm --filter @prismical/desktop fetch-eval-model  (downloads ggml-base.en.bin, sha1-verified)'
      );
      require16k('Node sidecar', nodeBinaryPath, 'pnpm --filter @prismical/desktop download-node');
      require16k('worker bundle', workerPath, 'pnpm --filter @prismical/desktop build:worker');
      require16k('audio fixture', fixturePath, 'checked-in file missing — check the repo');

      const chunks = cutChunks(upsampleTo48k(readFixtureFloat32()));
      assert.isAtLeast(chunks.length, 3, 'the ~20 s fixture yields production-shaped 5 s chunks');

      const logger = makeTestLogger();
      const env = Layer.mergeAll(testConfigLayer(), logger.layer, testTelemetryLayer);
      const productDb = makeProductDbLayer({ kind: 'local' }); // ':memory:' via testConfig
      const engineLayer = makeWhisperEngineLive({
        paths: { nodeBinaryPath, workerPath, cwd: desktopRoot },
      });
      const stack = Layer.mergeAll(
        productDb,
        RecordingStoreLive.pipe(Layer.provide(productDb)),
        LocalWhisperLive.pipe(
          Layer.provide(productDb),
          Layer.provide(engineLayer),
          Layer.provide(fakeModelManagerLayer({ [RECOMMENDED_MODEL_ID]: modelPath })),
          Layer.provide(Layer.effect(AppModeService, makeAppMode('local', true))),
          Layer.provide(makeFakeWorkspaceBackend().layer)
        )
      ).pipe(Layer.provide(env));

      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(stack).pipe(Scope.extend(scope), Effect.orDie);
      const lane = Context.get(ctx, LocalTranscriberLane);
      const store = Context.get(ctx, RecordingStore);
      const product = Context.get(ctx, ProductDb);

      const result = yield* Effect.gen(function* () {
        yield* store
          .recordingStarted({
            id: 'rec_local_asr',
            title: 'Local ASR integration',
            captureMode: 'mic',
            status: 'recording',
            noteId: null,
            startedAt: Date.now(),
            transcriptionConfig: {
              provider: 'local-whisper',
              model: `local:${ENGINE.modelId}`,
              language: 'en',
            },
          })
          .pipe(Effect.orDie);

        for (const c of chunks) {
          const res = yield* lane.transcribeChunk(
            'rec_local_asr',
            { chunkIndex: c.index, chunkStartMs: c.startMs, source: 'mic' },
            { samples: c.samples, sampleRate: CAPTURE_SAMPLE_RATE },
            ENGINE
          );
          assert.isTrue(
            res.ok,
            `chunk ${c.index} failed: ${res.ok ? '' : JSON.stringify(res.failure)}`
          );
          if (res.ok && res.value.length > 0) {
            yield* store.segmentsReceived(res.value).pipe(Effect.orDie);
          }
        }

        const rows = yield* Effect.promise(() =>
          product.db
            .select()
            .from(schema.transcriptSegment)
            .where(eq(schema.transcriptSegment.recordingId, 'rec_local_asr'))
            .orderBy(asc(schema.transcriptSegment.segmentOrder))
        );
        return rows;
      }).pipe(
        Effect.tapErrorCause(() =>
          Effect.sync(() => {
            // Surface the captured worker/engine log on failure — the only
            // diagnostics for a native-side problem.
            for (const entry of logger.entries) {
              console.error(`[${entry.scope}:${entry.level}] ${entry.message}`, entry.data ?? '');
            }
          })
        ),
        Effect.ensuring(Scope.close(scope, Exit.void))
      );

      const transcript = result.map(row => row.text).join(' ');
      console.log(`\n[local-asr] persisted segments (${result.length}):`);
      for (const row of result) {
        console.log(
          `  [order ${row.segmentOrder}] ${row.startTimeMs}–${row.endTimeMs}ms: ${row.text}`
        );
      }
      console.log(`[local-asr] transcript: ${transcript}\n`);

      assert.isAbove(result.length, 0, 'a non-empty persisted transcript');
      const normalized = normalize(transcript);
      assert.include(normalized, 'movie');
      assert.include(normalized, 'documentary');
      // The rows are the server-shaped one-per-chunk windows.
      for (const row of result) {
        assert.match(row.id, /^tsg_/);
        assert.strictEqual(row.source, 'mic');
        assert.strictEqual(row.speaker, 'you');
        assert.isTrue(row.segmentOrder >= 1_000_000);
      }
    })
  );

  it.live(
    'with the VAD weights installed the fixture still transcribes, and a guard-bypassing noise chunk yields NO segments',
    () =>
      Effect.gen(function* () {
        require16k(
          'eval model',
          modelPath,
          'pnpm --filter @prismical/desktop fetch-eval-model  (downloads ggml-base.en.bin, sha1-verified)'
        );
        require16k(
          'VAD model',
          vadModelPath,
          'pnpm --filter @prismical/desktop fetch-eval-model --model silero-vad-v5'
        );
        require16k(
          'Node sidecar',
          nodeBinaryPath,
          'pnpm --filter @prismical/desktop download-node'
        );
        require16k('worker bundle', workerPath, 'pnpm --filter @prismical/desktop build:worker');
        require16k('audio fixture', fixturePath, 'checked-in file missing — check the repo');

        const chunks = cutChunks(upsampleTo48k(readFixtureFloat32()));

        const logger = makeTestLogger();
        const env = Layer.mergeAll(testConfigLayer(), logger.layer, testTelemetryLayer);
        const productDb = makeProductDbLayer({ kind: 'local' });
        const engineLayer = makeWhisperEngineLive({
          paths: { nodeBinaryPath, workerPath, cwd: desktopRoot },
        });
        const stack = Layer.mergeAll(
          productDb,
          LocalWhisperLive.pipe(
            Layer.provide(productDb),
            Layer.provide(engineLayer),
            // The fake stands in for the real manager's contract: installedPath
            // only ever answers with a SHA-1-verified file — the defense that
            // matters for `vad_model_path`, where a non-Silero ggml would ABORT
            // the worker process (mapped to a retryable worker-crashed).
            Layer.provide(
              fakeModelManagerLayer({
                [RECOMMENDED_MODEL_ID]: modelPath,
                [VAD_MODEL_ID]: vadModelPath,
              })
            ),
            Layer.provide(Layer.effect(AppModeService, makeAppMode('local', true))),
            Layer.provide(makeFakeWorkspaceBackend().layer)
          )
        ).pipe(Layer.provide(env));

        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(stack).pipe(Scope.extend(scope), Effect.orDie);
        const lane = Context.get(ctx, LocalTranscriberLane);

        const outcome = yield* Effect.gen(function* () {
          const texts: string[] = [];
          for (const c of chunks) {
            const res = yield* lane.transcribeChunk(
              'rec_local_vad',
              { chunkIndex: c.index, chunkStartMs: c.startMs, source: 'mic' },
              { samples: c.samples, sampleRate: CAPTURE_SAMPLE_RATE },
              ENGINE
            );
            assert.isTrue(
              res.ok,
              `chunk ${c.index} failed: ${res.ok ? '' : JSON.stringify(res.failure)}`
            );
            if (res.ok) texts.push(...res.value.map(segment => segment.text));
          }
          // 5 s of uniform noise at 0.02 peak: ABOVE the ~0.0100 near-silence
          // guard, so the engine IS called — and VAD must find no speech spans.
          // The no-VAD arm may hallucinate text on this input (whisper does on
          // non-speech), so only the VAD side is pinned.
          const noise = yield* lane.transcribeChunk(
            'rec_vad_noise',
            { chunkIndex: 0, chunkStartMs: 0, source: 'mic' },
            { samples: noiseChunk(CHUNK_SAMPLES, 0.02), sampleRate: CAPTURE_SAMPLE_RATE },
            ENGINE
          );
          return { texts, noise };
        }).pipe(
          Effect.tapErrorCause(() =>
            Effect.sync(() => {
              for (const entry of logger.entries) {
                console.error(`[${entry.scope}:${entry.level}] ${entry.message}`, entry.data ?? '');
              }
            })
          ),
          Effect.ensuring(Scope.close(scope, Exit.void))
        );

        const transcript = outcome.texts.join(' ');
        console.log(
          `\n[local-asr:vad] transcript (${outcome.texts.length} segments): ${transcript}\n`
        );

        assert.isAbove(outcome.texts.length, 0, 'a non-empty transcript with VAD on');
        const normalized = normalize(transcript);
        assert.include(normalized, 'movie');
        assert.include(normalized, 'documentary');
        assert.isTrue(outcome.noise.ok, 'the noise chunk decodes cleanly');
        if (outcome.noise.ok) {
          assert.deepStrictEqual([...outcome.noise.value], [], 'VAD finds no speech in noise');
        }
        console.log('[local-asr:vad] 5 s noise chunk (peak 0.02, guard bypassed): 0 segments');
      })
  );
});
