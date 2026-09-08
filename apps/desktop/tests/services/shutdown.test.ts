import { assert, describe, it } from '@effect/vitest';
import { Context, Duration, Effect, Exit, Fiber, Layer, Scope, TestClock } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron } from '../helpers/fake-electron';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { ElectronAppLive } from '../../src/main/infra/electron/live';
import { ShutdownCoordinator } from '../../src/main/domains/shutdown/service';
import { ShutdownCoordinatorLive } from '../../src/main/domains/shutdown/live';
import { disposeAndExit } from '../../src/main/domains/shutdown/shutdown';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

const build = (platform: NodeJS.Platform) => {
  const logger = makeTestLogger();
  return {
    logger,
    layer: ShutdownCoordinatorLive.pipe(
      Layer.provide(testConfigLayer({ platform })),
      Layer.provide(ElectronAppLive.pipe(Layer.provide(logger.layer))),
      Layer.provide(logger.layer)
    ),
  };
};

describe('ShutdownCoordinator', () => {
  it.effect('awaitQuitSignal resolves on before-quit (which is preventDefault-ed)', () =>
    Effect.gen(function* () {
      const { layer } = build('darwin');
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const shutdown = Context.get(ctx, ShutdownCoordinator);

      const waiter = yield* Effect.fork(shutdown.awaitQuitSignal);
      yield* TestClock.adjust(Duration.millis(1));

      const before = fake.app.quitCount;
      fake.app.quit(); // emits before-quit; fake mirrors Electron
      yield* Fiber.join(waiter);
      assert.strictEqual(fake.app.quitCount, before + 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('window-all-closed quits on non-darwin', () =>
    Effect.gen(function* () {
      const { layer } = build('win32');
      const scope = yield* Scope.make();
      yield* Layer.build(layer).pipe(Scope.extend(scope));

      const before = fake.app.quitCount;
      fake.app.emit('window-all-closed');
      yield* TestClock.adjust(Duration.millis(1));
      assert.strictEqual(fake.app.quitCount, before + 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('window-all-closed stays resident on darwin', () =>
    Effect.gen(function* () {
      const { layer } = build('darwin');
      const scope = yield* Scope.make();
      yield* Layer.build(layer).pipe(Scope.extend(scope));

      const before = fake.app.quitCount;
      fake.app.emit('window-all-closed');
      yield* TestClock.adjust(Duration.millis(1));
      assert.strictEqual(fake.app.quitCount, before);
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('disposeAndExit', () => {
  it.effect('disposes exactly once, then exits 0', () =>
    Effect.gen(function* () {
      let disposeCalls = 0;
      const exits: number[] = [];
      yield* disposeAndExit({
        dispose: () => {
          disposeCalls += 1;
          return Promise.resolve();
        },
        exit: code => {
          exits.push(code);
        },
      });
      assert.strictEqual(disposeCalls, 1);
      assert.deepStrictEqual(exits, [0]);
    })
  );

  it.effect('a wedged dispose hits the 5s deadline and STILL exits 0', () =>
    Effect.gen(function* () {
      const exits: number[] = [];
      let timedOut = false;
      const fiber = yield* Effect.fork(
        disposeAndExit({
          dispose: () => new Promise<void>(() => undefined), // never resolves
          exit: code => {
            exits.push(code);
          },
          onTimeout: () => {
            timedOut = true;
          },
        })
      );
      yield* TestClock.adjust(Duration.seconds(4));
      assert.deepStrictEqual(exits, [], 'still waiting inside the deadline');
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(fiber);
      assert.isTrue(timedOut);
      assert.deepStrictEqual(exits, [0]);
    })
  );

  it.effect('a rejecting dispose reports the failure and still exits 0', () =>
    Effect.gen(function* () {
      const exits: number[] = [];
      const failures: unknown[] = [];
      const error = new Error('finalizer blew up');
      yield* disposeAndExit({
        dispose: () => Promise.reject(error),
        onFailure: failure => {
          failures.push(failure);
        },
        exit: code => {
          exits.push(code);
        },
      });
      assert.deepStrictEqual(failures, [error]);
      assert.deepStrictEqual(exits, [0]);
    })
  );
});
