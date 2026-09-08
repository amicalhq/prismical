import { makeLogger, makeFilter } from '@desktop/logging';
const wavLog = makeLogger(() => {}, {
  origin: { app: 'prismical', appVersion: 'test', appRunId: 'test-run' },
  source: { runtime: 'main', pid: 1 }, filter: makeFilter({ isDev: true }),
}).service.scopedSync('wav-writer');
/**
 * Recovery-drain tests.
 *
 * Fully headless: a fake WorkspaceBackend lane (records
 * upload/finalize calls, configurable RecordingLaneResults incl. retryable /
 * non-retryable), real recovery WAVs in a temporary directory (written through
 * StreamingWavWriter — finalized AND kill -9 un-patched), a REAL OperationalDb on
 * a temp file (so the outbox lifecycle is real), and TestClock for backoff. NO
 * cloud, NO device.
 *
 * The drain is exercised as one pass = `drainRecoveries(activeId)`; "re-drains
 * next pass" is a second call with the TestClock advanced past the backoff.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  SubscriptionRef,
  TestClock,
} from 'effect';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { fakeSegment, laneFail, laneOk, makeFakeWorkspaceBackend } from '../helpers/fake-recording';
import { makeFakeSettings, makeTranscriberStack } from '../helpers/fake-workspace-env';
import type { DeviceSettings } from '@prismical/desktop-contracts';
import { SyncTranscriptSegmentCreateRequestSchema } from '@prismical/api-contracts';
import { WorkspaceIdentity, type RecoveryOwner } from '../../src/main/runtime/workspace-identity';
import { AppModeService, makeAppMode, type AppMode } from '../../src/main/domains/app-mode/service';
import { TRANSCRIPT_SEGMENTS_PATH } from '../../src/main/domains/recording/segment-mirror';
import { RECOMMENDED_MODEL_ID } from '../../src/main/domains/models/catalogue';
import { resolveRecordingEngine } from '../../src/main/domains/transcriber/engine';
import { mintChunkSegment } from '../../src/main/domains/transcriber/segment';
import {
  LocalTranscriberLane,
  Transcriber,
  type TranscriberLaneApi,
} from '../../src/main/domains/transcriber/service';
import type {
  RecordingLaneResult,
  RecordingSegment,
  TranscribeChunkParams,
} from '../../src/main/domains/transport/service';
import type { MainLogger } from '../../src/main/infra/logging/service';
import { StreamingWavWriter } from '../../src/main/infra/audio/streaming-wav-writer';
import {
  deriveDrainChunks,
  drainRecoveries,
  runRecoveryWorker,
} from '../../src/main/domains/recording/recovery-drain';
import {
  AskStreamError,
  WorkspaceBackend,
  type WorkspaceBackendApi,
} from '../../src/main/domains/transport/service';
import {
  OperationalDb,
  type OperationalDbService,
  type NewRecoveryOutbox,
} from '../../src/main/infra/operational-db/service';
import { OperationalDbLive } from '../../src/main/infra/operational-db/live';
import { idleRecordingState, type RecordingState } from '../../src/main/domains/recording/service';
import * as operationalSchema from '../../src/main/infra/operational-db/schema';
import { RecordingStore } from '../../src/main/domains/recording/store';
import { RecordingStoreLive } from '../../src/main/domains/recording/store-live';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as productSchema from '../../src/main/infra/product-db/schema';
import { ProductDb, type ProductDbService } from '../../src/main/infra/product-db/service';

vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

const ignoreCompletion = () => Effect.void;
const RATE = 48_000;
const seconds = (n: number): Float32Array => new Float32Array(n * RATE).fill(0.25);

/** Write a real recovery WAV via StreamingWavWriter. `finalize:false` leaves
 * the header un-patched (data-size 0) — the on-disk `kill -9` shape. */
const writeWav = (
  dir: string,
  source: 'mic' | 'system',
  samples: Float32Array,
  finalize = true
): Effect.Effect<void> =>
  Effect.promise(async () => {
    fs.mkdirSync(dir, { recursive: true });
    const writer = new StreamingWavWriter(wavLog, path.join(dir, `${source}.wav`), RATE, 1, 16);
    await writer.appendAudio(samples);
    if (finalize) await writer.finalize();
    else await writer.abort();
  });

const assertWavSamples = (wav: Uint8Array, expected: number): void => {
  const buf = Buffer.from(wav);
  assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(buf.readUInt32LE(40), expected * 2, 'data size = samples * 2');
  assert.strictEqual(buf.length, 44 + expected * 2);
};

/** Poll a boolean Effect while letting real async (fs writes, the drain fiber)
 * settle — WITHOUT advancing the (Test) Clock. */
const poll = (cond: Effect.Effect<boolean, unknown>, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const check = Effect.orDie(cond);
    for (let i = 0; i < 400; i += 1) {
      if (yield* check) return;
      yield* Effect.yieldNow();
      yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
    }
    assert.isTrue(yield* check, `poll timed out: ${label}`);
  });

/** Engine knobs for a drain environment: boot mode, stored preference, and injected local lane. */
interface EnvOptions {
  readonly owner?: RecoveryOwner;
  readonly mode?: AppMode;
  readonly transcription?: Partial<DeviceSettings['transcription']>;
  readonly localLane?: Layer.Layer<LocalTranscriberLane, never, MainLogger>;
}

const buildEnv = (coreLayer: Layer.Layer<WorkspaceBackend>, options: EnvOptions = {}) =>
  Effect.gen(function* () {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismical-drain-'));
    const logger = makeTestLogger();
    const config = testConfigLayer({
      userDataDir,
      operationalDbPath: path.join(userDataDir, 'op.db'),
    });
    const scope = yield* Scope.make();
    // A real product store (`:memory:` localDbPath from testConfig) —
    // the ONE const is merged AND provided, so the store shares its instance.
    const productDb = makeProductDbLayer({ kind: 'local' }).pipe(
      Layer.provide(config),
      Layer.provide(logger.layer)
    );
    const owner: RecoveryOwner =
      options.owner ??
      (options.mode === 'local'
        ? { mode: 'local' }
        : { mode: 'cloud', sub: 'account-a', orgId: 'org-a' });
    const envLayer = Layer.mergeAll(
      Layer.succeed(WorkspaceIdentity, owner),
      OperationalDbLive.pipe(Layer.provide(config), Layer.provide(logger.layer)),
      productDb,
      RecordingStoreLive.pipe(Layer.provide(productDb)),
      coreLayer,
      // The Transcriber seam over the same fake backend and the engine inputs.
      makeTranscriberStack(coreLayer, { local: options.localLane }).pipe(
        Layer.provide(logger.layer)
      ),
      makeFakeSettings({
        transcription: {
          engine: 'cloud',
          modelId: null,
          byokBaseUrl: null,
          byokModel: null,
          ...options.transcription,
        },
      }).layer,
      Layer.effect(AppModeService, makeAppMode(options.mode ?? 'cloud', true)),
      logger.layer
    );
    const ctx = yield* Layer.build(envLayer).pipe(Scope.extend(scope), Effect.orDie);
    const db: OperationalDbService = Context.get(ctx, OperationalDb);
    return {
      userDataDir,
      logger,
      scope,
      ctx,
      db,
      owner,
      insertRecovery: (
        row: Omit<NewRecoveryOutbox, 'owner' | 'createInput' | 'engineConfig'> &
          Partial<Pick<NewRecoveryOutbox, 'owner' | 'createInput' | 'engineConfig'>>
      ) =>
        db.insertRecoveryOutbox({
          ...row,
          owner: row.owner ?? owner,
          engineConfig:
            row.engineConfig ??
            resolveRecordingEngine(options.mode ?? 'cloud', {
              modelId: null,
              byokBaseUrl: null,
              byokModel: null,
              ...options.transcription,
              engine: row.engine ?? 'cloud',
            }),
          phase: row.phase ?? 'chunks',
          createInput: row.createInput ?? {
            recordingId: row.recordingId,
            title: 'Recovered recording',
            captureMode: row.captureMode,
            noteId: row.noteId ?? null,
            startedAt: 0,
          },
        }),
      product: Context.get(ctx, ProductDb),
      store: Context.get(ctx, RecordingStore),
      recoveryDir: (recordingId: string) => path.join(userDataDir, 'recovery', recordingId),
    };
  });

/** The common harness: real DB + fake cloud + a `drain(activeId)` one-pass runner. */
const setupWith = (options: EnvOptions) =>
  Effect.gen(function* () {
    const fakeCloud = makeFakeWorkspaceBackend();
    const env = yield* buildEnv(fakeCloud.layer, options);
    return {
      ...env,
      fakeCloud,
      drain: (activeId: string | null = null) =>
        drainRecoveries(Effect.succeed(activeId), ignoreCompletion).pipe(Effect.provide(env.ctx)),
    };
  });
const setup = setupWith({});

/** Install a (tiny, real-file) local model row so a 'local' row passes the
 * drain's model pre-check and reaches the injected lane. */
const installModel = (
  h: { readonly userDataDir: string; readonly db: OperationalDbService },
  modelId: string
) =>
  Effect.gen(function* () {
    const file = path.join(h.userDataDir, `${modelId}.bin`);
    yield* Effect.sync(() => fs.writeFileSync(file, 'ggml'));
    yield* h.db.upsertLocalModel({
      modelId,
      filename: `${modelId}.bin`,
      path: file,
      sizeBytes: 4,
      checksum: 'test',
      downloadedAt: new Date(0).toISOString(),
      verifiedAt: null,
    });
  });

describe('deriveDrainChunks matches live-capture boundaries', () => {
  it('dual: interleaves mic-before-system per 5 s window with per-source chunkStartMs', () => {
    // 6 s each → window0 (240k) + window1 (48k) per source.
    const chunks = deriveDrainChunks(seconds(6), seconds(6));
    assert.deepStrictEqual(
      chunks.map(c => ({
        index: c.index,
        source: c.source,
        startMs: c.chunkStartMs,
        len: c.samples.length,
      })),
      [
        { index: 0, source: 'mic', startMs: 0, len: 240_000 },
        { index: 1, source: 'system', startMs: 0, len: 240_000 },
        { index: 2, source: 'mic', startMs: 5000, len: 48_000 },
        { index: 3, source: 'system', startMs: 5000, len: 48_000 },
      ]
    );
  });

  it('mic-only: one contiguous lane, monotonic indices', () => {
    const chunks = deriveDrainChunks(seconds(12), null);
    assert.deepStrictEqual(
      chunks.map(c => ({
        index: c.index,
        source: c.source,
        startMs: c.chunkStartMs,
        len: c.samples.length,
      })),
      [
        { index: 0, source: 'mic', startMs: 0, len: 240_000 },
        { index: 1, source: 'mic', startMs: 5000, len: 240_000 },
        { index: 2, source: 'mic', startMs: 10_000, len: 96_000 },
      ]
    );
  });

  it('replays every persisted pause boundary with one shared monotonic index', () => {
    const chunks = deriveDrainChunks(seconds(12), null, [
      { micSamples: 2 * 48_000, systemSamples: 0 },
      { micSamples: 8 * 48_000, systemSamples: 0 },
    ]);
    assert.deepStrictEqual(
      chunks.map(c => ({ index: c.index, startMs: c.chunkStartMs, len: c.samples.length })),
      [
        { index: 0, startMs: 0, len: 96_000 },
        { index: 1, startMs: 2_000, len: 240_000 },
        { index: 2, startMs: 7_000, len: 48_000 },
        { index: 3, startMs: 8_000, len: 192_000 },
      ]
    );
  });

  it('dual pause replay preserves live cutAll-then-flushAll ordering for unequal lanes', () => {
    const chunks = deriveDrainChunks(seconds(8), seconds(7), [
      { micSamples: 2 * 48_000, systemSamples: 1 * 48_000 },
      { micSamples: 6 * 48_000, systemSamples: 6 * 48_000 },
    ]);
    assert.deepStrictEqual(
      chunks.map(c => ({
        index: c.index,
        source: c.source,
        startMs: c.chunkStartMs,
        len: c.samples.length,
      })),
      [
        { index: 0, source: 'mic', startMs: 0, len: 96_000 },
        { index: 1, source: 'system', startMs: 0, len: 48_000 },
        { index: 2, source: 'system', startMs: 1_000, len: 240_000 },
        { index: 3, source: 'mic', startMs: 2_000, len: 192_000 },
        { index: 4, source: 'mic', startMs: 6_000, len: 96_000 },
        { index: 5, source: 'system', startMs: 6_000, len: 48_000 },
      ]
    );
  });

  it('rejects non-monotonic or out-of-range pause cut points', () => {
    assert.throws(() =>
      deriveDrainChunks(seconds(2), null, [{ micSamples: 3 * 48_000, systemSamples: 0 }])
    );
    assert.throws(() =>
      deriveDrainChunks(seconds(2), null, [
        { micSamples: 2 * 48_000, systemSamples: 0 },
        { micSamples: 1 * 48_000, systemSamples: 0 },
      ])
    );
  });
});

describe('RecoveryDrain (re-chunk retained WAV → resend tail → finalize → delete)', () => {
  it.effect(
    'server staging recovers silent dual WAVs after a crash and retries tails before finalize',
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const recordingId = 'rec_server_spool';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(6), false);
        yield* writeWav(dir, 'system', new Float32Array(6 * RATE), false);
        yield* h.insertRecovery({
          recordingId,
          captureMode: 'dual',
          wavPath: dir,

          status: 'interrupted',
        });
        // The live session acknowledged mic chunk 0 before the hard kill.
        yield* h.db.updateRecoveryOutbox(recordingId, { lastChunkIndex: 0 });
        h.fakeCloud.setUploadResponder(call =>
          call.params.chunkIndex === 3 ? laneFail(true, { kind: 'http', status: 503 }) : laneOk([])
        );
        yield* h.drain();
        assert.deepStrictEqual(
          h.fakeCloud.uploadCalls.map(call => call.params),
          [
            { chunkIndex: 1, chunkStartMs: 0, source: 'system' },
            { chunkIndex: 2, chunkStartMs: 5000, source: 'mic' },
            { chunkIndex: 3, chunkStartMs: 5000, source: 'system' },
          ]
        );
        assertWavSamples(h.fakeCloud.uploadCalls[0].wav, 5 * RATE);
        assert.isTrue(
          Buffer.from(h.fakeCloud.uploadCalls[0].wav)
            .subarray(44)
            .every(byte => byte === 0)
        );
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);

        assert.isTrue(fs.existsSync(dir));
        h.fakeCloud.setUploadResponder(() => laneOk([]));
        yield* TestClock.adjust(Duration.seconds(30));
        const summary = yield* h.drain();
        assert.strictEqual(summary.resolved, 1);
        assert.deepStrictEqual(h.fakeCloud.uploadCalls[3].params, {
          chunkIndex: 3,
          chunkStartMs: 5000,
          source: 'system',
        });
        assertWavSamples(h.fakeCloud.uploadCalls[3].wav, RATE);
        assert.isTrue(
          Buffer.from(h.fakeCloud.uploadCalls[3].wav)
            .subarray(44)
            .every(byte => byte === 0)
        );
        assert.strictEqual(h.fakeCloud.timeline.at(-1), 'finalize');
        assert.strictEqual(h.fakeCloud.finalizeCalls[0].input.durationMs, 6000);

        assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));
        assert.isFalse(fs.existsSync(dir));
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('invalid persisted pause cuts fail closed and retain the recovery artifact', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_bad_pause_cut';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(2));
      yield* h.insertRecovery({
        recordingId,
        captureMode: 'mic',
        wavPath: dir,
        pauseCutPoints: [{ micSamples: 3 * 48_000, systemSamples: 0 }],
      });

      const summary = yield* h.drain();
      assert.strictEqual(summary.failed, 1);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      const row = yield* h.db.getRecoveryOutbox(recordingId);
      assert.strictEqual(row?.status, 'failed');
      assert.strictEqual(row?.lastError, 'pause-cut-points-invalid');
      assert.isTrue(fs.existsSync(dir));
    })
  );

  it.effect(
    'parked interrupted row → re-chunks from lastChunkIndex+1, uploads remainder, finalizes, deletes WAV+row',
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const recordingId = 'rec_parked';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(12)); // chunks 0,1,2

        yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
        yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted', lastChunkIndex: 1 });

        const summary = yield* h.drain();

        // Only the unacknowledged tail (index 2) is resent, on the capture boundary.
        assert.strictEqual(
          h.fakeCloud.uploadCalls.length,
          1,
          'only index > lastChunkIndex re-sent'
        );
        const call = h.fakeCloud.uploadCalls[0];
        assert.strictEqual(call.recordingId, recordingId);
        assert.strictEqual(call.params.chunkIndex, 2);
        assert.strictEqual(call.params.source, 'mic');
        assert.strictEqual(call.params.chunkStartMs, 10_000);
        assertWavSamples(call.wav, 96_000);

        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
        assert.strictEqual(h.fakeCloud.finalizeCalls[0].recordingId, recordingId);
        assert.isNull(yield* h.db.getRecoveryOutbox(recordingId), 'outbox row deleted on resolve');
        assert.isFalse(fs.existsSync(dir), 'recovery WAV deleted');
        assert.strictEqual(summary.resolved, 1);

        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('already-fully-uploaded row → no re-upload, just finalizes + deletes', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_done';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(10)); // chunks 0,1

      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, { status: 'finalizing', lastChunkIndex: 1 });

      const summary = yield* h.drain();

      assert.strictEqual(h.fakeCloud.uploadCalls.length, 0, 'nothing left to upload');
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
      assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));
      assert.isFalse(fs.existsSync(dir), 'WAV deleted');
      assert.strictEqual(summary.resolved, 1);

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('dual: re-chunks both sources with interleaved indices, uploads all, resolves', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_dual';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(6));
      yield* writeWav(dir, 'system', seconds(6));

      yield* h.insertRecovery({ recordingId, captureMode: 'dual', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' }); // nothing uploaded yet

      const summary = yield* h.drain();

      const seen = h.fakeCloud.uploadCalls.map(c => ({
        index: c.params.chunkIndex,
        source: c.params.source,
        startMs: c.params.chunkStartMs,
      }));
      assert.deepStrictEqual(seen, [
        { index: 0, source: 'mic', startMs: 0 },
        { index: 1, source: 'system', startMs: 0 },
        { index: 2, source: 'mic', startMs: 5000 },
        { index: 3, source: 'system', startMs: 5000 },
      ]);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
      assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));
      assert.isFalse(fs.existsSync(dir));
      assert.strictEqual(summary.resolved, 1);

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('recovered segments and drain finalize persist into the product store', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_persist';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(10)); // chunks 0,1

      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' }); // nothing acked
      // The prior session's start hook persisted the row before the crash.
      yield* h.store.recordingStarted({
        id: recordingId,
        title: 'Crashed',
        captureMode: 'mic',
        status: 'recording',
        noteId: null,
        startedAt: 1_720_000_000_000,
      });
      h.fakeCloud.setUploadResponder(call =>
        laneOk([
          fakeSegment(call.recordingId, call.params.source, call.params.chunkIndex, 'recovered'),
        ])
      );

      const summary = yield* h.drain();
      assert.strictEqual(summary.resolved, 1);

      // Both re-sent chunks' segments landed (the live path never saw them),
      // normalized (isFinal ?? true, deletedAt ?? null).
      const segments = yield* Effect.promise(() =>
        h.product.db
          .select()
          .from(productSchema.transcriptSegment)
          .where(eq(productSchema.transcriptSegment.recordingId, recordingId))
          .orderBy(asc(productSchema.transcriptSegment.segmentOrder))
      );
      assert.deepStrictEqual(
        segments.map(row => [row.id, row.segmentOrder, row.text, row.isFinal, row.deletedAt]),
        [
          ['tsg_0', 1_000_000, 'recovered', true, null],
          ['tsg_1', 1_001_000, 'recovered', true, null],
        ]
      );

      // The drain finalize completed the row with its endedAt (drain clock) +
      // the WAV-derived pause-compressed durationMs.
      const rows = yield* Effect.promise(() =>
        h.product.db
          .select()
          .from(productSchema.recording)
          .where(eq(productSchema.recording.id, recordingId))
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].status, 'completed');
      assert.strictEqual(rows[0].durationMs, 10_000);
      assert.isNotNull(rows[0].endedAt);
      assert.isFalse(Number.isNaN(Date.parse(rows[0].endedAt!)), 'endedAt stored as ISO');

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    'retryable failure → backoff bump + row retained → re-drains to resolve on the next pass',
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const recordingId = 'rec_retry';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(5)); // chunk 0

        yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
        yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });

        let attempts = 0;
        h.fakeCloud.setUploadResponder(() => {
          attempts += 1;
          return attempts === 1 ? laneFail(true, { kind: 'http', status: 503 }) : laneOk([]);
        });

        // Pass 1: the chunk fails retryable → backoff bump, row retained, no finalize.
        const first = yield* h.drain();
        assert.strictEqual(first.parked, 1);
        const parked = yield* h.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(parked?.status, 'interrupted', 'still recoverable (not failed)');
        assert.strictEqual(parked?.attemptCount, 1);
        assert.isNotNull(parked?.nextAttemptAt, 'backoff scheduled');
        assert.isNull(parked?.lastChunkIndex, 'cursor not advanced past the failed chunk');
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
        assert.isTrue(fs.existsSync(dir), 'WAV retained for the next pass');

        // Backoff not elapsed → the SAME pass would defer.
        const deferred = yield* h.drain();
        assert.strictEqual(deferred.deferred, 1, 'row deferred until backoff elapses');
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 1, 'no re-attempt while deferred');

        // Advance past the backoff → the next pass resolves.
        yield* TestClock.adjust(Duration.minutes(1));
        const second = yield* h.drain();
        assert.strictEqual(second.resolved, 1);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 2, 'chunk re-sent (idempotent)');
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
        assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));
        assert.isFalse(fs.existsSync(dir), 'WAV deleted once resolved');
        const attemptsLogged = h.logger.entries.filter(entry => entry.message === 'Recording recovery attempt ended').map(entry => entry.data as { recordingId: string; outcome: string; attempt: number });
        assert.deepStrictEqual(attemptsLogged.map(entry => [entry.recordingId, entry.outcome, entry.attempt]), [[recordingId, 'failure', 1], [recordingId, 'success', 2]]);
        assert.lengthOf(h.logger.entries.filter(entry => entry.message === 'Recording completed'), 1);


        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('non-retryable failure → row marked failed (give up), WAV retained', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_gone';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));

      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });
      h.fakeCloud.setUploadResponder(() => laneFail(false, { kind: 'http', status: 404 }));

      const summary = yield* h.drain();

      assert.strictEqual(summary.failed, 1);
      const row = yield* h.db.getRecoveryOutbox(recordingId);
      assert.strictEqual(row?.status, 'failed', 'deterministic give-up');
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      assert.isTrue(fs.existsSync(dir), 'WAV retained on give-up (not deleted)');

      // A subsequent pass never touches a failed row.
      const again = yield* h.drain();
      assert.strictEqual(again.skipped, 1);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 1, 'failed row not re-attempted');

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('required work remains retryable after repeated failures', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_capped';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));

      // Required processing remains eligible through a long outage.
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, {
        status: 'interrupted',
        attemptCount: 9,
      });
      h.fakeCloud.setUploadResponder(() => laneFail(true, { kind: 'network' }));

      const summary = yield* h.drain();

      assert.strictEqual(summary.parked, 1, 'required work retains its retry obligation');
      const row = yield* h.db.getRecoveryOutbox(recordingId);
      assert.strictEqual(row?.status, 'interrupted');
      assert.strictEqual(row?.attemptCount, 10);
      assert.isTrue(fs.existsSync(dir), 'WAV retained on give-up');

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('kill -9 (un-patched WAV header) → recovers the sample range from the file size', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_kill9';
      const dir = h.recoveryDir(recordingId);
      // 7 s written but NOT finalized → header data-size stays a placeholder 0.
      yield* writeWav(dir, 'mic', seconds(7), false);

      // Prove the premise: the on-disk header claims 0 bytes.
      const onDisk = fs.readFileSync(path.join(dir, 'mic.wav'));
      assert.strictEqual(onDisk.readUInt32LE(40), 0, 'kill -9 leaves the data size un-patched');
      assert.strictEqual(onDisk.length, 44 + 7 * RATE * 2, 'but the data is all on disk');
      fs.appendFileSync(path.join(dir, 'mic.wav'), Buffer.from([1])); // incomplete last sample

      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, { status: 'capturing' }); // never left 'capturing'

      const summary = yield* h.drain();

      // Recovered 7 s → chunks 0 (240k) + 1 (96k) — NOT zero, despite the header.
      assert.strictEqual(
        h.fakeCloud.uploadCalls.length,
        2,
        'sample count recovered from file size'
      );
      assert.deepStrictEqual(
        h.fakeCloud.uploadCalls.map(c => c.params.chunkIndex),
        [0, 1]
      );
      assertWavSamples(h.fakeCloud.uploadCalls[0].wav, 240_000);
      assertWavSamples(h.fakeCloud.uploadCalls[1].wav, 96_000);
      const recoveredPcm = Buffer.concat(
        h.fakeCloud.uploadCalls.map(call => Buffer.from(call.wav).subarray(44))
      );
      assert.strictEqual(recoveredPcm.length, onDisk.length - 44);
      for (let offset = 0; offset < recoveredPcm.length; offset += 2) {
        assert.closeTo(recoveredPcm.readInt16LE(offset), onDisk.readInt16LE(offset + 44), 1);
      }

      assert.strictEqual(summary.resolved, 1);
      assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  for (const phase of ['finalize', 'cleanup'] as const) {
    it.effect(`${phase} does not read audio after all chunks are durable`, () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const recordingId = `rec_large_${phase}`;
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(1));
        const wavPath = path.join(dir, 'mic.wav');
        // A sparse temp file exercises the real stat cap without allocating its contents.
        fs.truncateSync(wavPath, 1.5 * 1024 * 1024 * 1024 + 2);
        yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir, phase });
        yield* h.db.updateRecoveryOutbox(recordingId, { endedAt: 1000, durationMs: 1000 });
        const original = fs.readFileSync;
        let audioReads = 0;
        const read = vi.spyOn(fs, 'readFileSync').mockImplementation(file => {
          if (String(file) === wavPath) {
            audioReads += 1;
            throw new Error('oversized audio must not be read');
          }
          return original(file);
        });
        const result = yield* h
          .drain()
          .pipe(Effect.ensuring(Effect.sync(() => read.mockRestore())));
        assert.strictEqual(audioReads, 0);
        assert.strictEqual(result.resolved, 1);
        assert.strictEqual(
          h.fakeCloud.uploadCalls.length,
          0,
          'required chunks were already durable'
        );
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, phase === 'finalize' ? 1 : 0);

        assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));
        yield* Scope.close(h.scope, Exit.void);
      })
    );
  }

  it.effect('yields to a live recording — the whole pass defers cheaply', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_live';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));

      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, { status: 'capturing' });

      // A recording (any recording) is live — the pass must not contend for
      // the shared WhisperEngine Semaphore(1).
      const summary = yield* h.drain(recordingId);

      assert.strictEqual(summary.deferred, 1);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 0, 'no upload against the live recording');
      assert.strictEqual(
        h.fakeCloud.finalizeCalls.length,
        0,
        'no finalize against the live recording'
      );
      const untouched = yield* h.db.getRecoveryOutbox(recordingId);
      assert.strictEqual(
        untouched?.status,
        'capturing',
        'row left for capture recovery to resolve'
      );
      assert.strictEqual(untouched?.attemptCount, 0, 'not counted as a failed attempt');
      assert.isNull(untouched?.nextAttemptAt, 'no backoff — eligible on the next pass');
      assert.isTrue(fs.existsSync(dir));

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    'a mid-drain interrupt parks progress via lastChunkIndex (no double-send beyond idempotency)',
    () =>
      Effect.gen(function* () {
        // A WorkspaceBackend whose 2nd chunk upload blocks — so we can interrupt the drain
        // fiber AFTER chunk 0 acked (cursor persisted) but BEFORE chunk 1 completes.
        const gate = yield* Deferred.make<void>();
        const uploaded: number[] = [];
        let finalized = false;
        const api: WorkspaceBackendApi = {
          request: () => Effect.succeed({ error: { code: 'INTERNAL' } }),
          openAskStream: () => Effect.fail(new AskStreamError({ reason: 'connect' })),
          collabToken: Effect.succeed('t'),
          createRecording: input => Effect.succeed(laneOk({ recordingId: input.recordingId })),
          uploadTranscriptionChunk: (_recordingId, params) =>
            Effect.gen(function* () {
              uploaded.push(params.chunkIndex);
              if (params.chunkIndex === 1) yield* Deferred.await(gate); // block until interrupted
              return laneOk([]);
            }),
          finalizeRecording: (recordingId: string) =>
            Effect.sync(() => {
              finalized = true;
              return laneOk({ recordingId });
            }),
        };

        const env = yield* buildEnv(Layer.succeed(WorkspaceBackend, api));
        const recordingId = 'rec_interrupt';
        const dir = env.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(12)); // chunks 0,1,2
        yield* env.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
        yield* env.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });

        const fiber = yield* drainRecoveries(Effect.succeed(null), ignoreCompletion).pipe(
          Effect.provide(env.ctx),
          Effect.fork
        );

        // Wait until chunk 0 acked (persisted) and chunk 1 recorded + blocked.
        yield* poll(
          Effect.sync(() => uploaded.length === 2),
          'chunk 0 acked, chunk 1 in flight'
        );
        yield* poll(
          env.db.getRecoveryOutbox(recordingId).pipe(
            Effect.map(r => r?.lastChunkIndex === 0),
            Effect.orDie
          ),
          'cursor persisted at 0'
        );

        // Sign-out / quit mid-drain.
        yield* Fiber.interrupt(fiber);

        const parked = yield* env.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(parked?.status, 'interrupted', 'row still recoverable');
        assert.strictEqual(
          parked?.lastChunkIndex,
          0,
          'progress parked — next pass resumes at index 1'
        );
        assert.isFalse(finalized, 'no finalize on interrupt');
        assert.deepStrictEqual(uploaded, [0, 1], 'chunk 2 never attempted');
        assert.isTrue(fs.existsSync(dir), 'WAV retained');

        yield* Scope.close(env.scope, Exit.void);
      })
  );
});

// ---------------------------------------------------------------------------
// The drain transcribes through the Transcriber seam under
// the engine effective AT DRAIN TIME (resolved once per pass), with the same
// finalize/cleanup/mirror/speaker-count contract as the live stop path.
// ---------------------------------------------------------------------------

/** A local lane that mints a server-shaped segment for every chunk. */
const mintingLocalLane = (
  textFor: (params: TranscribeChunkParams) => string
): Layer.Layer<LocalTranscriberLane> =>
  Layer.succeed(LocalTranscriberLane, {
    transcribeChunk: (recordingId, params, audio) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now): RecordingLaneResult<readonly RecordingSegment[]> => {
          const segment = mintChunkSegment({
            recordingId,
            params,
            samples: audio.samples,
            text: textFor(params),
            now,
          });
          return { ok: true, value: segment === null ? [] : [segment] };
        })
      ),
  } satisfies TranscriberLaneApi);

const productRecordingRow = (product: ProductDbService, recordingId: string) =>
  Effect.promise(async () => {
    const rows = await product.db
      .select()
      .from(productSchema.recording)
      .where(eq(productSchema.recording.id, recordingId));
    return rows[0];
  });

describe('RecoveryDrain — transcription engine at drain time', () => {
  it.effect('cloud engine drains chunks and finalizes without a separate audio upload', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_cloud_engine';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });

      const summary = yield* h.drain();
      assert.strictEqual(summary.resolved, 1);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 1, 'through the cloud lane');

      assert.strictEqual(h.fakeCloud.requestCalls.length, 0);
      assert.isFalse(fs.existsSync(dir));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    'cloud mode + local engine (dual, minting lane): seam transcription, mirror before finalize, no staging, speaker count 2',
    () =>
      Effect.gen(function* () {
        const h = yield* setupWith({
          transcription: { engine: 'local', modelId: 'whisper-tiny' },
          localLane: mintingLocalLane(p => (p.source === 'system' ? 'them' : 'me')),
        });
        const recordingId = 'rec_local_drain';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(6));
        yield* writeWav(dir, 'system', seconds(6));
        yield* installModel(h, 'whisper-tiny');
        yield* h.insertRecovery({
          recordingId,
          captureMode: 'dual',
          wavPath: dir,
          engine: 'local',
        });
        yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });
        // The prior session's start hook persisted the row before the crash.
        yield* h.store.recordingStarted({
          id: recordingId,
          title: 'Crashed local',
          captureMode: 'dual',
          status: 'recording',
          noteId: null,
          startedAt: 1_720_000_000_000,
        });

        const summary = yield* h.drain();
        assert.strictEqual(summary.resolved, 1);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0, 'never the cloud lane');

        const segments = yield* Effect.promise(() =>
          h.product.db
            .select()
            .from(productSchema.transcriptSegment)
            .where(eq(productSchema.transcriptSegment.recordingId, recordingId))
            .orderBy(asc(productSchema.transcriptSegment.segmentOrder))
        );
        assert.deepStrictEqual(
          segments.map(row => [row.segmentOrder, row.source, row.speaker, row.text]),
          [
            [1_000_000, 'mic', 'you', 'me'],
            [1_001_000, 'system', 'them', 'them'],
            [1_002_000, 'mic', 'you', 'me'],
            [1_003_000, 'system', 'them', 'them'],
          ]
        );
        // Mirror: one sync-create POST per segment, all before the finalize PUT.
        assert.strictEqual(h.fakeCloud.requestCalls.length, 4);
        for (const [i, call] of h.fakeCloud.requestCalls.entries()) {
          assert.strictEqual(call.method, 'POST');
          assert.strictEqual(call.path, TRANSCRIPT_SEGMENTS_PATH);
          const parsed = SyncTranscriptSegmentCreateRequestSchema.safeParse(call.body);
          assert.isTrue(parsed.success, JSON.stringify(parsed.error?.issues));
          assert.strictEqual(parsed.data!.id, segments[i].id);
          assert.strictEqual(parsed.data!.segmentOrder, segments[i].segmentOrder);
        }
        const finalizeAt = h.fakeCloud.timeline.indexOf('finalize');
        assert.isTrue(
          h.fakeCloud.timeline.every((entry, i) => !entry.startsWith('request:') || i < finalizeAt),
          'every mirror lands BEFORE finalize'
        );

        assert.isFalse(fs.existsSync(dir), 'WAVs deleted (never staged)');
        const row = yield* productRecordingRow(h.product, recordingId);
        assert.deepStrictEqual(row?.meta, { detectedSpeakerCount: 2 });
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('local mode drain: transcribes on-device and never mirrors to a server', () =>
    Effect.gen(function* () {
      const h = yield* setupWith({ mode: 'local', localLane: mintingLocalLane(() => 'offline') });
      const recordingId = 'rec_local_mode';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));
      yield* installModel(h, RECOMMENDED_MODEL_ID);
      // Engine NULL (legacy): local mode re-applies the cloud→local coercion.
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });

      const summary = yield* h.drain();
      assert.strictEqual(summary.resolved, 1);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
      assert.strictEqual(h.fakeCloud.requestCalls.length, 0, 'local mode never mirrors');

      const segments = yield* Effect.promise(() =>
        h.product.db
          .select()
          .from(productSchema.transcriptSegment)
          .where(eq(productSchema.transcriptSegment.recordingId, recordingId))
      );
      assert.strictEqual(segments.length, 1);
      assert.isFalse(fs.existsSync(dir));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    "a 'local' row whose model is missing parks as 'model-missing' — audio is never silently dropped",
    () =>
      Effect.gen(function* () {
        let laneCalls = 0;
        const h = yield* setupWith({
          transcription: { engine: 'local' },
          localLane: mintingLocalLane(() => {
            laneCalls += 1;
            return 'late install';
          }),
        });
        const recordingId = 'rec_model_missing';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(5));
        yield* h.insertRecovery({
          recordingId,
          captureMode: 'mic',
          wavPath: dir,
          engine: 'local',
        });
        yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });

        // Pass 1: no installed-model row at all → park with normal backoff (the
        // attempt cap eventually marks it 'failed', which RETAINS the WAV).
        const first = yield* h.drain();
        assert.strictEqual(first.parked, 1);
        let row = yield* h.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(row?.lastError, 'model-missing');
        assert.strictEqual(row?.attemptCount, 1);
        assert.isNotNull(row?.nextAttemptAt, 'normal backoff');
        assert.strictEqual(laneCalls, 0, 'the lane was never engaged (no empty acks)');
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0, 'nothing routed to the cloud lane');
        assert.isTrue(fs.existsSync(dir), 'WAV retained');

        // Pass 2: a DB row whose FILE is gone is still missing → parks again.
        yield* h.db.upsertLocalModel({
          modelId: RECOMMENDED_MODEL_ID,
          filename: 'ghost.bin',
          path: path.join(h.userDataDir, 'ghost.bin'),
          sizeBytes: 4,
          checksum: 'ghost',
          downloadedAt: new Date(0).toISOString(),
          verifiedAt: null,
        });
        yield* TestClock.adjust(Duration.minutes(1));
        const second = yield* h.drain();
        assert.strictEqual(second.parked, 1);
        row = yield* h.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(row?.attemptCount, 2);
        assert.isTrue(fs.existsSync(dir));

        // Pass 3: the model is installed for real → the row resolves on-device.
        yield* installModel(h, RECOMMENDED_MODEL_ID);
        yield* TestClock.adjust(Duration.minutes(2));
        const third = yield* h.drain();
        assert.strictEqual(third.resolved, 1);
        assert.strictEqual(laneCalls, 1, 'transcribed on-device once the model exists');
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
        assert.isFalse(fs.existsSync(dir));
        yield* Scope.close(h.scope, Exit.void);
      })
  );
});

// ---------------------------------------------------------------------------
// Adversarial engine checks: every engine decision follows the row's frozen
// engine kind (null means legacy cloud); the drain yields to live capture.
// ---------------------------------------------------------------------------

describe('RecoveryDrain — engine follows the row and yields to live capture', () => {
  it.effect(
    'a legacy NULL-engine row is CLOUD: cloud-lane chunks + server finalization, whatever the current setting',
    () =>
      Effect.gen(function* () {
        let laneCalls = 0;
        const h = yield* setupWith({
          transcription: { engine: 'local' },
          localLane: mintingLocalLane(() => {
            laneCalls += 1;
            return 'never';
          }),
        });
        const recordingId = 'rec_legacy_null';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(5));
        yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
        yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });

        const summary = yield* h.drain();
        assert.strictEqual(summary.resolved, 1);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 1, 'the CLOUD lane carried the chunk');
        assert.strictEqual(laneCalls, 0, 'the local lane never saw the row');

        assert.strictEqual(h.fakeCloud.requestCalls.length, 0, 'a cloud row never mirrors');
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect(
    "a 'local' row NEVER routes through the cloud lane and NEVER stages, even under a cloud setting",
    () =>
      Effect.gen(function* () {
        const h = yield* setupWith({
          transcription: { engine: 'cloud' },
          localLane: mintingLocalLane(() => 'on-device'),
        });
        yield* installModel(h, RECOMMENDED_MODEL_ID);
        const recordingId = 'rec_row_local';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(5));
        yield* h.insertRecovery({
          recordingId,
          captureMode: 'mic',
          wavPath: dir,
          engine: 'local',
        });
        yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });

        const summary = yield* h.drain();
        assert.strictEqual(summary.resolved, 1);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0, 'no chunk ever leaves the device');

        // Cloud mode with a non-cloud engine: the minted segment is mirrored to the server.
        assert.strictEqual(h.fakeCloud.requestCalls.length, 1);

        assert.isFalse(fs.existsSync(dir), 'WAVs deleted after on-device transcription');
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect(
    'yields mid-row when a recording starts: progress parks via lastChunkIndex, no attempt bump',
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const recordingId = 'rec_mid_row_yield';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(12)); // chunks 0,1,2
        yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
        yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });

        // A recording starts while chunk 0 is in flight — the per-chunk check
        // sees it before chunk 1.
        let activeId: string | null = null;
        h.fakeCloud.setUploadResponder(() => {
          activeId = 'rec_live_now';
          return laneOk([]);
        });
        const summary = yield* drainRecoveries(
          Effect.sync(() => activeId),
          ignoreCompletion
        ).pipe(Effect.provide(h.ctx));

        assert.strictEqual(summary.deferred, 1);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 1, 'stopped after the in-flight chunk');
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0, 'no finalize mid-yield');
        const row = yield* h.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(row?.status, 'interrupted');
        assert.strictEqual(
          row?.lastChunkIndex,
          0,
          'acked progress persisted — the next pass resumes at 1'
        );
        assert.strictEqual(row?.attemptCount, 0, 'not counted as a failed attempt');
        assert.isTrue(fs.existsSync(dir), 'WAV retained');
        yield* Scope.close(h.scope, Exit.void);
      })
  );
});

describe('RecoveryDrain durability and row isolation', () => {
  it.effect('retains local audio and cursor when the transcript cannot be saved', () =>
    Effect.gen(function* () {
      const h = yield* setupWith({
        mode: 'local',
        localLane: mintingLocalLane(() => 'retained speech'),
      });
      yield* installModel(h, RECOMMENDED_MODEL_ID);
      const recordingId = 'rec_store_unavailable';
      const dir = h.recoveryDir(recordingId);
      yield* h.store.recordingStarted({
        id: recordingId,
        title: 'Local recording',
        captureMode: 'mic',
        status: 'recording',
        noteId: null,
        startedAt: 0,
      });
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir, engine: 'local' });
      yield* h.db.updateRecoveryOutbox(recordingId, { status: 'interrupted' });
      yield* Effect.sync(() =>
        h.product.client.exec(
          "CREATE TRIGGER fail_segments BEFORE INSERT ON transcript_segment BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END"
        )
      );
      const result = yield* h.drain();
      assert.strictEqual(result.parked, 1);
      const row = yield* h.db.getRecoveryOutbox(recordingId);
      assert.isNull(row?.lastChunkIndex);
      assert.isTrue(fs.existsSync(dir));
      yield* Effect.sync(() => h.product.client.exec('DROP TRIGGER fail_segments'));
      yield* TestClock.adjust(Duration.minutes(1));
      assert.strictEqual((yield* h.drain()).resolved, 1);
      const segments = yield* Effect.promise(() =>
        h.product.db.select().from(productSchema.transcriptSegment)
      );
      assert.strictEqual(segments.length, 1);
      yield* Scope.close(h.scope, Exit.void);
      yield* Effect.sync(() => fs.rmSync(h.userDataDir, { recursive: true, force: true }));
    })
  );

  it.effect('parks an unreadable WAV and continues with the next recording', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const first = 'rec_unreadable';
      const second = 'rec_readable';
      const dir = h.recoveryDir(first);
      yield* writeWav(dir, 'mic', seconds(5));
      yield* writeWav(h.recoveryDir(second), 'mic', seconds(5));
      yield* h.insertRecovery({ recordingId: first, captureMode: 'mic', wavPath: dir });
      yield* h.insertRecovery({
        recordingId: second,
        captureMode: 'mic',
        wavPath: h.recoveryDir(second),
      });
      const file = path.join(dir, 'mic.wav');
      yield* Effect.sync(() => fs.chmodSync(file, 0));
      const result = yield* Effect.exit(h.drain());
      yield* Effect.sync(() => fs.chmodSync(file, 0o600));
      assert.isTrue(Exit.isSuccess(result));
      if (Exit.isSuccess(result)) {
        assert.strictEqual(result.value.parked, 1);
        assert.strictEqual(result.value.resolved, 1);
      }
      assert.strictEqual(h.fakeCloud.uploadCalls[0]?.recordingId, second);
      assert.isTrue(fs.existsSync(dir));
      assert.strictEqual((yield* h.db.getRecoveryOutbox(first))?.attemptCount, 1);
      yield* Scope.close(h.scope, Exit.void);
      yield* Effect.sync(() => fs.rmSync(h.userDataDir, { recursive: true, force: true }));
    })
  );
});

describe('RecoveryDrain owned processing lifecycle', () => {
  it.effect('leaves foreign accounts, organizations, and ownerless jobs untouched', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_original_owner';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* Effect.sync(() =>
        h.db.db
          .insert(operationalSchema.recoveryOutbox)
          .values({
            recordingId: 'rec_ownerless',
            captureMode: 'mic',
            wavPath: '/unowned/path',
            status: 'interrupted',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          })
          .run()
      );
      const before = yield* h.db.listRecoveryOutbox();
      h.fakeCloud.setUploadResponder(() => laneFail(false, { kind: 'http', status: 404 }));
      for (const owner of [
        { mode: 'cloud', sub: 'account-b', orgId: 'org-a' },
        { mode: 'cloud', sub: 'account-a', orgId: 'org-b' },
      ] as const) {
        const foreign = Context.add(h.ctx, WorkspaceIdentity, owner);
        assert.strictEqual(
          (yield* drainRecoveries(Effect.succeed(null), ignoreCompletion).pipe(
            Effect.provide(foreign)
          )).total,
          0
        );
      }
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
      assert.deepStrictEqual(yield* h.db.listRecoveryOutbox(), before);
      h.fakeCloud.setUploadResponder(() => laneOk([]));
      assert.strictEqual((yield* h.drain()).resolved, 1);
      assert.isNotNull(yield* h.db.getRecoveryOutbox('rec_ownerless'));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    'replays uncertain creation before chunks and preserves the original stop metadata',
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const recordingId = 'rec_pending_create';
        const dir = h.recoveryDir(recordingId);
        const createInput = {
          recordingId,
          title: 'Interrupted recording',
          captureMode: 'mic' as const,
          startedAt: 20_000,
          noteId: 'note_owner',
          transcriptionConfig: { language: 'en' },
        };
        yield* writeWav(dir, 'mic', seconds(5));
        yield* h.insertRecovery({
          recordingId,
          captureMode: 'mic',
          wavPath: dir,
          phase: 'create',
          createInput,
        });
        yield* h.db.updateRecoveryOutbox(recordingId, { endedAt: 25_000, durationMs: 5000 });
        h.fakeCloud.setCreateResponder(() => laneFail(true, { kind: 'http', status: 503 }));
        assert.strictEqual((yield* h.drain()).parked, 1);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
        assert.isTrue(fs.existsSync(dir));
        h.fakeCloud.setCreateResponder(input => laneOk({ recordingId: input.recordingId }));
        yield* TestClock.adjust(Duration.days(1));
        assert.strictEqual((yield* h.drain()).resolved, 1);
        assert.deepStrictEqual(h.fakeCloud.createCalls, [createInput, createInput]);
        assert.strictEqual(h.fakeCloud.finalizeCalls[0]?.input.endedAt, 25_000);
        assert.strictEqual(h.fakeCloud.finalizeCalls[0]?.input.durationMs, 5000);
        assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('diagnostic text cannot skip unfinished transcription or finalization', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_explicit_phase';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir, phase: 'chunks' });
      yield* h.db.updateRecoveryOutbox(recordingId, {
        lastError: 'staging-diagnostic',
        endedAt: 5000,
        durationMs: 5000,
      });
      assert.strictEqual((yield* h.drain()).resolved, 1);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    'resumes newly stopped work in the same workspace and waits while capture is starting',
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const recordingId = 'rec_stopped';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(5));
        yield* h.insertRecovery({
          recordingId,
          captureMode: 'mic',
          wavPath: dir,
          phase: 'cleanup',
        });
        yield* h.db.updateRecoveryOutbox(recordingId, { endedAt: 5000, durationMs: 5000 });
        const state = yield* SubscriptionRef.make<RecordingState>({
          ...idleRecordingState,
          status: 'starting',
        });
        const worker = yield* runRecoveryWorker(state, ignoreCompletion).pipe(
          Effect.provide(h.ctx),
          Effect.fork
        );
        yield* TestClock.adjust(Duration.seconds(30));
        assert.isNotNull(yield* h.db.getRecoveryOutbox(recordingId));
        yield* SubscriptionRef.set(state, idleRecordingState);
        yield* poll(
          h.db.getRecoveryOutbox(recordingId).pipe(Effect.map(row => row === null)),
          'stopped recording processed'
        );

        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
        yield* Fiber.interrupt(worker);
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('retries required work at its deadline without another workspace acquisition', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_retry_in_session';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      let attempts = 0;
      h.fakeCloud.setUploadResponder(() =>
        ++attempts === 1 ? laneFail(true, { kind: 'network' }) : laneOk([])
      );
      const state = yield* SubscriptionRef.make(idleRecordingState);
      const worker = yield* runRecoveryWorker(state, ignoreCompletion).pipe(
        Effect.provide(h.ctx),
        Effect.fork
      );
      yield* poll(
        h.db.getRecoveryOutbox(recordingId).pipe(Effect.map(row => row?.attemptCount === 1)),
        'retry deadline saved'
      );
      yield* TestClock.adjust(Duration.seconds(29));
      assert.strictEqual(attempts, 1);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* poll(
        h.db.getRecoveryOutbox(recordingId).pipe(Effect.map(row => row === null)),
        'retry resolves'
      );
      assert.strictEqual(attempts, 2);
      yield* Fiber.interrupt(worker);
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});

describe('RecoveryDrain processing ownership', () => {
  it.effect(
    'server staging retains audio after failed finalization and retries before cleanup',
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const recordingId = 'rec_server_finalize_retry';
        const dir = h.recoveryDir(recordingId);
        yield* writeWav(dir, 'mic', seconds(5));
        yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
        const completions: boolean[] = [];
        const drain = drainRecoveries(Effect.succeed(null), (_id, ready) =>
          Effect.sync(() => {
            completions.push(ready);
          })
        ).pipe(Effect.provide(h.ctx));
        h.fakeCloud.setFinalizeResponder(() => laneFail(true, { kind: 'http', status: 503 }));

        assert.strictEqual((yield* drain).parked, 1);
        const retained = yield* h.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(retained?.phase, 'finalize');

        assert.strictEqual(retained?.attemptCount, 1);
        assert.isTrue(fs.existsSync(path.join(dir, 'mic.wav')));
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);

        assert.deepStrictEqual(completions, []);
        assert.strictEqual((yield* drain).deferred, 1);
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);

        h.fakeCloud.setFinalizeResponder(id => laneOk({ recordingId: id }));
        yield* TestClock.adjust(Duration.seconds(30));
        assert.strictEqual((yield* drain).resolved, 1);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 2);
        assert.deepStrictEqual(h.fakeCloud.finalizeCalls[1], h.fakeCloud.finalizeCalls[0]);

        assert.deepStrictEqual(completions, [true]);
        assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));
        assert.isFalse(fs.existsSync(dir));
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('server staging retries failed audio cleanup without repeating finalized work', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_server_cleanup_retry';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      const original = fs.rmSync;
      const remove = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
        if (String(file) === dir) throw new Error('recovery audio is temporarily locked');
        original(file, options);
      });
      const first = yield* h.drain().pipe(Effect.ensuring(Effect.sync(() => remove.mockRestore())));
      assert.strictEqual(first.parked, 1);
      const retained = yield* h.db.getRecoveryOutbox(recordingId);
      assert.strictEqual(retained?.phase, 'cleanup');

      assert.strictEqual(retained?.lastError, 'recovery-file');
      assert.isTrue(fs.existsSync(path.join(dir, 'mic.wav')));
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);

      yield* TestClock.adjust(Duration.seconds(30));
      assert.strictEqual((yield* h.drain()).resolved, 1);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);

      assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));
      assert.isFalse(fs.existsSync(dir));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('publishes completion after durable finalization before cleanup', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_ready_before_cleanup';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(1));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      const completions: {
        id: string;
        ready: boolean;
        phase: string | null;
        audioExists: boolean;
      }[] = [];
      const result = yield* drainRecoveries(Effect.succeed(null), (id, ready) =>
        h.db.getRecoveryOutbox(id).pipe(
          Effect.orDie,
          Effect.map(row => {
            completions.push({
              id,
              ready,
              phase: row?.phase ?? null,
              audioExists: fs.existsSync(dir),
            });
          })
        )
      ).pipe(Effect.provide(h.ctx));
      assert.deepStrictEqual(completions, [
        { id: recordingId, ready: true, phase: 'cleanup', audioExists: true },
      ]);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
      assert.strictEqual(result.resolved, 1);
      assert.isFalse(fs.existsSync(dir));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('resumes cleanup without repeating finalized work when deleting the job fails', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_cleanup_retry';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* Effect.sync(() =>
        h.db.db.run(
          sql`CREATE TRIGGER fail_delete BEFORE DELETE ON recovery_outbox BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`
        )
      );
      assert.strictEqual((yield* h.drain()).parked, 1);
      assert.strictEqual((yield* h.db.getRecoveryOutbox(recordingId))?.phase, 'cleanup');
      assert.isFalse(fs.existsSync(dir));
      yield* Effect.sync(() => h.db.db.run(sql`DROP TRIGGER fail_delete`));
      yield* TestClock.adjust(Duration.minutes(1));
      assert.strictEqual((yield* h.drain()).resolved, 1);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('coalesces state wakeups while one finalize request is in flight', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_one_processor';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir, phase: 'finalize' });
      yield* h.db.updateRecoveryOutbox(recordingId, { endedAt: 5000, durationMs: 5000 });
      const gate = yield* Deferred.make<void>();
      let finalizations = 0;
      const backend = Context.get(h.ctx, WorkspaceBackend);
      const ctx = Context.add(h.ctx, WorkspaceBackend, {
        ...backend,
        finalizeRecording: () =>
          Effect.gen(function* () {
            finalizations += 1;
            yield* Deferred.await(gate);
            return laneOk({ recordingId });
          }),
      });
      const state = yield* SubscriptionRef.make(idleRecordingState);
      const worker = yield* runRecoveryWorker(state, ignoreCompletion).pipe(
        Effect.provide(ctx),
        Effect.fork
      );
      yield* poll(
        Effect.sync(() => finalizations === 1),
        'finalization started'
      );
      yield* SubscriptionRef.set(state, { ...idleRecordingState, elapsedMs: 1 });
      yield* SubscriptionRef.set(state, { ...idleRecordingState, elapsedMs: 2 });
      yield* TestClock.adjust(Duration.minutes(1));
      assert.strictEqual(finalizations, 1);
      yield* Deferred.succeed(gate, undefined);
      yield* poll(
        h.db.getRecoveryOutbox(recordingId).pipe(Effect.map(row => row === null)),
        'finalization resolved'
      );
      assert.strictEqual(finalizations, 1);
      yield* Fiber.interrupt(worker);
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});

describe('RecoveryDrain finalized data and frozen engine', () => {
  it.effect('retries speaker metadata from all durable segments before finalizing', () =>
    Effect.gen(function* () {
      const h = yield* setupWith({ mode: 'local' });
      const recordingId = 'rec_saved_speakers';
      yield* h.store.recordingStarted({
        id: recordingId,
        title: 'Conversation',
        captureMode: 'dual',
        status: 'recording',
        noteId: null,
        startedAt: 0,
      });
      yield* h.store.segmentsReceived([
        fakeSegment(recordingId, 'system', 0, 'Earlier captured speech'),
      ]);
      yield* h.insertRecovery({
        recordingId,
        captureMode: 'dual',
        wavPath: h.recoveryDir(recordingId),
        engine: 'local',
        phase: 'finalize',
      });
      yield* h.db.updateRecoveryOutbox(recordingId, {
        endedAt: 5000,
        durationMs: 5000,
        lastChunkIndex: 0,
      });
      yield* Effect.sync(() =>
        h.product.client.exec(
          "CREATE TRIGGER fail_meta BEFORE UPDATE OF meta ON recording BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END"
        )
      );
      assert.strictEqual((yield* h.drain()).parked, 1);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      assert.strictEqual((yield* h.db.getRecoveryOutbox(recordingId))?.phase, 'finalize');
      yield* Effect.sync(() => h.product.client.exec('DROP TRIGGER fail_meta'));
      yield* TestClock.adjust(Duration.minutes(1));
      assert.strictEqual((yield* h.drain()).resolved, 1);
      assert.deepStrictEqual((yield* productRecordingRow(h.product, recordingId))?.meta, {
        detectedSpeakerCount: 2,
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('retains incomplete audio instead of finalizing a shorter recovery WAV', () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const recordingId = 'rec_partial_audio';
      const dir = h.recoveryDir(recordingId);
      yield* writeWav(dir, 'mic', seconds(4));
      yield* h.insertRecovery({ recordingId, captureMode: 'mic', wavPath: dir });
      yield* h.db.updateRecoveryOutbox(recordingId, { endedAt: 5000, durationMs: 5000 });
      assert.strictEqual((yield* h.drain()).failed, 1);
      assert.strictEqual(
        (yield* h.db.getRecoveryOutbox(recordingId))?.lastError,
        'recovery-audio-incomplete'
      );
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      assert.isTrue(fs.existsSync(dir));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('keeps the recorded BYOK endpoint and model after settings change', () =>
    Effect.gen(function* () {
      const h = yield* setupWith({
        transcription: {
          engine: 'byok',
          byokBaseUrl: 'https://new-provider.invalid',
          byokModel: 'new-model',
        },
      });
      const recordingId = 'rec_frozen_provider';
      const dir = h.recoveryDir(recordingId);
      const engineConfig = {
        engine: 'byok' as const,
        modelId: RECOMMENDED_MODEL_ID,
        byokBaseUrl: 'https://original-provider.invalid',
        byokModel: 'original-model',
      };
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({
        recordingId,
        captureMode: 'mic',
        wavPath: dir,
        engine: 'byok',
        engineConfig,
      });
      let received: unknown;
      const ctx = Context.add(h.ctx, Transcriber, {
        transcribeChunk: (_id, _params, _audio, engine) =>
          Effect.sync(() => {
            received = engine;
            return laneOk([]);
          }),
      });
      assert.strictEqual(
        (yield* drainRecoveries(Effect.succeed(null), ignoreCompletion).pipe(Effect.provide(ctx)))
          .resolved,
        1
      );
      assert.deepStrictEqual(received, engineConfig);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('waits for the originally selected local model instead of using a new preference', () =>
    Effect.gen(function* () {
      const h = yield* setupWith({ mode: 'local', transcription: { modelId: 'new-model' } });
      const recordingId = 'rec_frozen_model';
      const dir = h.recoveryDir(recordingId);
      yield* installModel(h, 'new-model');
      yield* writeWav(dir, 'mic', seconds(5));
      yield* h.insertRecovery({
        recordingId,
        captureMode: 'mic',
        wavPath: dir,
        engine: 'local',
        engineConfig: {
          engine: 'local',
          modelId: 'original-model',
          byokBaseUrl: null,
          byokModel: null,
        },
      });
      assert.strictEqual((yield* h.drain()).parked, 1);
      assert.strictEqual((yield* h.db.getRecoveryOutbox(recordingId))?.lastError, 'model-missing');
      assert.isTrue(fs.existsSync(dir));
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});
