/**
 * RecordingService supervisor tests.
 *
 * Fully headless: a FAKE Capture (emits AudioFrames + a controllable awaitExit +
 * release tracking), a FAKE WorkspaceBackend recording lane (records + configurable
 * results), a REAL OperationalDb (temp file, so the outbox lifecycle is real),
 * and TestClock for upload delays + restart backoff. NO binary, NO cloud, NO device.
 *
 * The boot OperationalDb is built in an OUTER scope and the RecordingService in an
 * INNER (session) scope — so closing the session scope (sign-out / quit) parks the
 * outbox while the db stays open for assertions, exactly as production layers it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { afterEach, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
  TestClock,
} from 'effect';
import { makeTestLogger, testConfigLayer, testI18nLayer } from '../helpers/test-layers';
import {
  fakeFrame,
  fakeSegment,
  laneFail,
  makeFakeCapture,
  makeFakeWorkspaceBackend,
  makeFakeSystemPermissions,
} from '../helpers/fake-recording';
import {
  fakeModelManagerLayer,
  makeFakeSettings,
  makeTranscriberStack,
} from '../helpers/fake-workspace-env';
import {
  drainRecoveries,
  type DrainSummary,
} from '../../src/main/domains/recording/recovery-drain';
import { WorkspaceIdentity } from '../../src/main/runtime/workspace-identity';
import {
  WorkspaceBackend,
  type WorkspaceBackendApi,
} from '../../src/main/domains/transport/service';
import { AppModeService, makeAppMode, type AppMode } from '../../src/main/domains/app-mode/service';
import type { DeviceSettings } from '@prismical/desktop-contracts';
import { SyncTranscriptSegmentCreateRequestSchema } from '@prismical/api-contracts';
import { RECOMMENDED_MODEL_ID } from '../../src/main/domains/models/catalogue';
import { TRANSCRIPT_SEGMENTS_PATH } from '../../src/main/domains/recording/segment-mirror';
import { mintChunkSegment } from '../../src/main/domains/transcriber/segment';
import {
  LocalTranscriberLane,
  type TranscriberLaneApi,
} from '../../src/main/domains/transcriber/service';
import { MANAGED_TRANSCRIPTION_CONFIG } from '../../src/main/domains/transport/live';
import type {
  RecordingLaneResult,
  RecordingSegment,
  TranscribeChunkParams,
} from '../../src/main/domains/transport/service';
import type { MainLogger } from '../../src/main/infra/logging/service';
import { CaptureExitError } from '../../src/main/domains/recording/capture/service';
import { StreamingWavWriter } from '../../src/main/infra/audio/streaming-wav-writer';
import { PermissionServiceLive } from '../../src/main/domains/recording/permission/live';
import { PermissionError } from '../../src/main/domains/recording/permission/service';
import { RecordingBridgeLive } from '../../src/main/domains/recording/bridge';
import { RecordingServiceLive } from '../../src/main/domains/recording/live';
import { RecordingStore, type RecordingStoreApi } from '../../src/main/domains/recording/store';
import { RecordingStoreLive } from '../../src/main/domains/recording/store-live';
import {
  RecordingBusyError,
  RecordingStartError,
  RecordingService,
  type RecordingServiceApi,
} from '../../src/main/domains/recording/service';
import {
  OperationalDb,
  type OperationalDbService,
} from '../../src/main/infra/operational-db/service';
import { OperationalDbLive } from '../../src/main/infra/operational-db/live';
import { MicActivity, type LatestMicActivity } from '../../src/main/infra/mic-detector/service';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as productSchema from '../../src/main/infra/product-db/schema';
import {
  ProductDb,
  ProductDbError,
  type ProductDbService,
} from '../../src/main/infra/product-db/service';

const CHUNK_INTERVAL = Duration.seconds(15);

/** Poll a boolean Effect while letting real async (fs writes, the frame fiber)
 * settle — WITHOUT advancing the (Test) Clock. The budget is WALL-CLOCK time
 * (real timers are untouched by TestClock), not a tick count: a hosted CI
 * runner or a machine running every package's suite in parallel gets the same
 * 20 s of real time a fast laptop does, and the loop returns the moment the
 * condition holds. */
const POLL_BUDGET_MS = 20_000;
const poll = (cond: Effect.Effect<boolean, unknown>, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const check = Effect.orDie(cond);
    const deadline = Date.now() + POLL_BUDGET_MS;
    while (Date.now() < deadline) {
      if (yield* check) return;
      yield* Effect.yieldNow();
      yield* Effect.promise(() => new Promise<void>(resolve => setTimeout(resolve, 2)));
    }
    assert.isTrue(yield* check, `poll timed out: ${label}`);
  });

/** Let real async work settle without advancing the clock. */
const settle: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 12; i += 1) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
  }
});

interface Harness {
  readonly service: RecordingServiceApi;
  readonly db: OperationalDbService;
  readonly product: ProductDbService;
  readonly fakeCapture: ReturnType<typeof makeFakeCapture>;
  readonly fakeCloud: ReturnType<typeof makeFakeWorkspaceBackend>;
  readonly fakePermissions: ReturnType<typeof makeFakeSystemPermissions>;
  readonly logger: ReturnType<typeof makeTestLogger>;
  readonly settings: ReturnType<typeof makeFakeSettings>;
  readonly micActivityLatest: SubscriptionRef.SubscriptionRef<Option.Option<LatestMicActivity>>;
  readonly sessionScope: Scope.CloseableScope;
  readonly drain: Effect.Effect<DrainSummary>;
  readonly recoveryDir: (recordingId: string) => string;
}

/** Engine knobs for a harness: the boot mode, stored preference, and injected local lane. */
interface SetupOptions {
  readonly installedModels?: Record<string, string>;
  readonly backendTransform?: (api: WorkspaceBackendApi) => WorkspaceBackendApi;
  readonly mode?: AppMode;
  readonly transcription?: Partial<DeviceSettings['transcription']>;
  /** Replaces the placeholder local lane with an injected implementation. */
  readonly localLane?: Layer.Layer<LocalTranscriberLane, never, MainLogger>;
}

/** Build a boot db (outer scope) + a session-scoped RecordingService (inner scope). */
const setup = (
  permissionInit: Parameters<typeof makeFakeSystemPermissions>[0] = {},
  storeOverride?: Layer.Layer<RecordingStore>,
  options: SetupOptions = {}
) =>
  Effect.gen(function* () {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismical-rec-'));
    const logger = makeTestLogger();
    // Pin the platform to darwin so the system-audio gate is deterministic
    // regardless of the host running the suite (default fake version 14.2.1 ⇒
    // system audio available ⇒ dual/system stay un-degraded).
    const config = testConfigLayer({
      userDataDir,
      operationalDbPath: path.join(userDataDir, 'op.db'),
      platform: 'darwin',
    });
    const fakeCapture = makeFakeCapture();
    const fakeCloud = makeFakeWorkspaceBackend();
    const backendLayer = Layer.effect(
      WorkspaceBackend,
      WorkspaceBackend.pipe(
        Effect.provide(fakeCloud.layer),
        Effect.map(api => options.backendTransform?.(api) ?? api)
      )
    );
    const modeLayer = Layer.effect(AppModeService, makeAppMode(options.mode ?? 'cloud', true));
    const ownerLayer = Layer.succeed(
      WorkspaceIdentity,
      options.mode === 'local' ? { mode: 'local' } : { mode: 'cloud', sub: 'user-one', orgId: null }
    );
    const fakePermissions = makeFakeSystemPermissions(permissionInit);
    const micActivityLatest = yield* SubscriptionRef.make(Option.none<LatestMicActivity>());

    const bootScope = yield* Scope.make();
    const envLayer = Layer.mergeAll(
      OperationalDbLive.pipe(Layer.provide(config), Layer.provide(logger.layer)),
      config,
      testI18nLayer('de'),
      logger.layer
    );
    const envCtx = yield* Layer.build(envLayer).pipe(Scope.extend(bootScope));
    const db = Context.get(envCtx, OperationalDb);

    const sessionScope = yield* Scope.make();
    const permission = PermissionServiceLive.pipe(
      Layer.provide(fakePermissions.layer),
      Layer.provide(config),
      Layer.provide(logger.layer)
    );
    // A real product store (`:memory:` localDbPath from testConfig), so
    // the persisted recording/segment rows are asserted against real SQL.
    const productDb = makeProductDbLayer({ kind: 'local' });
    const recordingStore = storeOverride ?? RecordingStoreLive.pipe(Layer.provide(productDb));
    // The Transcriber seam over the same fake backend (its cloud lane keeps
    // feeding `uploadCalls`), the engine preference, and the boot mode.
    const transcriber = makeTranscriberStack(backendLayer, { local: options.localLane });
    const settings = makeFakeSettings({
      transcription: {
        engine: 'cloud',
        modelId: null,
        byokBaseUrl: null,
        byokModel: null,
        ...options.transcription,
      },
    });
    const svcLayer = Layer.mergeAll(
      productDb,
      recordingStore,
      transcriber,
      backendLayer,
      modeLayer,
      ownerLayer,
      settings.layer,
      RecordingServiceLive.pipe(
        Layer.provide(fakeCapture.layer),
        Layer.provide(backendLayer),
        Layer.provide(permission),
        Layer.provide(recordingStore),
        Layer.provide(transcriber),
        Layer.provide(settings.layer),
        Layer.provide(modeLayer),
        Layer.provide(ownerLayer),
        Layer.provide(
          fakeModelManagerLayer(
            options.installedModels ?? {
              [options.transcription?.modelId ?? RECOMMENDED_MODEL_ID]: '/models/fixture.bin',
            }
          )
        ),
        // RecordingServiceLive self-publishes into the boot-scoped bridge; a
        // throwaway leaf satisfies the dep (these tests exercise the service, not
        // the bridge — the IPC round-trip is covered in ipc.test.ts).
        Layer.provide(RecordingBridgeLive),
        Layer.provide(Layer.succeed(MicActivity, { latest: micActivityLatest }))
      )
    );
    const svcCtx = yield* Layer.build(svcLayer).pipe(
      Effect.provide(envCtx),
      Scope.extend(sessionScope),
      Effect.orDie
    );

    return {
      service: Context.get(svcCtx, RecordingService),
      db,
      product: Context.get(svcCtx, ProductDb),
      fakeCapture,
      fakeCloud,
      fakePermissions,
      logger,
      settings,
      micActivityLatest,
      sessionScope,
      drain: drainRecoveries(
        Effect.succeed(null),
        Context.get(svcCtx, RecordingService).resolveCompletion
      ).pipe(Effect.provide(svcCtx), Effect.provide(envCtx)),
      recoveryDir: (recordingId: string) => path.join(userDataDir, 'recovery', recordingId),
    } satisfies Harness;
  });

const oneSecond = (): Float32Array => new Float32Array(48_000).fill(0.25);
/** N seconds of audio — used to fill a full fixed chunk (15 s) plus tails. */
const seconds = (n: number): Float32Array => new Float32Array(n * 48_000).fill(0.25);

const zoomMicActivity = (uid: string, timestampMs: number): Option.Option<LatestMicActivity> =>
  Option.some({
    receivedAtMs: timestampMs,
    snapshot: {
      timestampMs,
      apps: [
        {
          bundleId: 'us.zoom.xos',
          pid: 42,
          detectedAtMs: timestampMs,
          inputDevices: [{ uid, name: uid }],
        },
      ],
    },
  });

const assertWav = (wav: Uint8Array, expectedSamples: number): void => {
  const buf = Buffer.from(wav);
  assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(buf.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(buf.readUInt32LE(40), expectedSamples * 2, 'data size = samples * 2');
  assert.strictEqual(buf.length, 44 + expectedSamples * 2);
};

const status = (h: Harness, recordingId: string): Effect.Effect<string | undefined> =>
  h.db.getRecoveryOutbox(recordingId).pipe(
    Effect.map(row => row?.status),
    Effect.orDie
  );

// Persisted product-store rows: recording and transcript segments.
const productRecording = (h: Harness, id: string) =>
  Effect.promise(async () => {
    const rows = await h.product.db
      .select()
      .from(productSchema.recording)
      .where(eq(productSchema.recording.id, id));
    return rows[0];
  });

const productSegments = (h: Harness, recordingId: string) =>
  Effect.promise(() =>
    h.product.db
      .select()
      .from(productSchema.transcriptSegment)
      .where(eq(productSchema.transcriptSegment.recordingId, recordingId))
      .orderBy(asc(productSchema.transcriptSegment.segmentOrder))
  );

describe('RecordingService (capture → recovery WAV → chunked upload → outbox)', () => {
  it.effect('cuts every 15 seconds of audio independently of two-second uploads', () =>
    Effect.gen(function* () {
      const started: number[] = [];
      const h = yield* setup({}, undefined, {
        backendTransform: api => ({
          ...api,
          uploadTranscriptionChunk: (id, params, wav) =>
            Effect.gen(function* () {
              started.push(yield* Clock.currentTimeMillis);
              yield* Effect.sleep(Duration.seconds(2));
              return yield* api.uploadTranscriptionChunk(id, params, wav);
            }),
        }),
      });
      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'capture ready'
      );
      const startedAt = yield* Clock.currentTimeMillis;
      const session = h.fakeCapture.current();
      const wavPath = path.join(h.recoveryDir(recordingId), 'mic.wav');
      for (let elapsed = 5; elapsed <= 45; elapsed += 5) {
        yield* TestClock.adjust(Duration.seconds(5));
        yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(5)));
        yield* poll(
          Effect.sync(
            () => fs.existsSync(wavPath) && fs.statSync(wavPath).size === 44 + elapsed * 48_000 * 2
          ),
          'captured frame written'
        );
        yield* settle;
        assert.strictEqual(started.length, Math.floor(elapsed / 15));
      }
      assert.deepStrictEqual(
        started.map(time => time - startedAt),
        [15_000, 30_000, 45_000]
      );
      yield* TestClock.adjust(Duration.seconds(2));
      yield* h.service.stop(recordingId);
      assert.deepStrictEqual(
        h.fakeCloud.uploadCalls.map(call => call.params.chunkStartMs),
        [0, 15_000, 30_000]
      );
      for (const call of h.fakeCloud.uploadCalls) assertWav(call.wav, 15 * 16_000);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect(
    'server staging uploads silent dual chunks and tails before finalizing without a settings lookup',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const recordingId = yield* h.service.start({ captureMode: 'dual' });
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'capture ready'
        );
        const session = h.fakeCapture.current();
        yield* Queue.offer(session.frames, fakeFrame('mic_processed', seconds(16)));
        yield* Queue.offer(session.frames, fakeFrame('system', new Float32Array(16 * 48_000)));
        yield* settle;
        yield* TestClock.adjust(CHUNK_INTERVAL);
        yield* poll(
          Effect.sync(() => h.fakeCloud.uploadCalls.length === 2),
          'full dual chunks'
        );
        assert.isTrue(fs.existsSync(path.join(h.recoveryDir(recordingId), 'system.wav')));
        yield* h.service.stop(recordingId);
        assert.deepStrictEqual(
          h.fakeCloud.uploadCalls.map(call => call.params),
          [
            { chunkIndex: 0, chunkStartMs: 0, source: 'mic' },
            { chunkIndex: 1, chunkStartMs: 0, source: 'system' },
            { chunkIndex: 2, chunkStartMs: 15_000, source: 'mic' },
            { chunkIndex: 3, chunkStartMs: 15_000, source: 'system' },
          ]
        );
        for (const call of h.fakeCloud.uploadCalls) {
          assertWav(call.wav, call.params.chunkIndex < 2 ? 240_000 : 16_000);
          const wav = Buffer.from(call.wav);
          assert.strictEqual(wav.readUInt16LE(20), 1, 'PCM');
          assert.strictEqual(wav.readUInt16LE(22), 1, 'mono');
          assert.strictEqual(wav.readUInt32LE(24), 16_000);
          assert.strictEqual(wav.readUInt16LE(34), 16);
          assert.isBelow(wav.length - 44, 4 * 1024 * 1024);
          if (call.params.source === 'system')
            assert.isTrue(wav.subarray(44).every(byte => byte === 0));
        }
        assert.isBelow(
          h.fakeCloud.timeline.indexOf('upload:3'),
          h.fakeCloud.timeline.indexOf('finalize')
        );
        assert.strictEqual(h.fakeCloud.finalizeCalls[0].input.durationMs, 16_000);
        const terminal = h.logger.entries.filter(entry =>
          [
            'Recording capture ended',
            'Recording processing attempt ended',
            'Recording completed',
          ].includes(entry.message)
        );
        assert.lengthOf(terminal, 3);
        assert.isTrue(
          terminal.every(
            entry =>
              entry.level === 'info' &&
              (entry.data as { recordingId: string; outcome: string }).recordingId ===
                recordingId &&
              (entry.data as { outcome: string }).outcome === 'success'
          )
        );
        assert.strictEqual(
          (
            terminal.find(entry => entry.message === 'Recording capture ended')?.data as {
              audioDurationMs: number;
            }
          ).audioDurationMs,
          16_000
        );

        assert.deepStrictEqual(Object.keys(h.fakeCloud.finalizeCalls[0].input).sort(), [
          'durationMs',
          'endedAt',
        ]);
        assert.deepStrictEqual(
          h.fakeCloud.requestCalls,
          [{ method: 'GET', path: '/apps/v1/me/model-defaults' }],
          'loads the transcription default once, without a full-session upload request'
        );
        assert.isTrue(fs.existsSync(h.recoveryDir(recordingId)), 'recovery retained until drain');
        yield* h.drain;
        assert.deepStrictEqual(h.fakeCloud.requestCalls, [
          { method: 'GET', path: '/apps/v1/me/model-defaults' },
        ]);
        assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));
        assert.isFalse(fs.existsSync(h.recoveryDir(recordingId)));
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('localizes the cloud title when a caller omits one', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        Effect.sync(() => h.fakeCloud.createCalls.length === 1),
        'localized createRecording'
      );

      assert.strictEqual(h.fakeCloud.createCalls[0]?.title, 'Unbenannte Aufnahme');
      yield* h.service.stop(recordingId);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect(
    'happy path: dual → 2 chunks (index/startMs/source) → stop → finalize → WAV+outbox deleted',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.fakeCloud.setUploadResponder(call => ({
          ok: true,
          value: [
            fakeSegment(call.recordingId, call.params.source, call.params.chunkIndex, 'hello'),
          ],
        }));

        const recordingId = yield* h.service.start({
          captureMode: 'dual',
          noteId: 'nt_1',
          title: 'Standup',
        });
        assert.match(recordingId, /^rec_/);

        // Row opened 'capturing' BEFORE frames; cloud recording created.
        yield* poll(
          Effect.sync(
            () => h.fakeCapture.sessions.length === 1 && h.fakeCloud.createCalls.length === 1
          ),
          'capture acquired + createRecording'
        );
        const opened = yield* h.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(opened?.status, 'capturing');
        assert.strictEqual(opened?.captureMode, 'dual');
        assert.strictEqual(opened?.engine, 'cloud', 'frozen engine kind stamped at start');
        assert.strictEqual(opened?.noteId, 'nt_1');
        assert.strictEqual(opened?.wavPath, h.recoveryDir(recordingId));
        assert.isNull(opened?.lastChunkIndex);
        assert.strictEqual(h.fakeCloud.createCalls[0].captureMode, 'dual');

        // The start also mirrored a product-store recording row with
        // the cloud-create fields (ISO startedAt, status 'recording').
        yield* poll(
          productRecording(h, recordingId).pipe(Effect.map(row => row !== undefined)),
          'product recording row persisted'
        );
        const created = (yield* productRecording(h, recordingId))!;
        assert.strictEqual(created.status, 'recording');
        assert.strictEqual(created.title, 'Standup');
        assert.strictEqual(created.captureMode, 'dual');
        assert.strictEqual(created.noteId, 'nt_1');
        assert.isNotNull(created.startedAt);
        assert.isFalse(Number.isNaN(Date.parse(created.startedAt!)), 'startedAt stored as ISO');

        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'observable status recording'
        );

        // 16 s of mic (post-AEC) + system (mic_raw dropped in dual): one COMPLETE 15 s
        // chunk per source cut on arrival, a 1 s remainder flushed as the tail at stop.
        const session = h.fakeCapture.current();
        yield* Queue.offer(session.frames, fakeFrame('mic_processed', seconds(16)));
        yield* Queue.offer(session.frames, fakeFrame('system', seconds(16)));
        yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(16)));
        yield* settle;

        // Frame arrival cuts the COMPLETE fixed 15 s chunks (mic before system).
        yield* poll(
          Effect.sync(() => h.fakeCloud.uploadCalls.length === 2),
          'two complete chunks cut on arrival'
        );

        const mic = h.fakeCloud.uploadCalls.find(c => c.params.source === 'mic');
        const sys = h.fakeCloud.uploadCalls.find(c => c.params.source === 'system');
        assert.isDefined(mic);
        assert.isDefined(sys);
        assert.strictEqual(mic!.params.chunkIndex, 0, 'mic cut first → lowest global index');
        assert.strictEqual(sys!.params.chunkIndex, 1);
        assert.strictEqual(mic!.params.chunkStartMs, 0);
        assert.strictEqual(sys!.params.chunkStartMs, 0);
        assertWav(mic!.wav, 240_000);
        assertWav(sys!.wav, 240_000);

        yield* poll(
          h.db.getRecoveryOutbox(recordingId).pipe(Effect.map(r => r?.lastChunkIndex === 1)),
          'lastChunkIndex advanced to 1'
        );
        const mid = yield* SubscriptionRef.get(h.service.state);
        assert.strictEqual(mid.segments.length, 2, 'live segments accumulated on the observable');
        // Both returned wire segments landed in the product store,
        // normalized (isFinal ?? true, deletedAt ?? null).
        yield* poll(
          productSegments(h, recordingId).pipe(Effect.map(rows => rows.length === 2)),
          'segments persisted after chunk ok'
        );
        const midRows = yield* productSegments(h, recordingId);
        assert.deepStrictEqual(
          midRows.map(row => [row.segmentOrder, row.source, row.isFinal, row.deletedAt]),
          [
            [1_000_000, 'mic', true, null],
            [1_001_000, 'system', true, null],
          ]
        );
        assert.isTrue(fs.existsSync(path.join(h.recoveryDir(recordingId), 'mic.wav')));
        assert.isTrue(fs.existsSync(path.join(h.recoveryDir(recordingId), 'system.wav')));

        // Stop → flushTail emits the 1 s partial tail per source (indices 2,3 @ 15_000 ms)
        // → finalize → delete (all four chunks acknowledged).
        yield* h.service.stop(recordingId);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 4, 'periodic 2 + graceful-stop tail 2');
        const micTail = h.fakeCloud.uploadCalls.find(c => c.params.chunkIndex === 2);
        const sysTail = h.fakeCloud.uploadCalls.find(c => c.params.chunkIndex === 3);
        assert.strictEqual(micTail?.params.source, 'mic');
        assert.strictEqual(micTail?.params.chunkStartMs, 15_000);
        assertWav(micTail!.wav, 16_000);
        assert.strictEqual(sysTail?.params.source, 'system');
        assert.strictEqual(sysTail?.params.chunkStartMs, 15_000);
        assertWav(sysTail!.wav, 16_000);

        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
        assert.strictEqual(h.fakeCloud.finalizeCalls[0].recordingId, recordingId);
        assert.isTrue(h.fakeCloud.finalizeCalls[0].input.durationMs >= 0);

        // Finalize marked the product-store row completed (the
        // stop path awaits the write inline) and cached all four segments.
        const finished = (yield* productRecording(h, recordingId))!;
        assert.strictEqual(finished.status, 'completed');
        assert.strictEqual(finished.durationMs, h.fakeCloud.finalizeCalls[0].input.durationMs);
        assert.strictEqual(
          finished.endedAt,
          new Date(h.fakeCloud.finalizeCalls[0].input.endedAt).toISOString()
        );
        assert.strictEqual((yield* productSegments(h, recordingId)).length, 4);

        assert.strictEqual((yield* h.db.getRecoveryOutbox(recordingId))?.phase, 'cleanup');
        yield* h.drain;
        assert.isNull(
          yield* h.db.getRecoveryOutbox(recordingId),
          'outbox row deleted after cleanup'
        );
        assert.isFalse(fs.existsSync(h.recoveryDir(recordingId)), 'recovery WAV deleted');
        assert.isTrue(h.fakeCapture.current().released, 'capture child reaped on stop');

        const done = yield* SubscriptionRef.get(h.service.state);
        assert.strictEqual(done.status, 'idle');
        assert.strictEqual(done.recordingId, recordingId, 'finished id retained for the UI');

        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('best-effort product-store write failures preserve the live completion count', () =>
    Effect.gen(function* () {
      const dbError = (op: string) => Effect.fail(new ProductDbError({ op, cause: 'boom' }));
      const failingStore: RecordingStoreApi = {
        recordingStarted: () => dbError('recording-started'),
        recordingCompleted: () => dbError('recording-completed'),
        recordingFailed: () => dbError('recording-failed'),
        segmentsReceived: () => dbError('segments-received'),
        segmentsForRecording: () => Effect.succeed([]),
        recordingMetaMerged: () => dbError('recording-meta-merged'),
      };
      const h = yield* setup({}, Layer.succeed(RecordingStore, failingStore));
      h.fakeCloud.setUploadResponder(call => ({
        ok: true,
        value: [fakeSegment(call.recordingId, call.params.source, call.params.chunkIndex, 'hi')],
      }));

      const recordingId = yield* h.service.start({ captureMode: 'mic', title: 'Best effort' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording despite the failing store'
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', seconds(15)));
      yield* settle;
      yield* TestClock.adjust(CHUNK_INTERVAL);
      yield* poll(
        Effect.sync(() => h.fakeCloud.uploadCalls.length === 1),
        'chunk uploaded despite the failing store'
      );
      yield* h.service.stop(recordingId);

      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1, 'finalize still ran');
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'idle');
      assert.deepStrictEqual((yield* SubscriptionRef.get(h.service.state)).completedRecordings, [
        { recordingId, noteId: null, segments: 1 },
      ]);
      // Every failed write folded to the warn (start / segments / completed).
      const warns = h.logger.entries.filter(
        entry => entry.level === 'warn' && entry.message === 'recording persistence failed'
      );
      assert.isAtLeast(warns.length, 3);
      assert.strictEqual((warns[0]?.data as { recordingId: string }).recordingId, recordingId);

      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('holds a complete system chunk until the stalled dual mic lane catches up', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'dual', title: 'Mic stall' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'observable status recording'
      );
      const session = h.fakeCapture.current();

      yield* Queue.offer(session.frames, fakeFrame('mic_processed', seconds(14)));
      yield* Queue.offer(session.frames, fakeFrame('system', seconds(16)));
      yield* settle;
      yield* TestClock.adjust(CHUNK_INTERVAL);
      yield* settle;
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 0, 'system waits at the shared boundary');

      yield* Queue.offer(session.frames, fakeFrame('mic_processed', oneSecond()));
      yield* settle;
      yield* TestClock.adjust(CHUNK_INTERVAL);
      yield* poll(
        Effect.sync(() => h.fakeCloud.uploadCalls.length === 2),
        'paired chunks uploaded'
      );
      assert.deepStrictEqual(
        h.fakeCloud.uploadCalls.map(call => [call.params.source, call.params.chunkIndex]),
        [
          ['mic', 0],
          ['system', 1],
        ]
      );

      yield* h.service.stop(recordingId);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 3);
      assert.strictEqual(h.fakeCloud.uploadCalls[2].params.source, 'system');
      assert.strictEqual(h.fakeCloud.uploadCalls[2].params.chunkIndex, 2);
      assertWav(h.fakeCloud.uploadCalls[2].wav, 16_000);

      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect(
    'pause flushes the partial chunk, discards paused frames, and resumes the same sample timeline',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const recordingId = yield* h.service.start({ captureMode: 'mic', title: 'Pause' });
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording before pause'
        );
        const session = h.fakeCapture.current();

        yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(2)));
        yield* settle;
        assert.isTrue(yield* h.service.pause(recordingId));

        const paused = yield* SubscriptionRef.get(h.service.state);
        assert.strictEqual(paused.status, 'paused');
        assert.strictEqual(paused.recordingId, recordingId);
        assert.strictEqual(paused.elapsedMs, 2_000);
        assert.strictEqual(yield* SubscriptionRef.get(h.service.level), 0);
        yield* poll(
          Effect.sync(() => h.fakeCloud.uploadCalls.length === 1),
          'pause tail uploaded'
        );
        assert.strictEqual(h.fakeCloud.uploadCalls[0].recordingId, recordingId);
        assert.deepStrictEqual(h.fakeCloud.uploadCalls[0].params, {
          chunkIndex: 0,
          chunkStartMs: 0,
          source: 'mic',
        });
        assertWav(h.fakeCloud.uploadCalls[0].wav, 32_000);
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0, 'pause never finalizes');

        const pausedRow = yield* h.db.getRecoveryOutbox(recordingId);
        assert.deepStrictEqual(pausedRow?.pauseCutPoints, [
          { micSamples: 96_000, systemSamples: 0 },
        ]);
        const wavPath = path.join(h.recoveryDir(recordingId), 'mic.wav');
        const bytesAtPause = fs.statSync(wavPath).size;

        // The helper/session remains alive, but frames delivered during pause are
        // discarded before both the recovery WAV and upload chunker.
        yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(3)));
        yield* settle;
        yield* TestClock.adjust(Duration.seconds(20));
        yield* settle;
        assert.strictEqual(h.fakeCapture.sessions.length, 1);
        assert.isFalse(session.released);
        assert.strictEqual(fs.statSync(wavPath).size, bytesAtPause);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).elapsedMs, 2_000);

        const busy = yield* Effect.exit(h.service.start({ captureMode: 'mic' }));
        assert.isTrue(Exit.isFailure(busy), 'paused recording still owns Semaphore(1)');

        assert.isTrue(yield* h.service.resume(recordingId));
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'recording');
        yield* Queue.offer(session.frames, fakeFrame('mic_raw', oneSecond()));
        yield* settle;
        yield* h.service.stop(recordingId);

        assert.strictEqual(h.fakeCloud.uploadCalls.length, 2);
        assert.deepStrictEqual(h.fakeCloud.uploadCalls[1].params, {
          chunkIndex: 1,
          chunkStartMs: 2_000,
          source: 'mic',
        });
        assertWav(h.fakeCloud.uploadCalls[1].wav, 16_000);
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
        assert.strictEqual(h.fakeCloud.finalizeCalls[0].recordingId, recordingId);
        assert.strictEqual(h.fakeCloud.finalizeCalls[0].input.durationMs, 3_000);

        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('pause/resume guards are idempotent and stop finalizes directly from paused', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording before guard checks'
      );
      const session = h.fakeCapture.current();
      yield* Queue.offer(session.frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;

      assert.isFalse(yield* h.service.pause('rec_stale'));
      assert.isFalse(yield* h.service.resume(recordingId));
      assert.isTrue(yield* h.service.pause(recordingId));
      assert.isFalse(yield* h.service.pause(recordingId));
      yield* h.service.stop(recordingId);

      assert.strictEqual(
        h.fakeCloud.uploadCalls.length,
        1,
        'stop did not duplicate the pause tail'
      );
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
      assert.strictEqual(h.fakeCloud.finalizeCalls[0].input.durationMs, 1_000);
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'idle');

      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('a helper restart while paused stays paused until explicit resume', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        Effect.sync(() => h.fakeCapture.sessions.length === 1),
        'first capture'
      );
      const first = h.fakeCapture.current();
      yield* Queue.offer(first.frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;
      assert.isTrue(yield* h.service.pause(recordingId));

      yield* Deferred.fail(first.terminated, new CaptureExitError({ code: 1, signal: null }));
      yield* TestClock.adjust(Duration.seconds(1));
      yield* poll(
        Effect.sync(() => h.fakeCapture.sessions.length === 2),
        'capture restarted paused'
      );
      const restarted = h.fakeCapture.current();
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'paused');

      yield* Queue.offer(restarted.frames, fakeFrame('mic_raw', seconds(4)));
      yield* settle;
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 1, 'restarted helper frames stayed gated');
      assert.isTrue(yield* h.service.resume(recordingId));
      yield* Queue.offer(restarted.frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;
      yield* h.service.stop(recordingId);

      assert.strictEqual(h.fakeCloud.finalizeCalls[0].input.durationMs, 2_000);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 2);

      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('workspace close cancels a blocked upload and retains queued audio for recovery', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const h = yield* setup({}, undefined, {
        backendTransform: api => ({
          ...api,
          uploadTranscriptionChunk: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
        }),
      });
      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        Effect.sync(() => h.fakeCapture.sessions.length === 1),
        'capture acquired'
      );
      yield* poll(
        status(h, recordingId).pipe(Effect.map(s => s === 'capturing')),
        'outbox capturing'
      );

      const session = h.fakeCapture.current();
      yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(46)));
      yield* Deferred.await(entered);

      // Sign-out / quit must finish without waiting for the blocked upload.
      yield* Scope.close(h.sessionScope, Exit.void);

      assert.isTrue(session.released, 'native child interrupted on scope close');
      const parked = yield* h.db.getRecoveryOutbox(recordingId);
      assert.strictEqual(parked?.status, 'interrupted', 'row parked (not deleted)');
      assert.isNull(parked?.lastChunkIndex, 'unacknowledged chunks remain replayable');
      const wavPath = path.join(h.recoveryDir(recordingId), 'mic.wav');
      assert.isTrue(fs.existsSync(wavPath), 'WAV retained for the drain');
      const wav = fs.readFileSync(wavPath);
      assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
      assert.strictEqual(
        wav.readUInt32LE(40),
        46 * 48_000 * 2,
        'all audio retained and WAV header patched by the recovery finalizer'
      );
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0, 'no finalize on interrupt');
    })
  );

  it.effect('interrupt while paused parks the persisted cut point and pause-compressed WAV', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        Effect.sync(() => h.fakeCapture.sessions.length === 1),
        'capture acquired'
      );
      const session = h.fakeCapture.current();
      yield* Queue.offer(session.frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;
      assert.isTrue(yield* h.service.pause(recordingId));

      yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(3)));
      yield* settle;
      yield* Scope.close(h.sessionScope, Exit.void);

      const parked = yield* h.db.getRecoveryOutbox(recordingId);
      assert.strictEqual(parked?.status, 'interrupted');
      assert.deepStrictEqual(parked?.pauseCutPoints, [{ micSamples: 48_000, systemSamples: 0 }]);
      const wav = fs.readFileSync(path.join(h.recoveryDir(recordingId), 'mic.wav'));
      assert.strictEqual(wav.length, 44 + 48_000 * 2, 'paused frames never reached recovery');
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      assert.isTrue(session.released);
    })
  );

  it.effect('level: frames feed the smoothed RMS; every exit path resets it', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.strictEqual(yield* SubscriptionRef.get(h.service.level), 0);

      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        Effect.sync(() => h.fakeCapture.sessions.length === 1),
        'capture acquired'
      );
      assert.match(recordingId, /^rec_/);
      // startedAt stamped on the observable state (the dock timer's source).
      assert.isNotNull((yield* SubscriptionRef.get(h.service.state)).startedAt);

      // A 0.25-filled frame: RMS 0.25, ×3 scaling → 0.75; EMA from 0 → 0.3.
      const session = h.fakeCapture.current();
      yield* Queue.offer(session.frames, fakeFrame('mic_raw', oneSecond()));
      yield* poll(
        SubscriptionRef.get(h.service.level).pipe(Effect.map(l => l > 0.29)),
        'level fed from the frame'
      );
      assert.approximately(yield* SubscriptionRef.get(h.service.level), 0.3, 0.01);

      // An ABNORMAL end (session interrupt — not a graceful stop) still resets:
      // the reset rides the body finalizer, so no exit path leaks a stale EMA.
      yield* Scope.close(h.sessionScope, Exit.void);
      assert.strictEqual(yield* SubscriptionRef.get(h.service.level), 0);
    })
  );

  it.effect('capture crash → bounded restart while signed in → recording continues', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'system' });
      yield* poll(
        Effect.sync(() => h.fakeCapture.sessions.length === 1),
        'first capture'
      );

      yield* Deferred.fail(
        h.fakeCapture.sessions[0].terminated,
        new CaptureExitError({ code: 1, signal: null })
      );
      yield* settle;
      yield* TestClock.adjust(Duration.seconds(1)); // first exponential backoff step
      yield* poll(
        Effect.sync(() => h.fakeCapture.sessions.length === 2),
        'capture restarted after backoff'
      );
      assert.isTrue(h.fakeCapture.sessions[0].released, 'crashed child reaped');

      const restarted = h.fakeCapture.current();
      yield* Queue.offer(restarted.frames, fakeFrame('system', seconds(15))); // one full fixed chunk
      yield* settle;
      yield* TestClock.adjust(CHUNK_INTERVAL);
      yield* poll(
        Effect.sync(() => h.fakeCloud.uploadCalls.length === 1),
        'chunk uploaded post-restart'
      );
      assert.strictEqual(h.fakeCloud.uploadCalls[0].params.source, 'system');
      assert.strictEqual(yield* status(h, recordingId), 'capturing', 'still active (not failed)');

      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('persistent capture failure → recording ENDS (not an infinite loop)', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'system' });
      // A failed recording keeps its row (parkOnExit marks 'failed'), so it never
      // vanishes — wait for the row to open, then crash each capture as it spawns.
      yield* poll(
        status(h, recordingId).pipe(Effect.map(s => s === 'capturing')),
        'initial capturing'
      );

      let crashed = 0;
      for (let guard = 0; guard < 40; guard += 1) {
        if ((yield* SubscriptionRef.get(h.service.state)).status === 'error') break;
        if (crashed < h.fakeCapture.sessions.length) {
          const session = h.fakeCapture.sessions[crashed];
          if (!session.released) {
            yield* Deferred.fail(
              session.terminated,
              new CaptureExitError({ code: 139, signal: null })
            );
          }
          crashed += 1;
        }
        yield* settle;
        yield* TestClock.adjust(Duration.seconds(11)); // past any capped backoff
        yield* settle;
      }

      assert.strictEqual(
        yield* status(h, recordingId),
        'finalizing',
        'a persistently-failing capture ends acquisition while retaining processing'
      );
      assert.isBelow(h.fakeCapture.sessions.length, 12, 'restarts are bounded (no infinite loop)');
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'error');
      // Give-up also failed the product-store row.
      yield* poll(
        productRecording(h, recordingId).pipe(Effect.map(row => row?.status === 'completed')),
        'captured recording finalized'
      );
      assert.isTrue(
        fs.existsSync(h.recoveryDir(recordingId)),
        'WAV retained on give-up (not deleted)'
      );

      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('a retryable upload failure keeps the WAV and does NOT advance lastChunkIndex', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      let uploads = 0;
      h.fakeCloud.setUploadResponder(() => {
        uploads += 1;
        return uploads === 1
          ? { ok: false as const, retryable: true, failure: { kind: 'http' as const, status: 503 } }
          : { ok: true as const, value: [] };
      });

      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        Effect.sync(() => h.fakeCapture.sessions.length === 1),
        'capture acquired'
      );

      const session = h.fakeCapture.current();
      yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(15))); // one full fixed chunk
      yield* settle;
      yield* TestClock.adjust(CHUNK_INTERVAL);
      yield* poll(
        Effect.sync(() => h.fakeCloud.uploadCalls.length === 1),
        'first chunk attempted (fails retryable)'
      );

      // A later chunk uploads OK, but the cursor stays frozen behind the gap.
      yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(15)));
      yield* settle;
      yield* TestClock.adjust(CHUNK_INTERVAL);
      yield* poll(
        Effect.sync(() => h.fakeCloud.uploadCalls.length === 2),
        'second chunk attempted (ok)'
      );

      const row = yield* h.db.getRecoveryOutbox(recordingId);
      assert.isNull(row?.lastChunkIndex, 'cursor not advanced past the retryable-failed chunk');
      assert.strictEqual(row?.status, 'capturing');
      assert.isTrue(
        fs.existsSync(path.join(h.recoveryDir(recordingId), 'mic.wav')),
        'audio retained in the WAV'
      );

      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect(
    'session quota and recording-length failures halt live uploads while retaining audio',
    () =>
      Effect.gen(function* () {
        for (const [status, code] of [
          [429, 'PROVIDER_QUOTA_EXCEEDED'],
          [413, 'RECORDING_LENGTH_EXCEEDED'],
        ] as const) {
          const h = yield* setup();
          h.fakeCloud.setUploadResponder(() => laneFail(false, { kind: 'http', status, code }));
          const recordingId = yield* h.service.start({ captureMode: 'mic' });
          yield* poll(
            Effect.sync(() => h.fakeCapture.sessions.length === 1),
            'capture acquired'
          );
          const session = h.fakeCapture.current();
          yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(15)));
          yield* settle;
          yield* TestClock.adjust(CHUNK_INTERVAL);
          yield* poll(
            Effect.sync(() => h.fakeCloud.uploadCalls.length === 1),
            'session rejected'
          );
          yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(15)));
          yield* settle;
          yield* TestClock.adjust(CHUNK_INTERVAL);
          yield* h.service.stop(recordingId);
          assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
          assert.isNull((yield* h.db.getRecoveryOutbox(recordingId))?.lastChunkIndex);
          assert.isTrue(fs.existsSync(path.join(h.recoveryDir(recordingId), 'mic.wav')));
          assert.strictEqual((yield* h.drain).failed, 1);
          assert.isTrue(fs.existsSync(path.join(h.recoveryDir(recordingId), 'mic.wav')));
          yield* Scope.close(h.sessionScope, Exit.void);
        }
      })
  );

  it.effect(
    'provider cooldown keeps capture and Stop responsive and survives recovery handoff',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.fakeCloud.setUploadResponder(() =>
          laneFail(true, {
            kind: 'http',
            status: 429,
            code: 'PROVIDER_RATE_LIMITED',
            retryAfterMs: 90_000,
          })
        );
        const recordingId = yield* h.service.start({ captureMode: 'mic' });
        yield* poll(
          Effect.sync(() => h.fakeCapture.sessions.length === 1),
          'capture acquired'
        );
        const session = h.fakeCapture.current();
        yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(15)));
        yield* settle;
        yield* TestClock.adjust(CHUNK_INTERVAL);
        yield* poll(
          h.db.getRecoveryOutbox(recordingId).pipe(Effect.map(row => row?.nextAttemptAt !== null)),
          'provider retry deadline saved'
        );
        const deadline = (yield* h.db.getRecoveryOutbox(recordingId))!.nextAttemptAt!;

        yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(15)));
        yield* settle;
        yield* TestClock.adjust(CHUNK_INTERVAL);
        yield* h.service.stop(recordingId);
        assert.strictEqual(
          h.fakeCloud.uploadCalls.length,
          1,
          'no request during provider cooldown'
        );
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'idle');
        const row = yield* h.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(row?.nextAttemptAt, deadline);
        assert.isNull(row?.lastChunkIndex, 'skipped audio stays behind the recovery cursor');
        assert.isTrue(fs.existsSync(path.join(h.recoveryDir(recordingId), 'mic.wav')));
        assert.strictEqual((yield* h.drain).deferred, 1);

        h.fakeCloud.setUploadResponder(() => ({ ok: true, value: [] }));
        yield* TestClock.adjust(
          Duration.millis(Date.parse(deadline) - (yield* Clock.currentTimeMillis))
        );
        assert.strictEqual((yield* h.drain).resolved, 1);
        assert.deepStrictEqual(
          h.fakeCloud.uploadCalls.map(call => call.params.chunkIndex),
          [0, 0, 1]
        );
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('keeps all audio and pauses while an upload is blocked beyond 30 seconds', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* setup({}, undefined, {
        backendTransform: api => ({
          ...api,
          uploadTranscriptionChunk: (id, params, wav) =>
            (params.chunkIndex === 0
              ? Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Deferred.await(release)))
              : Effect.void
            ).pipe(Effect.zipRight(api.uploadTranscriptionChunk(id, params, wav))),
        }),
      });
      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'capture ready'
      );
      const session = h.fakeCapture.current();
      yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(15)));
      yield* Deferred.await(entered);
      yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(46)));
      const wavPath = path.join(h.recoveryDir(recordingId), 'mic.wav');
      yield* poll(
        Effect.sync(() => fs.statSync(wavPath).size === 44 + 61 * 48_000 * 2),
        'all 61 seconds saved while upload remains blocked'
      );
      const pausing = yield* Effect.fork(h.service.pause(recordingId));
      yield* poll(
        Fiber.poll(pausing).pipe(Effect.map(Option.isSome)),
        'pause does not wait for upload'
      );
      assert.isTrue(yield* Fiber.join(pausing));
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
      assert.isTrue(yield* h.service.resume(recordingId));
      yield* Queue.offer(session.frames, fakeFrame('mic_raw', oneSecond()));
      yield* poll(
        Effect.sync(() => fs.statSync(wavPath).size === 44 + 62 * 48_000 * 2),
        'capture resumed while upload remains blocked'
      );
      const stopping = yield* Effect.fork(h.service.stop(recordingId));
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(
          Effect.map(s => s.status === 'idle' && s.finalizingRecordingIds.length > 0)
        ),
        'capture stopped before the upload finishes'
      );
      assert.isTrue(Option.isNone(yield* Fiber.poll(stopping)));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      assert.deepStrictEqual(
        h.fakeCloud.uploadCalls.map(call => [call.params.chunkIndex, call.params.chunkStartMs]),
        [
          [0, 0],
          [1, 15_000],
          [2, 30_000],
          [3, 45_000],
          [4, 60_000],
          [5, 61_000],
        ]
      );
      const uploadedPcm = Buffer.concat(
        h.fakeCloud.uploadCalls.map(call => Buffer.from(call.wav).subarray(44))
      );
      assert.strictEqual(uploadedPcm.length, 62 * 16_000 * 2);
      const retainedPcm = fs.readFileSync(wavPath).subarray(44);
      assert.strictEqual(retainedPcm.length, uploadedPcm.length * 3);
      // This fixture is constant amplitude: filtered uploads preserve every
      // sample's value while the retained recording keeps all 48 kHz samples.
      assert.isTrue(
        uploadedPcm.every((byte, i) => byte === retainedPcm[Math.floor(i / 2) * 6 + (i % 2)])
      );
      assert.strictEqual(h.fakeCloud.finalizeCalls[0].input.durationMs, 62_000);
      assert.strictEqual((yield* h.db.getRecoveryOutbox(recordingId))?.phase, 'cleanup');
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('Semaphore(1): a second concurrent start is rejected (one active recording)', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.service.start({ captureMode: 'dual' });

      const exit = yield* Effect.exit(h.service.start({ captureMode: 'mic' }));
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      assert.instanceOf(error, RecordingBusyError);
      assert.strictEqual((error as RecordingBusyError).activeRecordingId, first);

      yield* settle;
      assert.strictEqual(h.fakeCapture.sessions.length, 1, 'only one capture child spun up');
      assert.strictEqual(h.fakeCloud.createCalls.length, 1);
      assert.strictEqual(h.fakeCloud.createCalls[0].recordingId, first);

      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  // ---- Permission gate on start ----

  it.effect('mic denied → start fails PermissionError; NO spawn, NO outbox row, NO create', () =>
    Effect.gen(function* () {
      const h = yield* setup({ micStatus: 'denied' });

      const exit = yield* Effect.exit(h.service.start({ captureMode: 'mic' }));
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      assert.instanceOf(error, PermissionError);
      assert.strictEqual((error as PermissionError).reason, 'mic-denied');

      yield* settle;
      assert.strictEqual(
        h.fakeCapture.sessions.length,
        0,
        'no capture child spawned when mic denied'
      );
      assert.strictEqual(h.fakeCloud.createCalls.length, 0, 'no cloud recording created');

      // Observable stayed idle — nothing started.
      const st = yield* SubscriptionRef.get(h.service.state);
      assert.strictEqual(st.status, 'idle');
      assert.isNull(st.recordingId);

      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect(
    'dual with system audio unavailable (< 14.2) → spawns mic-only; state surfaces the degrade',
    () =>
      Effect.gen(function* () {
        const h = yield* setup({ systemVersion: '14.1.0', micStatus: 'granted' });

        const recordingId = yield* h.service.start({ captureMode: 'dual', noteId: 'nt_deg' });
        yield* poll(
          Effect.sync(() => h.fakeCapture.sessions.length === 1),
          'capture acquired (degraded)'
        );

        // The native child is spawned with the mode it can satisfy: mic.
        assert.strictEqual(h.fakeCapture.current().mode, 'mic', 'capture spawned mic-only');
        yield* poll(
          Effect.sync(() => h.fakeCloud.createCalls.length === 1),
          'cloud recording created'
        );
        assert.strictEqual(
          h.fakeCloud.createCalls[0].captureMode,
          'mic',
          'cloud recording reflects the effective mode'
        );

        // Outbox row records the effective mode so the drain re-chunks correctly.
        const row = yield* h.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(row?.captureMode, 'mic');

        // Observable exposes both so the renderer can show "mic only".
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording'
        );
        const st = yield* SubscriptionRef.get(h.service.state);
        assert.strictEqual(st.captureMode, 'mic', 'effective mode');
        assert.strictEqual(st.requestedCaptureMode, 'dual', 'requested mode retained for the UI');

        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('evaluates fresh meeting-app context before spawn and re-asserts it after spawn', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* SubscriptionRef.set(
        h.micActivityLatest,
        Option.some({
          receivedAtMs: 0,
          snapshot: {
            timestampMs: 0,
            apps: [
              {
                bundleId: 'us.zoom.xos',
                pid: 42,
                detectedAtMs: 0,
                inputDevices: [{ uid: 'mic-b', name: 'USB Mic' }],
              },
            ],
          },
        })
      );

      const recordingId = yield* h.service.start({ captureMode: 'dual', title: 'Aligned' });
      yield* poll(
        Effect.sync(
          () => h.fakeCapture.sessions.length === 1 && h.fakeCapture.current().commands.length === 1
        ),
        'initial device binding sent'
      );
      const session = h.fakeCapture.current();
      assert.strictEqual(session.options?.micDeviceUid, 'mic-b');
      assert.deepStrictEqual(session.commands, [{ cmd: 'set-mic', uid: 'mic-b', rev: 1 }]);
      const state = yield* SubscriptionRef.get(h.service.state);
      assert.strictEqual(state.recordingId, recordingId);
      assert.strictEqual(state.micSource, 'meeting-app');
      assert.deepStrictEqual(
        h.logger.find(entry => entry.scope === 'mic-alignment' && entry.message === 'session_start')
          ?.data,
        { recordingId, mode: 'meeting-app', app: 'Zoom' }
      );

      yield* h.service.stop(recordingId);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('switches the desired meeting mic in-place without resetting recording state', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'dual', title: 'Switch' });
      yield* poll(
        Effect.sync(
          () => h.fakeCapture.sessions.length === 1 && h.fakeCapture.current().commands.length === 1
        ),
        'default binding sent'
      );
      const session = h.fakeCapture.current();
      assert.deepStrictEqual(session.commands[0], { cmd: 'follow-default', rev: 1 });

      yield* SubscriptionRef.set(
        h.micActivityLatest,
        Option.some({
          receivedAtMs: 0,
          snapshot: {
            timestampMs: 0,
            apps: [
              {
                bundleId: 'us.zoom.xos',
                pid: 42,
                detectedAtMs: 0,
                inputDevices: [{ uid: 'mic-b', name: 'USB Mic' }],
              },
            ],
          },
        })
      );
      yield* poll(
        Effect.sync(() => session.commands.some(command => command.cmd === 'set-mic')),
        'meeting mic command sent'
      );
      assert.deepStrictEqual(session.commands.at(-1), {
        cmd: 'set-mic',
        uid: 'mic-b',
        rev: 2,
      });
      yield* Queue.offer(session.micEvents, {
        kind: 'bound',
        uid: 'mic-b',
        mode: 'fixed',
        rev: 2,
        reason: 'command',
        blackoutMs: 30,
        trimmedMs: 5,
      });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(
          Effect.map(state => state.micSource === 'meeting-app')
        ),
        'meeting-app state published'
      );
      yield* poll(
        Effect.sync(() =>
          h.logger.entries.some(
            entry => entry.scope === 'mic-alignment' && entry.message === 'transition'
          )
        ),
        'first transition logged'
      );
      assert.deepStrictEqual(
        h.logger.find(entry => entry.scope === 'mic-alignment' && entry.message === 'transition')
          ?.data,
        {
          recordingId,
          from: 'system-default',
          to: 'meeting-app',
          trigger: 'app-start',
          detect_ms: 0,
          blackout_ms: 30,
          trimmed_ms: 5,
          ok: true,
          uid: 'mic-b',
          app: 'Zoom',
        }
      );

      yield* SubscriptionRef.set(
        h.micActivityLatest,
        Option.some({
          receivedAtMs: 0,
          snapshot: {
            timestampMs: 1_000,
            apps: [
              {
                bundleId: 'us.zoom.xos',
                pid: 42,
                detectedAtMs: 1_000,
                inputDevices: [{ uid: 'mic-c', name: 'Headset' }],
              },
            ],
          },
        })
      );
      yield* poll(
        Effect.sync(() =>
          session.commands.some(command => command.cmd === 'set-mic' && command.uid === 'mic-c')
        ),
        'second meeting mic command sent'
      );
      assert.strictEqual(h.fakeCapture.sessions.length, 1, 'helper was not restarted');
      const micCCommand = session.commands.at(-1);
      assert.strictEqual(micCCommand?.cmd, 'set-mic');
      const micCRevision = micCCommand?.rev ?? 0;
      yield* Queue.offer(session.micEvents, {
        kind: 'bound',
        uid: 'mic-c',
        mode: 'fixed',
        rev: micCRevision,
        reason: 'command',
        blackoutMs: 25,
        trimmedMs: 4,
      });
      yield* poll(
        Effect.sync(
          () =>
            h.logger.entries.filter(
              entry => entry.scope === 'mic-alignment' && entry.message === 'transition'
            ).length === 2
        ),
        'second transition logged'
      );
      const secondTransition = h.logger.entries.filter(
        entry => entry.scope === 'mic-alignment' && entry.message === 'transition'
      )[1];
      assert.deepStrictEqual(secondTransition?.data, {
        recordingId,
        from: 'meeting-app',
        to: 'meeting-app',
        trigger: 'app-select',
        detect_ms: 0,
        blackout_ms: 25,
        trimmed_ms: 4,
        ok: true,
        uid: 'mic-c',
        app: 'Zoom',
      });
      const state = yield* SubscriptionRef.get(h.service.state);
      assert.strictEqual(state.recordingId, recordingId);
      assert.strictEqual(state.status, 'recording');
      assert.deepStrictEqual(state.segments, []);

      yield* h.service.stop(recordingId);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('keeps recording through microphone unavailable and recovery events', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'dual', title: 'Recovery' });
      yield* poll(
        Effect.sync(
          () => h.fakeCapture.sessions.length === 1 && h.fakeCapture.current().commands.length === 1
        ),
        'capture acquired and post-spawn binding asserted'
      );
      const session = h.fakeCapture.current();

      yield* Queue.offer(session.micEvents, {
        kind: 'bind-failed',
        uid: 'mic-a',
        osStatus: -10_863,
        reason: 'core-audio',
        operation: 'AudioUnitInitialize(microphone)',
        rev: 0,
      });
      yield* poll(
        Effect.sync(() =>
          h.logger.entries.some(
            entry => entry.scope === 'mic-alignment' && entry.message === 'activation_failure'
          )
        ),
        'activation failure logged'
      );
      assert.deepStrictEqual(
        h.logger.find(
          entry => entry.scope === 'mic-alignment' && entry.message === 'activation_failure'
        )?.data,
        {
          recordingId,
          uid: 'mic-a',
          os_status: -10_863,
          reason: 'core-audio',
          operation: 'AudioUnitInitialize(microphone)',
          fallback: 'default',
        }
      );

      // The helper can report its boot state at rev 0 before the supervisor's
      // mandatory post-spawn assertion advances the command revision to 1.
      yield* Queue.offer(session.micEvents, { kind: 'unavailable', rev: 0 });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(
          Effect.map(state => state.micSource === 'unavailable')
        ),
        'unavailable state'
      );
      const unavailable = yield* SubscriptionRef.get(h.service.state);
      assert.strictEqual(unavailable.status, 'recording');
      assert.strictEqual(unavailable.recordingId, recordingId);
      assert.strictEqual(h.fakeCapture.sessions.length, 1);

      yield* TestClock.adjust(Duration.seconds(2));
      yield* Queue.offer(session.micEvents, { kind: 'recovered', uid: 'mic-a', rev: 0 });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(
          Effect.map(state => state.micSource === 'system-default')
        ),
        'recovered state'
      );
      const recovered = yield* SubscriptionRef.get(h.service.state);
      assert.strictEqual(recovered.status, 'recording');
      assert.strictEqual(recovered.recordingId, recordingId);
      assert.deepStrictEqual(
        h.logger.find(entry => entry.scope === 'mic-alignment' && entry.message === 'recovered')
          ?.data,
        { recordingId, uid: 'mic-a', duration_ms: 2_000 }
      );

      yield* h.service.stop(recordingId);
      const stopped = yield* SubscriptionRef.get(h.service.state);
      assert.strictEqual(stopped.status, 'idle');
      assert.strictEqual(stopped.micSource, 'system-default');
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('re-asserts the current desired binding after a genuine helper restart', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* SubscriptionRef.set(
        h.micActivityLatest,
        Option.some({
          receivedAtMs: 0,
          snapshot: {
            timestampMs: 0,
            apps: [
              {
                bundleId: 'us.zoom.xos',
                pid: 42,
                detectedAtMs: 0,
                inputDevices: [{ uid: 'mic-b', name: 'USB Mic' }],
              },
            ],
          },
        })
      );
      const recordingId = yield* h.service.start({ captureMode: 'dual', title: 'Restart' });
      yield* poll(
        Effect.sync(
          () => h.fakeCapture.sessions.length === 1 && h.fakeCapture.current().commands.length === 1
        ),
        'first binding sent'
      );
      yield* Deferred.fail(
        h.fakeCapture.current().terminated,
        new CaptureExitError({ code: 1, signal: null })
      );
      yield* TestClock.adjust(Duration.seconds(1));
      yield* poll(
        Effect.sync(
          () => h.fakeCapture.sessions.length === 2 && h.fakeCapture.current().commands.length === 1
        ),
        'binding re-asserted after restart'
      );
      assert.deepStrictEqual(h.fakeCapture.current().commands[0], {
        cmd: 'set-mic',
        uid: 'mic-b',
        rev: 2,
      });

      yield* h.service.stop(recordingId);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('ignores delayed B/C acknowledgements during a rapid B → C → D switch', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'dual', title: 'Rapid switch' });
      yield* poll(
        Effect.sync(
          () => h.fakeCapture.sessions.length === 1 && h.fakeCapture.current().commands.length === 1
        ),
        'default binding sent'
      );
      const session = h.fakeCapture.current();

      for (const uid of ['mic-b', 'mic-c', 'mic-d']) {
        yield* SubscriptionRef.set(h.micActivityLatest, zoomMicActivity(uid, 0));
        yield* poll(
          Effect.sync(() => {
            const command = session.commands.at(-1);
            return command?.cmd === 'set-mic' && command.uid === uid;
          }),
          `${uid} command sent`
        );
      }

      assert.deepStrictEqual(session.commands, [
        { cmd: 'follow-default', rev: 1 },
        { cmd: 'set-mic', uid: 'mic-b', rev: 2 },
        { cmd: 'set-mic', uid: 'mic-c', rev: 3 },
        { cmd: 'set-mic', uid: 'mic-d', rev: 4 },
      ]);

      yield* Queue.offer(session.micEvents, {
        kind: 'bound',
        uid: 'mic-c',
        mode: 'fixed',
        rev: 3,
        reason: 'command',
      });
      yield* settle;
      assert.strictEqual(session.commands.length, 4, 'stale bound did not re-assert');

      yield* Queue.offer(session.micEvents, {
        kind: 'bound',
        uid: 'mic-d',
        mode: 'fixed',
        rev: 4,
        reason: 'command',
      });
      yield* settle;
      assert.strictEqual(session.commands.length, 4);

      yield* h.service.stop(recordingId);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('does not let stale B failures demote a later B generation', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recordingId = yield* h.service.start({ captureMode: 'dual', title: 'B again' });
      yield* poll(
        Effect.sync(
          () => h.fakeCapture.sessions.length === 1 && h.fakeCapture.current().commands.length === 1
        ),
        'default binding sent'
      );
      const session = h.fakeCapture.current();

      for (const uid of ['mic-b', 'mic-c', 'mic-b']) {
        yield* SubscriptionRef.set(h.micActivityLatest, zoomMicActivity(uid, 0));
        yield* poll(
          Effect.sync(() => {
            const command = session.commands.at(-1);
            return command?.cmd === 'set-mic' && command.uid === uid;
          }),
          `${uid} command sent`
        );
      }

      assert.deepStrictEqual(session.commands, [
        { cmd: 'follow-default', rev: 1 },
        { cmd: 'set-mic', uid: 'mic-b', rev: 2 },
        { cmd: 'set-mic', uid: 'mic-c', rev: 3 },
        { cmd: 'set-mic', uid: 'mic-b', rev: 4 },
      ]);

      yield* Queue.offer(session.micEvents, {
        kind: 'bind-failed',
        uid: 'mic-b',
        rev: 2,
      });
      yield* Queue.offer(session.micEvents, {
        kind: 'lost',
        uid: 'mic-b',
        rev: 2,
      });
      yield* settle;

      assert.strictEqual(session.commands.length, 4, 'stale failures did not change desired mic');

      yield* h.service.stop(recordingId);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('adopts autonomous fallback and does not retry the dead uid each detector poll', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* SubscriptionRef.set(h.micActivityLatest, zoomMicActivity('mic-b', 0));
      const recordingId = yield* h.service.start({ captureMode: 'dual', title: 'Fallback' });
      yield* poll(
        Effect.sync(
          () => h.fakeCapture.sessions.length === 1 && h.fakeCapture.current().commands.length === 1
        ),
        'meeting mic sent'
      );
      const session = h.fakeCapture.current();
      assert.deepStrictEqual(session.commands[0], {
        cmd: 'set-mic',
        uid: 'mic-b',
        rev: 1,
      });

      yield* Queue.offer(session.micEvents, {
        kind: 'bound',
        uid: 'mic-a',
        mode: 'follow-default',
        rev: 1,
        reason: 'autonomous-fallback',
      });
      yield* poll(
        Effect.sync(() => session.commands.length === 2),
        'fallback desired state adopted'
      );
      assert.deepStrictEqual(session.commands[1], { cmd: 'follow-default', rev: 2 });

      for (let pollIndex = 1; pollIndex <= 3; pollIndex += 1) {
        yield* SubscriptionRef.set(h.micActivityLatest, zoomMicActivity('mic-b', pollIndex));
        yield* settle;
      }
      assert.strictEqual(session.commands.length, 2, 'cooldown blocked the 1 Hz retry loop');

      yield* TestClock.adjust(Duration.seconds(10));
      yield* SubscriptionRef.set(h.micActivityLatest, zoomMicActivity('mic-b', 10_000));
      yield* poll(
        Effect.sync(() => session.commands.length === 3),
        'device retried after cooldown'
      );
      assert.deepStrictEqual(session.commands[2], {
        cmd: 'set-mic',
        uid: 'mic-b',
        rev: 3,
      });

      yield* h.service.stop(recordingId);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );
});

// ---------------------------------------------------------------------------
// Transcriber seam, engine resolution, and the frozen
// transcriptionConfig, the finalize/cleanup contract per engine, the cloud-mode
// segment mirror and the channel-derived speaker count.
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

const LOCAL_CONFIG = (modelId: string) => ({
  provider: 'local-whisper',
  model: `local:${modelId}`,
  language: 'en',
});

describe('RecordingService — transcription engine', () => {
  it.effect(
    'serializes Start while loading defaults and starts the recording clock afterwards',
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let requests = 0;
        const h = yield* setup({}, undefined, {
          backendTransform: api => ({
            ...api,
            request: req =>
              req.path === '/apps/v1/me/model-defaults'
                ? Effect.gen(function* () {
                    requests += 1;
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                    return {
                      ok: true,
                      status: 200,
                      bodyJson: { formatting: null, transcription: null },
                    } as const;
                  })
                : api.request(req),
          }),
        });
        const first = yield* Effect.fork(h.service.start({ captureMode: 'mic' }));
        yield* Deferred.await(entered);
        const second = yield* Effect.fork(Effect.exit(h.service.start({ captureMode: 'mic' })));
        yield* TestClock.adjust(Duration.seconds(10));
        assert.strictEqual(requests, 1, 'a second Start cannot race the defaults request');
        assert.strictEqual(h.fakeCapture.sessions.length, 0);
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Deferred.succeed(release, undefined);
        const recordingId = yield* Fiber.join(first);
        const refused = yield* Fiber.join(second);
        assert.isTrue(Exit.isFailure(refused));
        if (Exit.isFailure(refused)) {
          assert.strictEqual(
            Cause.failureOption(refused.cause).pipe(Option.getOrThrow)._tag,
            'RecordingBusyError'
          );
        }
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).startedAt, startedAt);
        yield* h.service.stop(recordingId);
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect(
    'replays quota usage and baseline fixed at Start despite later device settings changes',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const recordingId = yield* h.service.start({
          captureMode: 'mic',
          quotaRemainingAtStartSeconds: 900,
        });
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).spendsCloudQuota, true);
        assert.strictEqual(
          (yield* SubscriptionRef.get(h.service.state)).quotaRemainingAtStartSeconds,
          900
        );
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording'
        );
        yield* SubscriptionRef.update(yield* h.settings.ref, settings => ({
          ...settings,
          transcription: { ...settings.transcription, engine: 'byok' as const },
        }));
        yield* h.service.pause(recordingId);
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).spendsCloudQuota, true);
        const replay = Option.getOrThrow(yield* Stream.runHead(h.service.state.changes));
        assert.strictEqual(replay.status, 'paused');
        assert.strictEqual(
          replay.quotaRemainingAtStartSeconds,
          900,
          'late subscribers get the original baseline'
        );
        const row = yield* h.db.getRecoveryOutbox(recordingId);
        assert.notProperty(row?.createInput, 'quotaRemainingAtStartSeconds');
        assert.notProperty(h.fakeCloud.createCalls[0], 'quotaRemainingAtStartSeconds');
        yield* h.service.resume(recordingId);
        yield* h.service.stop(recordingId);
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).spendsCloudQuota, true);
        assert.strictEqual(
          (yield* SubscriptionRef.get(h.service.state)).quotaRemainingAtStartSeconds,
          900
        );
        const nextId = yield* h.service.start({ captureMode: 'mic' });
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).spendsCloudQuota, false);
        assert.isNull((yield* SubscriptionRef.get(h.service.state)).quotaRemainingAtStartSeconds);
        yield* h.service.stop(nextId);
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect(
    'cloud engine (the default): managed config frozen, server finalization, no mirror, no speaker meta',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const recordingId = yield* h.service.start({ captureMode: 'mic', title: 'Cloud' });
        yield* poll(
          Effect.sync(() => h.fakeCloud.createCalls.length === 1),
          'createRecording'
        );
        assert.deepStrictEqual(
          h.fakeCloud.createCalls[0].transcriptionConfig,
          MANAGED_TRANSCRIPTION_CONFIG
        );
        assert.deepStrictEqual(
          h.logger.find(e => e.message === 'recording engine resolved')?.data,
          { recordingId, engine: 'cloud' }
        );
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording'
        );
        yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
        yield* settle;
        yield* h.service.stop(recordingId);

        // The upload went through the cloud lane (the seam did not swallow it).
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);

        yield* h.drain;
        assert.isNull(yield* h.db.getRecoveryOutbox(recordingId));

        assert.isFalse(
          h.fakeCloud.requestCalls.some(call => call.path === TRANSCRIPT_SEGMENTS_PATH),
          'the cloud engine never mirrors'
        );
        const row = (yield* productRecording(h, recordingId))!;
        assert.deepStrictEqual(row.transcriptionConfig, MANAGED_TRANSCRIPTION_CONFIG);
        assert.isNull(row.meta, 'the cloud engine writes no channel speaker count');
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect(
    'cloud mode and placeholder local engine: chunks acknowledge empty through the seam, warn once, and complete without staging',
    () =>
      Effect.gen(function* () {
        const h = yield* setup({}, undefined, { transcription: { engine: 'local' } });
        const recordingId = yield* h.service.start({ captureMode: 'mic', title: 'Local' });
        yield* poll(
          Effect.sync(() => h.fakeCloud.createCalls.length === 1),
          'createRecording'
        );
        // The frozen config names the recommended model (no modelId preference) — never an instanceId.
        assert.deepStrictEqual(
          h.fakeCloud.createCalls[0].transcriptionConfig,
          LOCAL_CONFIG(RECOMMENDED_MODEL_ID)
        );
        assert.deepStrictEqual(
          h.logger.find(e => e.message === 'recording engine resolved')?.data,
          { recordingId, engine: 'local', modelId: RECOMMENDED_MODEL_ID }
        );
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording'
        );
        yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', seconds(30)));
        yield* settle;
        yield* TestClock.adjust(CHUNK_INTERVAL);
        yield* poll(
          h.db.getRecoveryOutbox(recordingId).pipe(Effect.map(r => r?.lastChunkIndex === 1)),
          'both chunks acked (cursor advanced to 1)'
        );
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0, 'the cloud lane was never reached');
        const warns = () =>
          h.logger.entries.filter(
            e => e.message === 'transcription engine not available in this build — chunks ack empty'
          );
        assert.strictEqual(warns().length, 1, 'ONE warn per recording, not per chunk');
        assert.deepStrictEqual(warns()[0].data, { recordingId, engine: 'local' });

        yield* h.service.stop(recordingId);
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);

        yield* h.drain;
        yield* poll(
          h.db.getRecoveryOutbox(recordingId).pipe(Effect.map(r => r === null)),
          'outbox row deleted'
        );

        assert.isFalse(fs.existsSync(h.recoveryDir(recordingId)), 'WAVs deleted (never staged)');
        assert.strictEqual(h.fakeCloud.requestCalls.length, 0, 'nothing to mirror (no segments)');
        const row = (yield* productRecording(h, recordingId))!;
        assert.strictEqual(row.status, 'completed');
        assert.deepStrictEqual(row.transcriptionConfig, LOCAL_CONFIG(RECOMMENDED_MODEL_ID));
        assert.deepStrictEqual(row.meta, { detectedSpeakerCount: 1 });
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect(
    'cloud mode with a minting local lane: segments persist, mirror to the server before finalize, speaker count 2',
    () =>
      Effect.gen(function* () {
        const h = yield* setup({}, undefined, {
          transcription: { engine: 'local', modelId: 'whisper-tiny' },
          localLane: mintingLocalLane(p => (p.source === 'system' ? 'them talking' : 'me talking')),
        });
        const recordingId = yield* h.service.start({ captureMode: 'dual', title: 'Mirror' });
        yield* poll(
          Effect.sync(() => h.fakeCloud.createCalls.length === 1),
          'createRecording'
        );
        assert.deepStrictEqual(
          h.fakeCloud.createCalls[0].transcriptionConfig,
          LOCAL_CONFIG('whisper-tiny')
        );
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording'
        );
        const session = h.fakeCapture.current();
        yield* Queue.offer(session.frames, fakeFrame('mic_processed', seconds(16)));
        yield* Queue.offer(session.frames, fakeFrame('system', seconds(16)));
        // A dequeued frame can still be awaiting its WAV write and upload.
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.segments.length === 2)),
          'two live segments minted on-device'
        );
        yield* h.service.stop(recordingId);

        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0, 'never the cloud lane');
        const persisted = yield* productSegments(h, recordingId);
        assert.deepStrictEqual(
          persisted.map(r => [r.segmentOrder, r.source, r.speaker, r.text]),
          [
            [1_000_000, 'mic', 'you', 'me talking'],
            [1_001_000, 'system', 'them', 'them talking'],
            [1_002_000, 'mic', 'you', 'me talking'],
            [1_003_000, 'system', 'them', 'them talking'],
          ]
        );
        // One mirror POST per segment, sync-create dialect, the store's ids + orders, all before finalize.
        assert.strictEqual(h.fakeCloud.requestCalls.length, 4);
        for (const [i, call] of h.fakeCloud.requestCalls.entries()) {
          assert.strictEqual(call.method, 'POST');
          assert.strictEqual(call.path, TRANSCRIPT_SEGMENTS_PATH);
          const parsed = SyncTranscriptSegmentCreateRequestSchema.safeParse(call.body);
          assert.isTrue(parsed.success, JSON.stringify(parsed.error?.issues));
          assert.deepStrictEqual(parsed.data, call.body, 'no field outside the contract');
          assert.strictEqual(parsed.data!.id, persisted[i].id);
          assert.strictEqual(parsed.data!.segmentOrder, persisted[i].segmentOrder);
          assert.strictEqual(parsed.data!.recordingId, recordingId);
          assert.strictEqual(parsed.data!.isFinal, true);
        }
        const finalizeAt = h.fakeCloud.timeline.indexOf('finalize');
        const mirrors = h.fakeCloud.timeline
          .map((entry, i) => [entry, i] as const)
          .filter(([entry]) => entry.startsWith('request:'));
        assert.strictEqual(mirrors.length, 4);
        assert.isTrue(
          mirrors.every(([, i]) => i < finalizeAt),
          'every mirror lands BEFORE the finalize PUT'
        );

        const row = (yield* productRecording(h, recordingId))!;
        assert.deepStrictEqual(row.meta, { detectedSpeakerCount: 2 }, 'dual + system speech → 2');
        yield* h.drain;
        yield* poll(
          h.db.getRecoveryOutbox(recordingId).pipe(Effect.map(r => r === null)),
          'resolved'
        );
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect(
    'local mode: the stored cloud default coerces to the local engine and NOTHING is mirrored',
    () =>
      Effect.gen(function* () {
        const h = yield* setup({}, undefined, {
          mode: 'local',
          localLane: mintingLocalLane(() => 'local words'),
        });
        const recordingId = yield* h.service.start({ captureMode: 'mic', title: 'Local mode' });
        yield* poll(
          Effect.sync(() => h.fakeCloud.createCalls.length === 1),
          'createRecording'
        );
        assert.deepStrictEqual(
          h.fakeCloud.createCalls[0].transcriptionConfig,
          LOCAL_CONFIG(RECOMMENDED_MODEL_ID)
        );
        assert.strictEqual(
          (
            h.logger.find(e => e.message === 'recording engine resolved')?.data as {
              engine: string;
            }
          ).engine,
          'local'
        );
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording'
        );
        yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', seconds(15)));
        yield* settle;
        yield* TestClock.adjust(CHUNK_INTERVAL);
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.segments.length === 1)),
          'segment minted'
        );
        yield* h.service.stop(recordingId);

        assert.strictEqual(h.fakeCloud.requestCalls.length, 0, 'local mode never mirrors');
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);

        assert.strictEqual((yield* productSegments(h, recordingId)).length, 1);
        const row = (yield* productRecording(h, recordingId))!;
        assert.deepStrictEqual(row.transcriptionConfig, LOCAL_CONFIG(RECOMMENDED_MODEL_ID));
        assert.deepStrictEqual(row.meta, { detectedSpeakerCount: 1 });
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect(
    'an engine failure classifies like an upload failure: retryable freezes the cursor, non-retryable loses the chunk',
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const flakyLane = Layer.succeed(LocalTranscriberLane, {
          transcribeChunk: () =>
            Effect.sync((): RecordingLaneResult<readonly RecordingSegment[]> => {
              calls += 1;
              if (calls === 1) return laneFail(true, { kind: 'engine', reason: 'worker-crashed' });
              if (calls === 2)
                return laneFail(false, { kind: 'engine', reason: 'inference-failed' });
              return { ok: true, value: [] };
            }),
        } satisfies TranscriberLaneApi);
        const h = yield* setup({}, undefined, {
          transcription: { engine: 'local' },
          localLane: flakyLane,
        });
        const recordingId = yield* h.service.start({ captureMode: 'mic' });
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording'
        );
        const session = h.fakeCapture.current();
        yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(15)));
        yield* settle;
        yield* TestClock.adjust(CHUNK_INTERVAL);
        yield* poll(
          Effect.sync(() => calls === 1),
          'first chunk attempted'
        );
        yield* Queue.offer(session.frames, fakeFrame('mic_raw', seconds(15)));
        yield* settle;
        yield* TestClock.adjust(CHUNK_INTERVAL);
        yield* poll(
          Effect.sync(() => calls === 2),
          'second chunk attempted'
        );

        const row = yield* h.db.getRecoveryOutbox(recordingId);
        assert.isNull(row?.lastChunkIndex, 'cursor frozen behind the retryable engine failure');
        assert.deepStrictEqual(
          h.logger.find(
            e =>
              e.message === 'chunk processing failed — retained for recovery' &&
              (e.data as { index?: number })?.index === 0
          )?.data,
          { recordingId, index: 0, failure: { kind: 'engine', reason: 'worker-crashed' } }
        );
        assert.deepStrictEqual(
          h.logger.find(
            e =>
              e.message === 'chunk processing failed — retained for recovery' &&
              (e.data as { index?: number })?.index === 1
          )?.data,
          { recordingId, index: 1, failure: { kind: 'engine', reason: 'inference-failed' } }
        );

        // Stop with an unacked chunk → parked for the drain, WAV retained (today's contract).
        yield* h.service.stop(recordingId);
        const parked = yield* h.db.getRecoveryOutbox(recordingId);
        assert.strictEqual(parked?.status, 'finalizing');
        assert.strictEqual(parked?.lastError, 'stop-incomplete');
        assert.isTrue(fs.existsSync(path.join(h.recoveryDir(recordingId), 'mic.wav')));
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('a failing mirror retains its chunk until required server delivery succeeds', () =>
    Effect.gen(function* () {
      const h = yield* setup({}, undefined, {
        transcription: { engine: 'local' },
        localLane: mintingLocalLane(() => 'kept locally'),
      });
      h.fakeCloud.setRequestResponder(() => ({ ok: true, status: 500, bodyJson: null }));
      const recordingId = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', seconds(15)));
      yield* settle;
      yield* TestClock.adjust(CHUNK_INTERVAL);
      yield* poll(
        Effect.sync(() => h.fakeCloud.requestCalls.length === 1),
        'mirror attempted'
      );
      assert.strictEqual(h.fakeCloud.requestCalls.length, 1);
      assert.isNull((yield* h.db.getRecoveryOutbox(recordingId))?.lastChunkIndex);
      assert.deepStrictEqual(
        h.logger.find(e => e.message === 'segment mirror to core failed — retained for recovery')
          ?.data,
        { recordingId, segmentOrder: 1_000_000, status: 500 }
      );
      assert.strictEqual((yield* productSegments(h, recordingId)).length, 1);
      yield* h.service.stop(recordingId);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );
});

describe('RecordingService — lifecycle ownership and durability', () => {
  afterEach(() => vi.restoreAllMocks());

  it.effect(
    'checks durable pending suggestions before native capture, independently of the renderer',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.fakeCloud.setRequestResponder(req => ({
          ok: true,
          status: 200,
          bodyJson: {
            results:
              req.query?.noteId === 'note_pending'
                ? [
                    {
                      resultId: 'result_one',
                      recordingId: 'recording_old',
                      mode: 'replace-doc',
                      skillId: 'skill_enhance',
                      skillName: 'Enhance',
                      modelId: 'model_one',
                      rawMarkdown: 'Saved suggestion',
                      reasoning: null,
                    },
                  ]
                : [],
          },
        }));
        const rejected = yield* Effect.either(
          h.service.start({ captureMode: 'mic', noteId: 'note_pending' })
        );
        assert.deepStrictEqual(
          rejected,
          Either.left(new RecordingStartError({ reason: 'suggestion-pending' }))
        );
        assert.strictEqual(h.fakeCapture.sessions.length, 0);
        assert.strictEqual(h.fakeCloud.createCalls.length, 0);
        assert.deepStrictEqual(yield* h.db.listRecoveryOutbox(), []);
        const other = yield* h.service.start({ captureMode: 'mic', noteId: 'note_other' });
        yield* h.service.stop(other);
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('serializes simultaneous starts while the pending suggestion check is in flight', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* setup({}, undefined, {
        backendTransform: api => ({
          ...api,
          request: req =>
            req.path === '/apps/v1/me/skill-runs/pending'
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.zipRight(Deferred.await(release)),
                  Effect.as({ ok: true as const, status: 200, bodyJson: { results: [] } })
                )
              : api.request(req),
        }),
      });
      const first = yield* Effect.fork(
        h.service.start({ captureMode: 'mic', noteId: 'note_first' })
      );
      yield* Deferred.await(entered);
      const second = yield* Effect.fork(
        Effect.either(h.service.start({ captureMode: 'mic', noteId: 'note_second' }))
      );
      yield* settle;
      assert.strictEqual(h.fakeCapture.sessions.length, 0);
      assert.isTrue(Option.isNone(yield* Fiber.poll(second)));
      yield* Deferred.succeed(release, undefined);
      const id = yield* Fiber.join(first);
      assert.deepStrictEqual(
        yield* Fiber.join(second),
        Either.left(new RecordingBusyError({ activeRecordingId: id }))
      );
      yield* h.service.stop(id);
      assert.strictEqual(h.fakeCloud.createCalls.length, 1);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect(
    'blocks another recording until stopped audio finishes processing and claims completion once',
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const h = yield* setup({}, undefined, {
          backendTransform: api => ({
            ...api,
            uploadTranscriptionChunk: (id, params, wav) =>
              (id === first
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.zipRight(Deferred.await(release))
                  )
                : Effect.void
              ).pipe(Effect.zipRight(api.uploadTranscriptionChunk(id, params, wav))),
          }),
        });
        h.fakeCloud.setUploadResponder(call => ({
          ok: true,
          value: [
            {
              ...fakeSegment(call.recordingId, 'mic', call.params.chunkIndex, call.recordingId),
              id: `tsg_${call.recordingId}_${call.params.chunkIndex}`,
            },
          ],
        }));
        const first: string = yield* h.service.start({
          captureMode: 'mic',
          noteId: 'note_first',
          autoPause: { silenceSeconds: 1, graceSeconds: 60, autoStopAfterPausedMinutes: 1 },
        });
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'first capture'
        );
        const firstCapture = h.fakeCapture.current();
        yield* Queue.offer(
          firstCapture.frames,
          fakeFrame('mic_raw', new Float32Array(30 * 48_000))
        );
        yield* Deferred.await(entered);
        assert.isNotNull((yield* SubscriptionRef.get(h.service.state)).autoPausePrompt);
        const stopping = yield* Effect.fork(h.service.stop(first));
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(
            Effect.map(s => s.status === 'idle' && s.finalizingRecordingIds.includes(first))
          ),
          'first capture released while processing'
        );
        assert.isTrue(firstCapture.released);
        assert.isTrue(Option.isNone(yield* Fiber.poll(stopping)));

        assert.deepStrictEqual(
          yield* Effect.either(h.service.start({ captureMode: 'mic', noteId: 'note_second' })),
          Either.left(new RecordingBusyError({ activeRecordingId: first }))
        );
        assert.strictEqual(h.fakeCapture.sessions.length, 1);
        yield* TestClock.adjust(Duration.minutes(2));
        assert.deepStrictEqual((yield* h.db.getRecoveryOutbox(first))?.pauseCutPoints, []);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        const state = yield* SubscriptionRef.get(h.service.state);
        assert.deepStrictEqual(state.finalizingRecordingIds, []);
        assert.deepStrictEqual(state.completedRecordings, [
          { recordingId: first, noteId: 'note_first', segments: 2 },
        ]);
        const claims = yield* Effect.all(
          [h.service.claimCompletion(first), h.service.claimCompletion(first)],
          { concurrency: 'unbounded' }
        );
        assert.strictEqual(claims.filter(Boolean).length, 1);
        assert.deepStrictEqual(
          (yield* SubscriptionRef.get(h.service.state)).completedRecordings,
          []
        );
        assert.strictEqual((yield* productSegments(h, first)).length, 2);
        const second = yield* h.service.start({ captureMode: 'mic', noteId: 'note_second' });
        yield* h.service.stop(second);
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect(
    'blocks capture until recovery completes and preserves completion claims',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.fakeCloud.setCreateResponder(() => laneFail(true, { kind: 'http', status: 503 }));
        const first = yield* h.service.start({ captureMode: 'mic' });
        yield* h.service.stop(first);
        const claims = yield* Effect.all([
          Effect.fork(h.service.claimCompletion(first)),
          Effect.fork(h.service.claimCompletion(first)),
        ]);
        yield* settle;
        for (const claim of claims) assert.isTrue(Option.isNone(yield* Fiber.poll(claim)));
        assert.deepStrictEqual((yield* SubscriptionRef.get(h.service.state)).finalizingRecordingIds, [first]);
        assert.deepStrictEqual(
          yield* Effect.either(h.service.start({ captureMode: 'mic' })),
          Either.left(new RecordingBusyError({ activeRecordingId: first }))
        );
        h.fakeCloud.setCreateResponder(input => ({
          ok: true,
          value: { recordingId: input.recordingId },
        }));
        yield* h.drain;
        const results = yield* Effect.forEach(claims, Fiber.join);
        assert.deepStrictEqual((yield* SubscriptionRef.get(h.service.state)).finalizingRecordingIds, []);
        assert.strictEqual(results.filter(Boolean).length, 1);
        const second = yield* h.service.start({ captureMode: 'mic' });
        yield* h.service.stop(second);
        assert.isTrue(yield* h.service.claimCompletion(second));
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 2);
        assert.isFalse(yield* h.service.claimCompletion(first));
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('completion waits for unresolved chunks to be transcribed and finalized', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.fakeCloud.setUploadResponder(() => laneFail(true, { kind: 'http', status: 503 }));
      const id = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;
      yield* h.service.stop(id);
      const claim = yield* Effect.fork(h.service.claimCompletion(id));
      yield* settle;
      assert.isTrue(Option.isNone(yield* Fiber.poll(claim)));
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      h.fakeCloud.setUploadResponder(() => ({ ok: true, value: [] }));
      yield* h.drain;
      assert.isTrue(yield* Fiber.join(claim));
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('workspace release refuses pending completion claims', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.fakeCloud.setCreateResponder(() => laneFail(true, { kind: 'http', status: 503 }));
      const id = yield* h.service.start({ captureMode: 'mic' });
      yield* h.service.stop(id);
      const claim = yield* Effect.fork(h.service.claimCompletion(id));
      yield* settle;
      assert.isTrue(Option.isNone(yield* Fiber.poll(claim)));
      yield* Scope.close(h.sessionScope, Exit.void);
      assert.isFalse(yield* Fiber.join(claim));
      assert.isFalse(yield* h.service.claimCompletion(id));
    })
  );

  it.effect(
    'a deterministic recovery rejection refuses completion instead of enhancing partial text',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.fakeCloud.setCreateResponder(() => laneFail(false, { kind: 'http', status: 404 }));
        const id = yield* h.service.start({ captureMode: 'mic' });
        yield* h.service.stop(id);
        const claim = yield* Effect.fork(h.service.claimCompletion(id));
        yield* settle;
        assert.isTrue(Option.isNone(yield* Fiber.poll(claim)));
        yield* h.drain;
        assert.isFalse(yield* Fiber.join(claim));
        assert.strictEqual((yield* h.db.getRecoveryOutbox(id))?.status, 'failed');
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('recovery directory failure stops before capture and retains the job', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      fs.writeFileSync(path.dirname(h.recoveryDir('fixture')), 'not a directory');
      const id = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'error')),
        'storage failure published'
      );
      yield* h.service.stop(id);
      assert.deepStrictEqual((yield* SubscriptionRef.get(h.service.state)).finalizingRecordingIds, [id]);
      assert.strictEqual(h.fakeCapture.sessions.length, 0);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).elapsedMs, 0);
      assert.strictEqual((yield* h.db.getRecoveryOutbox(id))?.status, 'interrupted');
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('WAV append failure stops without a restart and completes only saved samples', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const id = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;
      vi.spyOn(StreamingWavWriter.prototype, 'appendAudio').mockRejectedValueOnce(
        new Error('ENOSPC')
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'error')),
        'write failure stopped capture'
      );
      yield* h.service.stop(id);
      assert.strictEqual(h.fakeCapture.sessions.length, 1, 'disk errors do not restart capture');
      assert.isTrue(h.fakeCapture.current().released);
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).elapsedMs, 1000);
      assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
      assertWav(h.fakeCloud.uploadCalls[0].wav, 16_000);
      assert.strictEqual(h.fakeCloud.finalizeCalls[0].input.durationMs, 1000);
      assert.strictEqual((yield* h.db.getRecoveryOutbox(id))?.durationMs, 1000);
      assertWav(fs.readFileSync(path.join(h.recoveryDir(id), 'mic.wav')), 48_000);
      assert.isTrue(yield* h.service.claimCompletion(id));
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('WAV close failure retains audio and does not advance to backend finalization', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const id = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;
      const original = StreamingWavWriter.prototype.finalize;
      vi.spyOn(StreamingWavWriter.prototype, 'finalize').mockImplementationOnce(async function (
        this: StreamingWavWriter
      ) {
        await original.call(this);
        throw new Error('header update failed');
      });
      yield* h.service.stop(id);
      assert.include(h.logger.find(e => e.message === 'Recording processing attempt ended')?.data, {
        recordingId: id,
        outcome: 'failure',
        failedStage: 'storage',
      });
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'error');
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      assert.strictEqual(h.fakeCapture.sessions.length, 1);
      assert.isTrue(h.fakeCapture.current().released);
      const row = yield* h.db.getRecoveryOutbox(id);
      assert.strictEqual(row?.status, 'interrupted');
      assert.strictEqual(row?.phase, 'chunks');
      assertWav(fs.readFileSync(path.join(h.recoveryDir(id), 'mic.wav')), 48_000);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('Stop drains an in-flight upload without moving the capture end time', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let cancelled = false;
      const h = yield* setup({}, undefined, {
        backendTransform: api => ({
          ...api,
          uploadTranscriptionChunk: (id, params, wav) =>
            (params.chunkIndex === 0
              ? Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Deferred.await(release)))
              : Effect.void
            ).pipe(
              Effect.zipRight(api.uploadTranscriptionChunk(id, params, wav)),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  cancelled = true;
                })
              )
            ),
        }),
      });
      const id = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', seconds(16)));
      yield* settle;
      yield* TestClock.adjust(CHUNK_INTERVAL);
      yield* Deferred.await(entered);
      const stoppingAt = yield* Clock.currentTimeMillis;
      const stopFiber = yield* Effect.forkDaemon(h.service.stop(id));
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(
          Effect.map(s => s.status === 'idle' && s.finalizingRecordingIds.length > 0)
        ),
        'stopping'
      );
      assert.isTrue(Option.isNone(yield* Fiber.poll(stopFiber)));
      assert.isTrue(h.fakeCapture.current().released, 'capture already closed while upload drains');
      yield* TestClock.adjust(Duration.seconds(15));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopFiber);
      assert.isFalse(cancelled);
      assert.deepStrictEqual(
        h.fakeCloud.uploadCalls.map(c => c.params.chunkIndex),
        [0, 1]
      );
      assert.strictEqual(h.fakeCloud.finalizeCalls[0].input.endedAt, stoppingAt);
      assert.strictEqual(h.fakeCloud.finalizeCalls[0].input.durationMs, 16_000);
      assert.strictEqual((yield* h.db.getRecoveryOutbox(id))?.phase, 'cleanup');
      yield* h.drain;
      assert.isNull(yield* h.db.getRecoveryOutbox(id));
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect(
    'failed creation preserves the chosen Cloud BYOK default through recovery and later changes',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.fakeCloud.setRequestResponder(() => ({
          ok: true,
          status: 200,
          bodyJson: {
            formatting: null,
            transcription: { instanceId: 'inst_original', modelId: 'nova-3' },
          },
        }));
        h.fakeCloud.setCreateResponder(() => laneFail(true, { kind: 'http', status: 503 }));
        const id = yield* h.service.start({
          captureMode: 'mic',
          noteId: 'nt_owner',
          title: 'Original title',
        });
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording'
        );
        yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
        yield* settle;
        yield* h.service.stop(id);
        const intent = h.fakeCloud.createCalls[0];
        assert.deepStrictEqual(intent.transcriptionConfig, {
          provider: 'byok',
          model: 'nova-3',
          language: 'en',
          instanceId: 'inst_original',
          modelId: 'nova-3',
        });
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).spendsCloudQuota, false);
        assert.deepStrictEqual((yield* h.db.getRecoveryOutbox(id))?.createInput, intent);
        assert.strictEqual((yield* h.db.getRecoveryOutbox(id))?.phase, 'create');
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 0);
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
        assert.isTrue(fs.existsSync(h.recoveryDir(id)));
        h.fakeCloud.setCreateResponder(input => ({
          ok: true,
          value: { recordingId: input.recordingId },
        }));
        h.fakeCloud.setRequestResponder(() => ({
          ok: true,
          status: 200,
          bodyJson: { formatting: null, transcription: null },
        }));
        yield* h.drain;
        assert.deepStrictEqual(h.fakeCloud.createCalls[1], intent);
        assert.strictEqual(
          h.fakeCloud.requestCalls.filter(call => call.path === '/apps/v1/me/model-defaults')
            .length,
          1,
          'recovery does not resolve a different default'
        );
        assert.strictEqual(h.fakeCloud.uploadCalls.length, 1);
        assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
        assert.isNull(yield* h.db.getRecoveryOutbox(id));
        const next = yield* h.service.start({ captureMode: 'mic' });
        assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).spendsCloudQuota, true);
        assert.strictEqual(
          h.fakeCloud.requestCalls.filter(call => call.path === '/apps/v1/me/model-defaults')
            .length,
          2,
          'a new recording resolves the new default'
        );
        yield* h.service.stop(next);
        yield* Scope.close(h.sessionScope, Exit.void);
      })
  );

  it.effect('silence grace can pause and Stop can finish without reacquiring the frame gate', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const id = yield* h.service.start({
        captureMode: 'mic',
        autoPause: {
          silenceSeconds: 1,
          graceSeconds: 1,
          autoStopAfterPausedMinutes: 1,
        },
      });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* Queue.offer(
        h.fakeCapture.current().frames,
        fakeFrame('mic_raw', new Float32Array(30 * 48_000))
      );
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.autoPausePrompt !== null)),
        'grace prompt'
      );
      yield* settle;
      yield* Queue.offer(
        h.fakeCapture.current().frames,
        fakeFrame('mic_raw', new Float32Array(48_000))
      );
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'paused')),
        'auto-pause completed'
      );
      yield* h.service.stop(id);
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'idle');
      assert.isTrue(h.fakeCapture.current().released);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('a manually paused recording auto-stops without a mounted renderer', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const id = yield* h.service.start({
        captureMode: 'mic',
        autoPause: {
          silenceSeconds: 1,
          graceSeconds: 1,
          autoStopAfterPausedMinutes: 1,
        },
      });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;
      assert.isTrue(yield* h.service.pause(id));
      yield* TestClock.adjust(Duration.minutes(1));
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'idle')),
        'automatic stop completed'
      );
      assert.isFalse(yield* h.service.resume(id));
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 1);
      assert.isTrue(yield* h.service.claimCompletion(id));
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('missing local model refuses Start before capture or durable job creation', () =>
    Effect.gen(function* () {
      const h = yield* setup({}, undefined, { mode: 'local', installedModels: {} });
      const result = yield* Effect.exit(h.service.start({ captureMode: 'mic' }));
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        const error = Cause.failureOption(result.cause);
        assert.isTrue(Option.isSome(error));
        if (Option.isSome(error))
          assert.deepInclude(error.value, { _tag: 'RecordingStartError', reason: 'model-missing' });
      }
      assert.strictEqual(h.fakeCapture.sessions.length, 0);
      assert.strictEqual(h.fakeCloud.createCalls.length, 0);
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'idle');
      assert.deepStrictEqual(yield* h.db.listRecoveryOutbox(), []);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('failed local transcript persistence keeps its cursor and audio for recovery', () =>
    Effect.gen(function* () {
      const h = yield* setup({}, undefined, {
        mode: 'local',
        localLane: mintingLocalLane(() => 'Keep these words'),
      });
      yield* Effect.sync(() =>
        h.product.client.exec(
          "CREATE TRIGGER fail_segments BEFORE INSERT ON transcript_segment BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END"
        )
      );
      const id = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;
      yield* h.service.stop(id);
      assert.include(h.logger.find(e => e.message === 'Recording processing attempt ended')?.data, {
        recordingId: id,
        outcome: 'failure',
        failedStage: 'storage',
      });
      const row = yield* h.db.getRecoveryOutbox(id);
      assert.isNull(row?.lastChunkIndex);
      assert.strictEqual(row?.phase, 'chunks');
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      assert.isTrue(fs.existsSync(h.recoveryDir(id)));
      assert.deepStrictEqual(yield* productSegments(h, id), []);
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  for (const [operation, trigger] of [
    ['metadata', 'BEFORE UPDATE OF meta ON recording'],
    ['completion', "BEFORE UPDATE OF status ON recording WHEN NEW.status = 'completed'"],
  ]) {
    it.effect(`failed ${operation} persistence reports storage and retains recovery work`, () =>
      Effect.gen(function* () {
        const h = yield* setup({}, undefined, {
          mode: 'local',
          localLane: mintingLocalLane(() => 'local words'),
        });
        const id = yield* h.service.start({ captureMode: 'mic' });
        yield* poll(
          SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
          'recording'
        );
        yield* Effect.sync(() =>
          h.product.client.exec(
            `CREATE TRIGGER fail_persistence ${trigger} BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`
          )
        );
        yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
        yield* settle;
        yield* h.service.stop(id);
        const summary = h.logger.find(e => e.message === 'Recording processing attempt ended');
        assert.include(summary?.data, {
          recordingId: id,
          outcome: 'failure',
          failedStage: 'storage',
        });
        assert.isUndefined(h.logger.find(e => e.message === 'Recording completed'));
        assert.strictEqual((yield* h.db.getRecoveryOutbox(id))?.phase, 'finalize');
        yield* Scope.close(h.sessionScope, Exit.void);
      })
    );
  }

  it.effect('failed authoritative recording creation stays in create phase', () =>
    Effect.gen(function* () {
      const h = yield* setup({}, undefined, {
        mode: 'local',
        localLane: mintingLocalLane(() => 'words'),
      });
      yield* Effect.sync(() =>
        h.product.client.exec(
          "CREATE TRIGGER fail_recording BEFORE INSERT ON recording BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END"
        )
      );
      const id = yield* h.service.start({ captureMode: 'mic' });
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* Queue.offer(h.fakeCapture.current().frames, fakeFrame('mic_raw', oneSecond()));
      yield* settle;
      yield* h.service.stop(id);
      assert.strictEqual((yield* h.db.getRecoveryOutbox(id))?.phase, 'create');
      assert.strictEqual(h.fakeCloud.finalizeCalls.length, 0);
      assert.deepStrictEqual(yield* productSegments(h, id), []);
      assert.isTrue(fs.existsSync(h.recoveryDir(id)));
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('failed durable job creation releases Start ownership for a retry', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* Effect.sync(() =>
        h.db.db.run(
          sql`CREATE TRIGGER fail_job BEFORE INSERT ON recovery_outbox BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`
        )
      );
      const refused = yield* Effect.either(h.service.start({ captureMode: 'mic' }));
      assert.deepInclude(refused, { _tag: 'Left' });
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'idle');
      assert.strictEqual(h.fakeCapture.sessions.length, 0);
      yield* Effect.sync(() => h.db.db.run(sql`DROP TRIGGER fail_job`));
      const id = yield* h.service.start({ captureMode: 'mic' });
      yield* h.service.stop(id);
      assert.strictEqual((yield* SubscriptionRef.get(h.service.state)).status, 'idle');
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );

  it.effect('one window can claim completion after any Stop initiator', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const id = yield* h.service.start({ captureMode: 'mic', noteId: 'nt_owner' });
      assert.isFalse(yield* h.service.claimCompletion(id), 'active capture has no completion');
      yield* poll(
        SubscriptionRef.get(h.service.state).pipe(Effect.map(s => s.status === 'recording')),
        'recording'
      );
      yield* h.service.stop(id);
      assert.isFalse(yield* h.service.claimCompletion('rec_stale'));
      const claims = yield* Effect.all(
        [h.service.claimCompletion(id), h.service.claimCompletion(id)],
        { concurrency: 'unbounded' }
      );
      assert.strictEqual(claims.filter(Boolean).length, 1);
      assert.isFalse(yield* h.service.claimCompletion(id));
      yield* Scope.close(h.sessionScope, Exit.void);
    })
  );
});
