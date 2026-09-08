import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Queue, Scope } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron } from '../helpers/fake-electron';
import { FakeEvent } from '../helpers/fake-electron';
import { makeTestLogger } from '../helpers/test-layers';
import { ElectronApp } from '../../src/main/infra/electron/service';
import { ElectronAppLive } from '../../src/main/infra/electron/live';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

const APP_EVENTS = ['second-instance', 'open-url', 'activate', 'before-quit', 'window-all-closed'];

describe('ElectronApp', () => {
  it.effect('reset clears all browsing data and HTTP authentication, without filters', () =>
    Effect.gen(function* () {
      const ctx = yield* Layer.build(ElectronAppLive.pipe(Layer.provide(makeTestLogger().layer)));
      const storage = fake.session.defaultSession;
      const dataBefore = storage.clearDataCalls.length;
      const authBefore = storage.clearAuthCacheCalls;

      yield* Context.get(ctx, ElectronApp).clearRendererStorage;

      assert.deepStrictEqual(storage.clearDataCalls.slice(dataBefore), [{}]);
      assert.strictEqual(storage.clearAuthCacheCalls, authBefore + 1);
    }).pipe(Effect.scoped)
  );

  it.effect('reset still clears HTTP authentication when browsing-data cleanup fails', () =>
    Effect.gen(function* () {
      const ctx = yield* Layer.build(ElectronAppLive.pipe(Layer.provide(makeTestLogger().layer)));
      const storage = fake.session.defaultSession;
      const authBefore = storage.clearAuthCacheCalls;
      const clear = vi.spyOn(storage, 'clearData').mockRejectedValueOnce(new Error('cache unavailable'));
      try {
        const result = yield* Effect.exit(Context.get(ctx, ElectronApp).clearRendererStorage);
        assert.isTrue(Exit.isFailure(result));
        assert.strictEqual(storage.clearAuthCacheCalls, authBefore + 1);
      } finally {
        clear.mockRestore();
      }
    }).pipe(Effect.scoped)
  );

  it.effect('acquire registers one listener per event; release removes them all', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const baseline = fake.__appListenerTotal();

      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(ElectronAppLive.pipe(Layer.provide(logger.layer))).pipe(
        Scope.extend(scope)
      );
      const service = Context.get(ctx, ElectronApp);

      for (const event of APP_EVENTS) {
        assert.strictEqual(fake.app.listenerCount(event), 1, `listener for ${event}`);
      }

      // Typed events flow into the queues.
      fake.app.emit('open-url', new FakeEvent(), 'prismical://oauth/callback?code=a&state=b');
      const openUrl = yield* Queue.take(service.events.openUrl);
      assert.strictEqual(openUrl.url, 'prismical://oauth/callback?code=a&state=b');

      fake.app.emit('second-instance', new FakeEvent(), ['bin', 'prismical://app/x']);
      const second = yield* Queue.take(service.events.secondInstance);
      assert.deepStrictEqual(second.argv, ['bin', 'prismical://app/x']);

      // before-quit is always prevented and queued.
      const quitEvent = new FakeEvent();
      fake.app.emit('before-quit', quitEvent);
      assert.isTrue(quitEvent.defaultPrevented);
      yield* Queue.take(service.events.beforeQuit);

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(fake.__appListenerTotal(), baseline, 'all listeners removed');
      assert.isDefined(logger.find(entry => entry.message === 'app event streams detached'));
    })
  );

  it.effect('open-url events are preventDefault-ed at the listener', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      yield* Layer.build(ElectronAppLive.pipe(Layer.provide(logger.layer))).pipe(Scope.extend(scope));
      const event = new FakeEvent();
      fake.app.emit('open-url', event, 'prismical://app/');
      assert.isTrue(event.defaultPrevented);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('powerMonitor resume feeds a typed queue after ready; release detaches it', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(ElectronAppLive.pipe(Layer.provide(logger.layer))).pipe(
        Scope.extend(scope)
      );
      const service = Context.get(ctx, ElectronApp);

      // Registration is ready-gated (a scoped fiber awaits whenReady) — let it land.
      yield* Effect.iterate(0, {
        while: n => n < 100 && fake.powerMonitor.listenerCount('resume') === 0,
        body: n => Effect.promise(() => Promise.resolve(n + 1)),
      });
      assert.strictEqual(fake.powerMonitor.listenerCount('resume'), 1);

      fake.powerMonitor.emit('resume');
      yield* Queue.take(service.events.powerResume);

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(fake.powerMonitor.listenerCount('resume'), 0, 'resume listener removed');
    })
  );
});
