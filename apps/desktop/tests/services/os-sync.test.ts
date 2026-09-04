/**
 * OS-sync consumer tests — the real SettingsService over a
 * fake OperationalDb + a fake NativeOs edge (electron-free): boot reconcile of the
 * current values, and per-field reactive apply (an unrelated settings change is
 * inert).
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { makeFakeNativeOs } from '../helpers/fake-native-os';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { makeTestLogger } from '../helpers/test-layers';
import { SettingsService } from '../../src/main/domains/settings/service';
import { SettingsServiceLive } from '../../src/main/domains/settings/live';
import { runOsSync } from '../../src/main/domains/settings/os-sync';

/** Cooperative wait for the forked sync fibers (no clock involved). */
const drainUntil = (predicate: () => boolean) =>
  Effect.iterate(0, {
    while: n => n < 200 && !predicate(),
    body: n => Effect.yieldNow().pipe(Effect.as(n + 1)),
  });

const build = (seed: Record<string, string> = {}) => {
  const logger = makeTestLogger();
  const db = makeFakeOperationalDb(seed);
  const nativeOs = makeFakeNativeOs();
  const layer = Layer.mergeAll(
    SettingsServiceLive.pipe(Layer.provide(db.layer), Layer.provide(logger.layer)),
    nativeOs.layer,
    // runOsSync logs a dropped OS-apply (catchAllDefect guard), so MainLogger must
    // be in the context it runs under.
    logger.layer
  );
  return { layer, nativeOs };
};

describe('runOsSync', () => {
  it.effect('reconciles the current values on boot, then applies only the changed field', () =>
    Effect.gen(function* () {
      const { layer, nativeOs } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);
      yield* runOsSync.pipe(Effect.provide(ctx), Scope.extend(scope));

      // Boot reconcile: the defaults are applied once each.
      yield* drainUntil(
        () => nativeOs.calls.loginItem.length >= 1 && nativeOs.calls.dock.length >= 1
      );
      assert.deepStrictEqual(nativeOs.calls.loginItem, [false]);
      assert.deepStrictEqual(nativeOs.calls.dock, [true]);

      // Flipping launchAtLogin re-applies ONLY the login item.
      yield* settings.set({ launchAtLogin: true });
      yield* drainUntil(() => nativeOs.calls.loginItem.length >= 2);
      assert.deepStrictEqual(nativeOs.calls.loginItem, [false, true]);
      assert.deepStrictEqual(nativeOs.calls.dock, [true]);

      // An unrelated settings change applies neither OS effect (Stream.changes).
      yield* settings.set({ widgetVisibility: 'never' });
      yield* drainUntil(() => false);
      assert.deepStrictEqual(nativeOs.calls.loginItem, [false, true]);
      assert.deepStrictEqual(nativeOs.calls.dock, [true]);

      // Flipping dockVisible re-applies ONLY the dock.
      yield* settings.set({ dockVisible: false });
      yield* drainUntil(() => nativeOs.calls.dock.length >= 2);
      assert.deepStrictEqual(nativeOs.calls.dock, [true, false]);
      assert.deepStrictEqual(nativeOs.calls.loginItem, [false, true]);

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('seeds the OS from persisted values on boot', () =>
    Effect.gen(function* () {
      const { layer, nativeOs } = build({
        'pref:launchAtLogin': 'true',
        'pref:dockVisible': 'false',
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* runOsSync.pipe(Effect.provide(ctx), Scope.extend(scope));

      yield* drainUntil(
        () => nativeOs.calls.loginItem.length >= 1 && nativeOs.calls.dock.length >= 1
      );
      assert.deepStrictEqual(nativeOs.calls.loginItem, [true]);
      assert.deepStrictEqual(nativeOs.calls.dock, [false]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('the sync fibers die with the scope — no apply after close', () =>
    Effect.gen(function* () {
      const { layer, nativeOs } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);
      yield* runOsSync.pipe(Effect.provide(ctx), Scope.extend(scope));
      yield* drainUntil(() => nativeOs.calls.loginItem.length >= 1);

      yield* Scope.close(scope, Exit.void);
      const settledLogin = nativeOs.calls.loginItem.length;
      yield* settings.set({ launchAtLogin: true });
      yield* drainUntil(() => false);
      assert.strictEqual(nativeOs.calls.loginItem.length, settledLogin);
    })
  );
});
