import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Queue, Scope } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron, FakeMenuItem } from '../helpers/fake-electron';
import { makeTestLogger, testConfigLayer, testI18nLayer } from '../helpers/test-layers';
import { ElectronAppLive } from '../../src/main/infra/electron/live';
import { TrayService } from '../../src/main/domains/tray/service';
import { TrayServiceLive } from '../../src/main/domains/tray/live';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

const build = () => {
  const logger = makeTestLogger();
  return {
    logger,
    layer: TrayServiceLive.pipe(
      Layer.provide(testConfigLayer()),
      Layer.provide(testI18nLayer('de')),
      Layer.provide(ElectronAppLive.pipe(Layer.provide(logger.layer))),
      Layer.provide(logger.layer)
    ),
  };
};

describe('TrayService', () => {
  it.effect('acquires a tray with menu; click + menu items enqueue typed commands', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const tray = Context.get(ctx, TrayService);

      const instance = fake.__trayInstances().at(-1);
      assert.isDefined(instance);
      if (!instance) return;
      assert.strictEqual(instance.listenerCount('click'), 1);
      const menu = instance.contextMenu as { items: FakeMenuItem[] };
      assert.deepStrictEqual(
        menu.items.map(item => item.label ?? item.type),
        ['Prismical öffnen', 'separator', 'Prismical beenden']
      );
      assert.strictEqual(instance.tooltip, 'Prismical');

      instance.emit('click');
      assert.strictEqual(yield* Queue.take(tray.commands), 'open');
      menu.items[2]?.click?.();
      assert.strictEqual(yield* Queue.take(tray.commands), 'quit');
      menu.items[0]?.click?.();
      assert.strictEqual(yield* Queue.take(tray.commands), 'open');

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('release detaches listeners and menu but keeps the reusable tray instance', () =>
    Effect.gen(function* () {
      const { layer, logger } = build();
      const scope = yield* Scope.make();
      yield* Layer.build(layer).pipe(Scope.extend(scope));
      const instance = fake.__trayInstances().at(-1);
      assert.isDefined(instance);
      if (!instance) return;

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(instance.listenerCount('click'), 0, 'click listener detached');
      assert.isNull(instance.contextMenu, 'menu detached (closures freed)');
      assert.isFalse(instance.isDestroyed(), 'tray intentionally not destroyed');
      assert.isDefined(logger.find(e => e.message.includes('tray listeners detached')));
    })
  );
});
