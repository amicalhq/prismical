import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Fiber, Layer, Option, Result } from 'effect';
import { OperationalDbLive } from '../../src/main/infra/operational-db/live';
import { OperationalDb } from '../../src/main/infra/operational-db/service';
import type {
  RecoveryStreamConfig,
  RecordingStreamSamples,
} from '../../src/main/infra/operational-db/schema';
import {
  WorkspaceBackend,
  type RecordingSegment,
  type WorkspaceBackendApi,
} from '../../src/main/domains/transport/service';
import { makeOpenRecordingSocket } from '../../src/main/domains/transport/recording-socket';
import {
  makeRecordingStreamControl,
  runRecordingStream,
  useRecordingStream,
} from '../../src/main/domains/recording/stream';
import { makeFakeWorkspaceBackend } from '../helpers/fake-recording';
import {
  fakeStreamSegment as fakeSegment,
  fakeStreamOrganization,
  makeFakeRecordingStream,
} from '../helpers/fake-recording-stream';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';

const waitFor = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000; i++) {
      if (condition()) return;
      yield* Effect.sleep(1);
    }
    assert.isTrue(condition(), 'condition timed out');
  });

const setup = (captureMode: 'mic' | 'dual' = 'mic') =>
  Effect.gen(function* () {
    const dir = mkdtempSync(path.join(tmpdir(), 'prismical-stream-test-'));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
    );
    const context = yield* Layer.build(
      OperationalDbLive.pipe(
        Layer.provide(
          Layer.mergeAll(testConfigLayer({ operationalDbPath: ':memory:' }), makeTestLogger().layer)
        )
      )
    );
    const db = Context.get(context, OperationalDb);
    const config: RecoveryStreamConfig = { captureId: randomUUID(), connectionAttempt: 0 };
    yield* db.insertRecoveryOutbox({
      recordingId: 'rec_stream',
      captureMode,
      wavPath: dir,
      streamConfig: config,
      owner: { mode: 'cloud', sub: 'user', orgId: 'org_test' },
      createInput: { recordingId: 'rec_stream', title: 'Recording', captureMode, startedAt: 0 },
      engineConfig: {
        engine: 'cloud',
        modelId: 'prismical-cloud',
        byokBaseUrl: null,
        byokModel: null,
      },
    });
    const control = makeRecordingStreamControl();
    const peer = makeFakeRecordingStream();
    const fake = makeFakeWorkspaceBackend();
    const backend: WorkspaceBackendApi = {
      ...(yield* WorkspaceBackend.pipe(Effect.provide(fake.layer))),
      openRecordingSocket: peer.openSocket,
    };
    const transcripts: (readonly RecordingSegment[])[] = [];
    const run = (resume = config, expectedSamples?: RecordingStreamSamples, client = backend) =>
      runRecordingStream({
        recordingId: 'rec_stream',
        wavDir: dir,
        captureMode,
        config: resume,
        control,
        onTranscript: segments =>
          Effect.sync(() => {
            transcripts.push(segments);
          }),
        onLimit: Effect.void,
        expectedSamples,
      }).pipe(
        Effect.provideService(OperationalDb, db),
        Effect.provideService(WorkspaceBackend, client)
      );
    const audio = (source: 'mic' | 'system', samples: number) => {
      const wav = Buffer.alloc(44 + samples * 2);
      for (let i = 0; i < samples; i++) wav.writeInt16LE(i % 32767, 44 + i * 2);
      writeFileSync(path.join(dir, `${source}.wav`), wav);
      control.samples[source] = samples;
      return wav.subarray(44);
    };
    return { peer, control, run, db, audio, transcripts, backend };
  });

describe('desktop recording stream', () => {
  it.live('runs the native WebSocket client against a server that ACKs only durable flushes', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const pcm = h.audio('mic', 48_000 * 20);
      h.control.stopping = true;
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<WebSocketServer>(resolve => {
              const server: WebSocketServer = new WebSocketServer(
                { host: '127.0.0.1', port: 0 },
                () => resolve(server)
              );
            })
        ),
        server =>
          Effect.promise(
            () =>
              new Promise<void>(resolve => {
                for (const client of server.clients) client.terminate();
                server.close(() => resolve());
              })
          )
      );
      const frames: Buffer[] = [];
      let protocols: string | undefined;
      let requestPath: string | undefined;
      server.on('connection', (socket, request) => {
        protocols = request.headers['sec-websocket-protocol'];
        requestPath = request.url;
        let mic = 0;
        socket.on('message', (data, binary) => {
          if (binary) {
            const packet = Buffer.from(data as Buffer);
            frames.push(packet);
            mic = packet.readUInt32LE(1) + (packet.length - 5) / 2;
            return;
          }
          const command = JSON.parse(data.toString());
          const send = (message: unknown) => socket.send(JSON.stringify(message));
          if (command.type === 'start')
            send({
              type: 'ready',
              version: 1,
              status: 'open',
              sampleRate: 48_000,
              lanes: command.lanes,
              checkpoints: { mic: 0, system: 0 },
              maxFrameBytes: 131072,
              gcsFlushIntervalMs: 60_000,
              recordingLimitMs: 3_600_000,
            });
          if (command.type === 'flush' || command.type === 'stop')
            send({ type: 'ack', checkpoints: { mic, system: 0 } });
          if (command.type === 'stop') {
            send({ type: 'stopped', checkpoints: { mic, system: 0 }, durationMs: mic / 48 });
            send({
              type: 'finalized',
              status: 'done',
              results: [fakeSegment('rec_stream', 'mic', 1, 'Native socket text')],
            });
          }
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server port');
      const openRecordingSocket = makeOpenRecordingSocket({
        coreApiUrl: `http://127.0.0.1:${address.port}`,
        resolveIdentity: Effect.succeed({ idToken: 'test-token', activeOrgId: 'org_test' }),
      });
      const result = yield* h.run(undefined, undefined, { ...h.backend, openRecordingSocket });
      assert.strictEqual(result.status, 'done');
      assert.strictEqual(result.durationMs, 20_000);
      assert.strictEqual(result.segments[0]?.text, 'Native socket text');
      assert.deepStrictEqual(Buffer.concat(frames.map(frame => frame.subarray(5))), pcm);
      assert.deepStrictEqual(
        protocols?.split(',').map(value => value.trim()),
        ['prismical-recording-v1', 'bearer.test-token', 'org.org_test']
      );
      assert.strictEqual(requestPath, '/apps/v1/me/recordings/rec_stream/stream');
    }).pipe(Effect.scoped)
  );

  it.live('alternates lanes when only one packet fits after each socket drain', () =>
    Effect.gen(function* () {
      const h = yield* setup('dual');
      h.audio('mic', 48_000 * 10);
      h.audio('system', 48_000 * 10);
      h.peer.trackBufferedAmount = true;
      const fiber = yield* Effect.forkChild(h.run());
      yield* waitFor(() => h.peer.sockets[0]?.frames.length === 2);
      const socket = h.peer.sockets[0]!;
      for (let count = 3; count <= 8; count++) {
        socket.bufferedBytes = 48_005;
        yield* waitFor(() => socket.frames.length === count);
        assert.isAtMost(socket.bufferedBytes, 128 * 1024);
      }
      assert.deepStrictEqual(
        socket.frames.map(frame => frame[0]),
        [0, 1, 0, 1, 0, 1, 0, 1]
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped)
  );

  it.live('rejects finalized before stopped without publishing its text', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.peer.autoFinalize = false;
      const fiber = yield* Effect.forkChild(Effect.result(h.run()));
      yield* waitFor(() => h.peer.sockets[0]?.commands.length === 1);
      h.peer.reply(0, {
        type: 'finalized',
        status: 'done',
        results: [fakeSegment('rec_stream', 'mic', 1, 'Premature')],
      });
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure.code, 'not-stopped');
      assert.isEmpty(h.transcripts);
    }).pipe(Effect.scoped)
  );

  it.live('does not discard retained audio when the server reduces the recording limit', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.audio('mic', 48_000);
      h.peer.recordingLimitMs = 500;
      h.control.stopping = true;
      assert.propertyVal(yield* h.run(), 'status', 'failed');
    }).pipe(Effect.scoped)
  );

  it.live('rejects a truncated secondary lane even when maximum duration is unchanged', () =>
    Effect.gen(function* () {
      const h = yield* setup('dual');
      h.audio('mic', 48_000);
      h.audio('system', 24_000);
      h.control.stopping = true;
      const config = (yield* h.db.getRecoveryOutbox('rec_stream'))!.streamConfig!;
      const result = yield* Effect.result(h.run(config, { mic: 48_000, system: 48_000 }));
      assert.isTrue(Result.isFailure(result));
    }).pipe(Effect.scoped)
  );

  it.live('drains a mono backlog using durable flush ACKs without periodic server timers', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.audio('mic', 48_000 * 30);
      h.peer.autoAck = false;
      h.peer.ackOnFlush = true;
      h.control.stopping = true;
      const result = yield* h.run().pipe(Effect.timeoutOption(2000));
      assert.isTrue(Option.isSome(result));
    }).pipe(Effect.scoped)
  );
  it.live(
    'sends both lanes as exact retained PCM and waits past stopped for the terminal transcript',
    () =>
      Effect.gen(function* () {
        const h = yield* setup('dual');
        const mic = h.audio('mic', 30_000);
        const system = h.audio('system', 26_000);
        h.control.stopping = true;
        h.peer.autoFinalize = false;
        const fiber = yield* Effect.forkChild(h.run());
        yield* waitFor(
          () => h.peer.sockets[0]?.commands.some(command => command.type === 'stop') === true
        );
        const socket = h.peer.sockets[0]!;
        for (const [lane, pcm] of [
          [0, mic],
          [1, system],
        ] as const) {
          const frames = socket.frames.filter(frame => frame[0] === lane);
          assert.deepStrictEqual(Buffer.concat(frames.map(frame => frame.subarray(5))), pcm);
          assert.strictEqual(frames[0]!.readUInt32LE(1), 0);
          assert.strictEqual(frames[1]!.readUInt32LE(1), 24_000);
        }
        h.peer.reply(0, { type: 'stopped', checkpoints: h.peer.checkpoints, durationMs: 625 });
        yield* Effect.sleep(30);
        assert.isFalse(socket.closed, 'stopped is not terminal completion');
        h.peer.reply(0, {
          type: 'finalized',
          status: 'done',
          results: [fakeSegment('rec_stream', 'mic', 1, 'Final text')],
        });
        const result = yield* Fiber.join(fiber);
        assert.strictEqual(result.durationMs, 625);
        assert.strictEqual(result.segments[0]!.text, 'Final text');
        assert.strictEqual(result.status, 'done');
        assert.isEmpty(h.transcripts);
        assert.isTrue(socket.closed);
      }).pipe(Effect.scoped)
  );

  it.live(
    'reconnects from durable per-lane checkpoints and reserves a larger attempt before opening',
    () =>
      Effect.gen(function* () {
        const h = yield* setup('dual');
        h.audio('mic', 48_000);
        h.audio('system', 48_000);
        h.peer.autoAck = false;
        const fiber = yield* Effect.forkChild(h.run());
        yield* waitFor(() => h.peer.sockets[0]?.frames.length === 4);
        h.peer.checkpoints.mic = 12_000;
        h.peer.checkpoints.system = 24_000;
        h.peer.reply(0, { type: 'ack', checkpoints: h.peer.checkpoints });
        h.peer.disconnect(0);
        yield* waitFor(
          () =>
            h.peer.sockets[1]?.frames.some(frame => frame[0] === 0) === true &&
            h.peer.sockets[1]?.frames.some(frame => frame[0] === 1) === true
        );
        const socket = h.peer.sockets[1]!;
        assert.strictEqual(socket.frames.find(frame => frame[0] === 0)!.readUInt32LE(1), 12_000);
        assert.strictEqual(socket.frames.find(frame => frame[0] === 1)!.readUInt32LE(1), 24_000);
        assert.strictEqual(socket.commands[0]!.connectionAttempt, 2);
        assert.strictEqual(
          (yield* h.db.getRecoveryOutbox('rec_stream'))!.streamConfig!.connectionAttempt,
          2
        );
        assert.isTrue(h.peer.sockets[0]!.closed);
        yield* Fiber.interrupt(fiber);
        assert.isTrue(socket.closed);
      }).pipe(Effect.scoped),
    10_000
  );

  it.live('bounds outstanding frames and continues immediately after durable ACKs', () =>
    Effect.gen(function* () {
      const h = yield* setup('dual');
      h.audio('mic', 48_000 * 20);
      h.audio('system', 48_000 * 20);
      h.peer.autoAck = false;
      const fiber = yield* Effect.forkChild(h.run());
      yield* waitFor(() => h.peer.sockets[0]?.frames.length === 32);
      yield* Effect.sleep(40);
      assert.strictEqual(h.peer.sockets[0]!.frames.length, 32);
      h.peer.checkpoints.mic = 24_000;
      h.peer.checkpoints.system = 24_000;
      h.peer.reply(0, { type: 'ack', checkpoints: h.peer.checkpoints });
      yield* waitFor(() => h.peer.sockets[0]!.frames.length === 34);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped)
  );

  it.live(
    'flushes a partial pause tail after reconnect and resumes offsets without silence for the pause',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.audio('mic', 123);
        h.control.flush = 1;
        const fiber = yield* Effect.forkChild(h.run());
        yield* waitFor(() => h.peer.sockets[0]?.frames.length === 1);
        yield* Effect.sleep(40);
        assert.strictEqual(h.peer.sockets[0]!.frames.length, 1);
        h.audio('mic', 24_123);
        yield* waitFor(() => h.peer.sockets[0]!.frames.length === 2);
        assert.strictEqual(h.peer.sockets[0]!.frames[1]!.readUInt32LE(1), 123);
        h.control.stopping = true;
        yield* Fiber.join(fiber);
      }).pipe(Effect.scoped)
  );

  it.live(
    'restart keeps capture identity and attempts, and completed streams need no local audio',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.audio('mic', 48_000);
        const first = yield* Effect.forkChild(h.run());
        yield* waitFor(() => h.peer.checkpoints.mic === 48_000);
        yield* Fiber.interrupt(first);
        const persisted = (yield* h.db.getRecoveryOutbox('rec_stream'))!.streamConfig!;
        h.peer.status = 'completed';
        h.control.samples.mic = 0;
        h.control.stopping = true;
        const result = yield* h.run(persisted, { mic: 48_000, system: 0 });
        assert.strictEqual(result.durationMs, 1000);
        assert.strictEqual(result.status, 'done');
        assert.strictEqual(h.peer.sockets[1]!.commands[0]!.captureId, persisted.captureId);
        assert.strictEqual(h.peer.sockets[1]!.commands[0]!.connectionAttempt, 2);
        assert.isEmpty(h.peer.sockets[1]!.frames);
      }).pipe(Effect.scoped)
  );

  it.live('treats supersession and impossible checkpoints as permanent failures', () =>
    Effect.gen(function* () {
      for (const reason of ['superseded', 'checkpoint']) {
        const h = yield* setup();
        const fiber = yield* Effect.forkChild(Effect.result(h.run()));
        yield* waitFor(() => h.peer.sockets.length === 1);
        if (reason === 'superseded') h.peer.disconnect(0, 4009);
        else h.peer.reply(0, { type: 'ack', checkpoints: { mic: 1, system: 0 } });
        const result = yield* Fiber.join(fiber);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure.code, reason);
          assert.isFalse(result.failure.retryable);
        }
        assert.strictEqual(h.peer.sockets.length, 1);
      }
    }).pipe(Effect.scoped)
  );

  it.live('retains available final text while reporting terminal transcription failure', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.control.stopping = true;
      h.peer.autoFinalize = false;
      const fiber = yield* Effect.forkChild(h.run());
      yield* waitFor(
        () => h.peer.sockets[0]?.commands.some(command => command.type === 'stop') === true
      );
      h.peer.reply(0, { type: 'stopped', checkpoints: h.peer.checkpoints, durationMs: 0 });
      h.peer.reply(0, {
        type: 'finalized',
        status: 'failed',
        reason: 'transcription_incomplete',
        results: [fakeSegment('rec_stream', 'mic', 1, 'Available text')],
      });
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.segments[0]!.text, 'Available text');
    }).pipe(Effect.scoped)
  );

  it.live('rejects truncated recovery audio while the server session is still open', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.audio('mic', 24_000);
      h.control.stopping = true;
      const config = (yield* h.db.getRecoveryOutbox('rec_stream'))!.streamConfig!;
      const result = yield* Effect.result(h.run(config, { mic: 48_000, system: 0 }));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.strictEqual(result.failure.code, 'recovery-audio-incomplete');
      assert.isEmpty(h.peer.sockets[0]!.frames);
      assert.isFalse(h.peer.sockets[0]!.commands.some(command => command.type === 'stop'));
    }).pipe(Effect.scoped)
  );

  it.live(
    'selects only the owning organization flag and reads it again for the next recording',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        let enabled = true;
        const backend = {
          ...h.backend,
          identity: { sub: 'user', activeOrgId: 'org_test' },
          request: () =>
            Effect.succeed({
              ok: true as const,
              status: 200,
              bodyJson: {
                results: [
                  fakeStreamOrganization('org_other', true),
                  fakeStreamOrganization('org_test', enabled),
                ],
              },
            }),
        };
        assert.isTrue(yield* useRecordingStream(backend));
        enabled = false;
        assert.isFalse(yield* useRecordingStream(backend));
        assert.isFalse(
          yield* useRecordingStream({
            ...backend,
            request: () => Effect.succeed({ error: { code: 'INTERNAL' } }),
          })
        );
      }).pipe(Effect.scoped)
  );
});
