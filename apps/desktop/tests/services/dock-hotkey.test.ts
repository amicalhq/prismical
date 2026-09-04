/**
 * Dock hotkey tests — the settings-reactive globalShortcut
 * projection:
 *  - the persisted accelerator registers on boot; pressing it TOGGLES the
 *    float (open(null) when closed, collapse when open);
 *  - changing `dockHotkey` unregisters the old accelerator and registers the
 *    new one; '' disables outright;
 *  - a registration failure (OS conflict / invalid accelerator) warns and
 *    leaves the hotkey off — never crashes the fiber;
 *  - closing the scope unregisters whatever is held.
 */
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Scope, SubscriptionRef } from 'effect';
import { vi } from 'vitest';
import type { FloatStateView } from '@prismical/desktop-contracts';
import type { FakeElectron } from '../helpers/fake-electron';
import { makeTestLogger, type TestLogger } from '../helpers/test-layers';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { SettingsService, type SettingsServiceApi } from '../../src/main/domains/settings/service';
import { SettingsServiceLive } from '../../src/main/domains/settings/live';
import { FloatBridge, type FloatBridgeApi } from '../../src/main/domains/windows/float-bridge';
import { runDockHotkey } from '../../src/main/domains/windows/dock-hotkey';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

/** Let the forked settings fiber + runFork'd toggles settle. */
const flush: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 8; i += 1) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
  }
});

interface Harness {
  readonly logger: TestLogger;
  readonly settings: SettingsServiceApi;
  readonly state: SubscriptionRef.SubscriptionRef<FloatStateView>;
  readonly opens: Array<{ noteId: string | null; options: unknown }>;
  readonly collapses: () => number;
  readonly scope: Scope.CloseableScope;
}

const setup = (): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const scope = yield* Scope.make();
    const state = yield* SubscriptionRef.make<FloatStateView>({ open: false, noteId: null });
    const opens: Array<{ noteId: string | null; options: unknown }> = [];
    let collapses = 0;
    const floatBridge: FloatBridgeApi = {
      state,
      open: (noteId, options) =>
        Effect.sync(() => {
          opens.push({ noteId, options });
          return true;
        }),
      collapse: Effect.sync(() => {
        collapses += 1;
      }),
      dockBack: Effect.void,
      reset: Effect.void,
    };
    const env = Layer.mergeAll(
      logger.layer,
      SettingsServiceLive.pipe(
        Layer.provide(makeFakeOperationalDb().layer),
        Layer.provide(logger.layer)
      ),
      Layer.succeed(FloatBridge, floatBridge)
    );
    const settings = yield* Effect.gen(function* () {
      yield* runDockHotkey;
      return yield* SettingsService;
    }).pipe(Effect.provide(env), Scope.extend(scope));
    yield* flush;
    return { logger, settings, state, opens, collapses: () => collapses, scope } satisfies Harness;
  }).pipe(Effect.orDie);

const registered = (): string[] => [...fake.globalShortcut.__registered().keys()];

const press = (accelerator: string): void => {
  const callback = fake.globalShortcut.__registered().get(accelerator);
  if (callback === undefined) throw new Error(`not registered: ${accelerator}`);
  callback();
};

describe('dock hotkey', () => {
  it.effect('registers the persisted accelerator; pressing TOGGLES the float', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.deepStrictEqual(registered(), ['Alt+Shift+N']); // the default

      press('Alt+Shift+N'); // closed → open the slot
      yield* flush;
      assert.deepStrictEqual(h.opens, [{ noteId: null, options: undefined }]);
      assert.strictEqual(h.collapses(), 0);

      yield* SubscriptionRef.set(h.state, { open: true, noteId: 'nt_1' });
      press('Alt+Shift+N'); // open → collapse
      yield* flush;
      assert.strictEqual(h.opens.length, 1);
      assert.strictEqual(h.collapses(), 1);

      yield* Scope.close(h.scope, Exit.void);
      assert.deepStrictEqual(registered(), []); // the finalizer released it
    })
  );

  it.effect("a settings change re-registers; '' disables outright", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.settings.set({ dockHotkey: 'CommandOrControl+J' });
      yield* flush;
      assert.deepStrictEqual(registered(), ['CommandOrControl+J']);
      assert.isDefined(h.logger.find(e => e.message === 'dock hotkey registered'));

      yield* h.settings.set({ dockHotkey: '' });
      yield* flush;
      assert.deepStrictEqual(registered(), []);
      assert.isDefined(h.logger.find(e => e.message === 'dock hotkey disabled'));

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a registration conflict warns and leaves the hotkey off', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      // The fake treats accelerators containing '!' as held by another app.
      yield* h.settings.set({ dockHotkey: 'Alt+!conflict' });
      yield* flush;
      assert.deepStrictEqual(registered(), []); // the old one released, the new one refused
      assert.isDefined(
        h.logger.find(e => e.message === 'dock hotkey registration failed — hotkey off')
      );
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a THROWING register (invalid accelerator) warns and the fiber survives', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      // The fake throws on '@' — real Electron throws on a malformed chord.
      yield* h.settings.set({ dockHotkey: 'Alt+@bogus' });
      yield* flush;
      assert.deepStrictEqual(registered(), []);
      assert.isDefined(
        h.logger.find(e => e.message === 'dock hotkey registration failed — hotkey off')
      );
      // The fiber is still alive: a later valid accelerator registers.
      yield* h.settings.set({ dockHotkey: 'Alt+Shift+K' });
      yield* flush;
      assert.deepStrictEqual(registered(), ['Alt+Shift+K']);
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});
