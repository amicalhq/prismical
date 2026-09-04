/**
 * WhisperEngine host tests — the fork recipe and the IPC
 * pump against a FAKE child (no sidecar, no worker bundle, no model):
 *
 *  - lazy fork with the sidecar recipe (execPath / execArgv [] / env / silent / cwd)
 *    on the first call; initializeModel cached by path, re-sent on change;
 *  - Float32Array args cross as { __type: 'Float32Array', data } and the
 *    worker's answer comes back verbatim;
 *  - a worker error reply → inference-failed; transcribe before ensureModel → inference-failed;
 *  - a child that dies mid-call → worker-crashed, and the NEXT call re-forks and
 *    re-loads the remembered model; a death before the first message → spawn-failed;
 *    a throwing fork → spawn-failed;
 *  - a call over budget → timeout and the worker is killed (replaced next call);
 *  - log frames land on the whisper-worker scope at their level; closing the
 *    scope kills the child and rejects whatever was pending.
 */
import { EventEmitter } from 'node:events';
import { assert, describe, it } from '@effect/vitest';
import { Context, Duration, Effect, Exit, Fiber, Layer, Scope, TestClock } from 'effect';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import {
  TRANSCRIBE_TIMEOUT,
  makeWhisperEngineLive,
  resolveWhisperWorkerPaths,
  type ForkLike,
  type WhisperWorkerPaths,
} from '../../src/main/infra/whisper/engine';
import type { WorkerRequest } from '../../src/main/infra/whisper/protocol';
import { WhisperEngine, WhisperEngineError } from '../../src/main/infra/whisper/service';

class FakeWorker extends EventEmitter {
  readonly sent: WorkerRequest[] = [];
  readonly stdout = null;
  readonly stderr = null;
  killed = false;
  connected = true;
  send(message: WorkerRequest): boolean {
    if (!this.connected) throw new Error('ERR_IPC_CHANNEL_CLOSED');
    this.sent.push(message);
    return true;
  }
  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.connected = false;
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
  /** The worker's boot log frame — the host treats ANY first message as "ready". */
  boot(): void {
    this.emit('message', { type: 'log', level: 'info', message: 'Worker process started' });
  }
  reply(id: number, result: unknown): void {
    this.emit('message', { id, result });
  }
  fail(id: number, error: string): void {
    this.emit('message', { id, error });
  }
  die(code: number): void {
    this.connected = false;
    this.emit('exit', code, null);
  }
}

const PATHS: WhisperWorkerPaths = {
  nodeBinaryPath: '/fake/resources/node',
  workerPath: '/fake/resources/app.asar.unpacked/.vite/build/whisper-worker-fork.js',
  cwd: '/fake/resources',
  asarPath: '/fake/resources/app.asar',
};

interface ForkCall {
  readonly modulePath: string;
  readonly options: Parameters<ForkLike>[2];
  readonly child: FakeWorker;
}

const build = (options: { throwOnFork?: Error; transcribeTimeout?: Duration.Duration } = {}) =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const forks: ForkCall[] = [];
    const forkFn: ForkLike = (modulePath, _args, forkOptions) => {
      if (options.throwOnFork) throw options.throwOnFork;
      const child = new FakeWorker();
      forks.push({ modulePath, options: forkOptions, child });
      return child as unknown as ReturnType<ForkLike>;
    };
    const scope = yield* Scope.make();
    const ctx = yield* Layer.build(
      makeWhisperEngineLive({
        paths: PATHS,
        forkFn,
        ...(options.transcribeTimeout ? { transcribeTimeout: options.transcribeTimeout } : {}),
      }).pipe(Layer.provide(Layer.mergeAll(testConfigLayer(), logger.layer)))
    ).pipe(Scope.extend(scope));
    return { engine: Context.get(ctx, WhisperEngine), forks, logger, scope };
  });

/** Let forked fibers run up to their next async boundary. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 25; i += 1) yield* Effect.yieldNow();
});

const MODEL = '/models/ggml-base.en.bin';
const OPTIONS = {
  language: 'en',
  initial_prompt: '',
  suppress_blank: true,
  suppress_non_speech_tokens: true,
  no_timestamps: false,
};

describe('WhisperEngine host', () => {
  it.effect('forks lazily with the sidecar recipe on the first ensureModel; the model is cached by path', () =>
    Effect.gen(function* () {
      const h = yield* build();
      assert.strictEqual(h.forks.length, 0, 'nothing forked at layer build');

      const first = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      assert.strictEqual(h.forks.length, 1);
      const { modulePath, options, child } = h.forks[0];
      assert.strictEqual(modulePath, PATHS.workerPath);
      assert.strictEqual(options.execPath, PATHS.nodeBinaryPath);
      assert.deepStrictEqual(options.execArgv, [], 'no parent loaders leak into the worker');
      assert.strictEqual(options.cwd, PATHS.cwd);
      assert.strictEqual(options.silent, true);
      const env = options.env as Record<string, string>;
      assert.strictEqual(env.ELECTRON_RUN_AS_NODE, '1');
      assert.strictEqual(env.NODE_OPTIONS, '--max-old-space-size=8192');
      assert.strictEqual(env.APP_ASAR_PATH, PATHS.asarPath);
      assert.deepStrictEqual(child.sent, [{ id: 0, method: 'initializeModel', args: [MODEL] }]);

      child.boot();
      child.reply(0, undefined);
      yield* Fiber.join(first);

      // Same path → no round trip. Other path → initializeModel again, same worker.
      yield* h.engine.ensureModel(MODEL);
      assert.strictEqual(child.sent.length, 1);
      const other = yield* Effect.fork(h.engine.ensureModel('/models/ggml-tiny.bin'));
      yield* settle;
      assert.deepStrictEqual(child.sent[1], {
        id: 1,
        method: 'initializeModel',
        args: ['/models/ggml-tiny.bin'],
      });
      child.reply(1, undefined);
      yield* Fiber.join(other);
      assert.strictEqual(h.forks.length, 1, 'still the one worker');
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('transcribe serializes the Float32Array as { __type, data }, passes the options verbatim and yields the answer', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const init = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      const child = h.forks[0].child;
      child.boot();
      child.reply(0, undefined);
      yield* Fiber.join(init);

      const audio = new Float32Array([0.5, -0.25, 0.125]);
      const call = yield* Effect.fork(h.engine.transcribe(audio, { ...OPTIONS, vad: true }));
      yield* settle;
      assert.deepStrictEqual(child.sent[1], {
        id: 1,
        method: 'transcribeAudio',
        args: [{ __type: 'Float32Array', data: [0.5, -0.25, 0.125] }, { ...OPTIONS, vad: true }],
      });
      const answer = { text: ' hello', segments: [{ text: ' hello', from: 0, to: 900 }] };
      child.reply(1, answer);
      assert.deepStrictEqual(yield* Fiber.join(call), answer);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a worker error reply is inference-failed (its message kept); transcribe before any ensureModel is inference-failed too', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const early = yield* h.engine.transcribe(new Float32Array(1), OPTIONS).pipe(Effect.flip);
      assert.strictEqual(early.reason, 'inference-failed');
      assert.strictEqual(h.forks.length, 0, 'no worker forked for a call that cannot run');

      const init = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      const child = h.forks[0].child;
      child.boot();
      child.fail(0, 'Failed to initialize whisper context');
      const error = yield* Fiber.join(init).pipe(Effect.flip);
      assert.instanceOf(error, WhisperEngineError);
      assert.strictEqual(error.reason, 'inference-failed');
      assert.strictEqual(error.detail, 'Failed to initialize whisper context');
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a child that dies mid-call rejects it worker-crashed; the next call re-forks and re-loads the remembered model', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const init = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      const first = h.forks[0].child;
      first.boot();
      first.reply(0, undefined);
      yield* Fiber.join(init);

      const call = yield* Effect.fork(h.engine.transcribe(new Float32Array(16_000), OPTIONS));
      yield* settle;
      first.die(139);
      const error = yield* Fiber.join(call).pipe(Effect.flip);
      assert.strictEqual(error.reason, 'worker-crashed');

      const retry = yield* Effect.fork(h.engine.transcribe(new Float32Array(16_000), OPTIONS));
      yield* settle;
      assert.strictEqual(h.forks.length, 2, 're-forked');
      const second = h.forks[1].child;
      // The model is loaded again BEFORE the decode — transparently.
      assert.deepStrictEqual(second.sent[0], { id: 0, method: 'initializeModel', args: [MODEL] });
      second.boot();
      second.reply(0, undefined);
      yield* settle;
      assert.strictEqual(second.sent[1]?.method, 'transcribeAudio');
      second.reply(1, { text: 'ok', segments: [] });
      assert.deepStrictEqual(yield* Fiber.join(retry), { text: 'ok', segments: [] });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a death before the first message (missing sidecar / whisper.node) is spawn-failed; a throwing fork too', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const init = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      const child = h.forks[0].child;
      child.emit('error', Object.assign(new Error('spawn /fake/resources/node ENOENT'), { code: 'ENOENT' }));
      const error = yield* Fiber.join(init).pipe(Effect.flip);
      assert.strictEqual(error.reason, 'spawn-failed');
      assert.match(error.detail ?? '', /ENOENT/);

      // A worker that exits 1 while loading the binding (no message ever) — same class.
      const again = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      h.forks[1].child.die(1);
      assert.strictEqual((yield* Fiber.join(again).pipe(Effect.flip)).reason, 'spawn-failed');
      yield* Scope.close(h.scope, Exit.void);

      const throwing = yield* build({ throwOnFork: new Error('EACCES') });
      const thrown = yield* throwing.engine.ensureModel(MODEL).pipe(Effect.flip);
      assert.strictEqual(thrown.reason, 'spawn-failed');
      assert.strictEqual(thrown.detail, 'EACCES');
      yield* Scope.close(throwing.scope, Exit.void);
    })
  );

  it.effect('a call over budget is timeout; the stuck worker is killed and the next call re-forks', () =>
    Effect.gen(function* () {
      const h = yield* build({ transcribeTimeout: Duration.seconds(60) });
      const init = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      const child = h.forks[0].child;
      child.boot();
      child.reply(0, undefined);
      yield* Fiber.join(init);

      const call = yield* Effect.fork(h.engine.transcribe(new Float32Array(16_000), OPTIONS));
      yield* settle;
      yield* TestClock.adjust(Duration.seconds(61));
      const error = yield* Fiber.join(call).pipe(Effect.flip);
      assert.strictEqual(error.reason, 'timeout');
      assert.isTrue(child.killed, 'the presumed-stuck worker is replaced');
      assert.isDefined(
        h.logger.find(
          e => e.scope === 'whisper-engine' && e.message === 'whisper worker call timed out — replacing the worker'
        )
      );

      const next = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      assert.strictEqual(h.forks.length, 2);
      h.forks[1].child.boot();
      h.forks[1].child.reply(0, undefined);
      yield* Fiber.join(next);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('log frames land on the whisper-worker scope at their level; scope close kills the child and rejects the pending call', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const init = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      const child = h.forks[0].child;
      child.emit('message', { type: 'log', level: 'warn', message: 'Segments: 3 total, 1 kept', args: ['x'] });
      child.emit('message', { type: 'log', level: 'bogus', message: 'odd level' });
      const warn = h.logger.find(e => e.scope === 'whisper-worker' && e.level === 'warn');
      assert.deepStrictEqual(warn && { message: warn.message, data: warn.data }, {
        message: 'Segments: 3 total, 1 kept',
        data: { args: ['x'] },
      });
      assert.strictEqual(
        h.logger.find(e => e.scope === 'whisper-worker' && e.message === 'odd level')?.level,
        'info',
        'an unknown level folds to info'
      );

      yield* Scope.close(h.scope, Exit.void);
      assert.isTrue(child.killed);
      const error = yield* Fiber.join(init).pipe(Effect.flip);
      assert.strictEqual(error.reason, 'worker-crashed');
    })
  );

  it('TRANSCRIBE_TIMEOUT budgets a worst-case decode — 300 s for one padded chunk on a large CPU-only model', () => {
    assert.strictEqual(Duration.toMillis(TRANSCRIBE_TIMEOUT), 300_000);
  });

  it.effect('a failed model switch clears the cached path — the next call re-attempts the load and never decodes against the freed model', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const init = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      const child = h.forks[0].child;
      child.boot();
      child.reply(0, undefined);
      yield* Fiber.join(init);

      // Switch to another model. The worker frees the OLD model FIRST, then
      // fails the new load and REPLIES (an error reply — no crash, no re-fork),
      // so after this the worker holds NO model at all.
      const other = '/models/ggml-large-v3.bin';
      const switchTo = yield* Effect.fork(h.engine.ensureModel(other));
      yield* settle;
      assert.deepStrictEqual(child.sent[1], { id: 1, method: 'initializeModel', args: [other] });
      child.fail(1, 'failed to load model');
      const error = yield* Fiber.join(switchTo).pipe(Effect.flip);
      assert.strictEqual(error.reason, 'inference-failed');

      // transcribe (still requesting `other`) must re-attempt initializeModel
      // first — with the stale cache it would decode straight away and SIGSEGV
      // against the freed instance for the rest of the boot scope.
      const call = yield* Effect.fork(h.engine.transcribe(new Float32Array(16_000), OPTIONS));
      yield* settle;
      assert.deepStrictEqual(child.sent[2], { id: 2, method: 'initializeModel', args: [other] });
      child.reply(2, undefined);
      yield* settle;
      assert.strictEqual(child.sent[3]?.method, 'transcribeAudio');
      child.reply(3, { text: 'ok', segments: [] });
      assert.deepStrictEqual(yield* Fiber.join(call), { text: 'ok', segments: [] });

      // Even re-ensuring the ORIGINAL model reloads — the worker freed it too.
      const back = yield* Effect.fork(h.engine.ensureModel(MODEL));
      yield* settle;
      assert.deepStrictEqual(child.sent[4], { id: 4, method: 'initializeModel', args: [MODEL] });
      child.reply(4, undefined);
      yield* Fiber.join(back);
      assert.strictEqual(h.forks.length, 1, 'same worker throughout (a replied error never kills)');
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it('resolveWhisperWorkerPaths: dev resolves the repo sidecar + .vite/build; packaged resolves Resources + app.asar.unpacked', () => {
    const dev = resolveWhisperWorkerPaths({ isPackaged: false, platform: 'darwin' });
    assert.strictEqual(
      dev.nodeBinaryPath,
      `${process.cwd()}/node-binaries/darwin-${process.arch}/node`
    );
    assert.strictEqual(dev.workerPath, `${process.cwd()}/.vite/build/whisper-worker-fork.js`);
    assert.strictEqual(dev.cwd, process.cwd());
    assert.isUndefined(dev.asarPath);
    assert.isTrue(
      resolveWhisperWorkerPaths({ isPackaged: false, platform: 'win32' }).nodeBinaryPath.endsWith(
        'node.exe'
      )
    );

    const resourcesPath = '/Applications/Prismical.app/Contents/Resources';
    const previous = process.resourcesPath;
    (process as { resourcesPath: string }).resourcesPath = resourcesPath;
    try {
      const packaged = resolveWhisperWorkerPaths({ isPackaged: true, platform: 'darwin' });
      assert.strictEqual(packaged.nodeBinaryPath, `${resourcesPath}/node`);
      assert.strictEqual(packaged.cwd, resourcesPath);
      assert.strictEqual(packaged.asarPath, `${resourcesPath}/app.asar`);
      // __dirname is this test file's dir here — only the rewrite rule is under test.
      assert.isTrue(packaged.workerPath.endsWith('/whisper-worker-fork.js'));
      assert.isFalse(packaged.workerPath.includes('/app.asar/'));
    } finally {
      (process as { resourcesPath: string | undefined }).resourcesPath = previous;
    }
  });
});
