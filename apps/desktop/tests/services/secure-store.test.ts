import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Queue, Scope } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron } from '../helpers/fake-electron';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { ElectronApp, type ElectronAppService } from '../../src/main/infra/electron/service';
import { OperationalDb } from '../../src/main/infra/operational-db/service';
import { OperationalDbLive } from '../../src/main/infra/operational-db/live';
import { SecureStore } from '../../src/main/infra/secure-store/service';
import { SecureStoreLive } from '../../src/main/infra/secure-store/live';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

const electronAppStub = Layer.effect(
  ElectronApp,
  Effect.gen(function* () {
    const empty = yield* Queue.sliding<never>(1);
    const service: ElectronAppService = {
      whenReady: Effect.void,
      preferredSystemLanguages: Effect.succeed(['en-US']),
      quit: Effect.void,
      exit: () => Effect.void,
      clearRendererStorage: Effect.void,
      events: {
        secondInstance: empty,
        openUrl: empty,
        activate: empty,
        beforeQuit: empty,
        windowAllClosed: empty,
        powerResume: empty,
      },
    };
    return service;
  })
);

const build = (overrides: Parameters<typeof testConfigLayer>[0] = {}) => {
  const logger = makeTestLogger();
  const config = testConfigLayer(overrides);
  const db = OperationalDbLive.pipe(Layer.provide(config), Layer.provide(logger.layer));
  return {
    logger,
    layer: SecureStoreLive.pipe(
      Layer.provide(config),
      Layer.provide(electronAppStub),
      Layer.provideMerge(db),
      Layer.provide(logger.layer)
    ),
  };
};

describe('SecureStore', () => {
  it.effect('encrypts to the settings table under the secure: prefix and round-trips', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const store = Context.get(ctx, SecureStore);
      const db = Context.get(ctx, OperationalDb);

      yield* store.setSecret('refreshToken', 'rt-12345');
      const stored = yield* db.getSetting('secure:refreshToken');
      assert.isNotNull(stored);
      // Ciphertext (fake: base64 of enc:…), never the plaintext.
      assert.notInclude(stored ?? '', 'rt-12345');
      assert.strictEqual(
        Buffer.from(stored ?? '', 'base64').toString('utf8'),
        'enc:rt-12345',
        'safeStorage codec used'
      );
      assert.strictEqual(yield* store.getSecret('refreshToken'), 'rt-12345');
      assert.isNull(yield* store.getSecret('missing'));

      yield* store.deleteSecret('refreshToken');
      assert.isNull(yield* db.getSetting('secure:refreshToken'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('acquire fails typed when encryption is unavailable (non-E2E)', () =>
    Effect.gen(function* () {
      fake.safeStorage.available = false;
      const { layer } = build();
      const scope = yield* Scope.make();
      const exit = yield* Effect.exit(Layer.build(layer).pipe(Scope.extend(scope)));
      fake.safeStorage.available = true;
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(JSON.stringify(exit.cause), 'secure-store');
      }
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('E2E runs use the deterministic fake codec (no keychain dependency)', () =>
    Effect.gen(function* () {
      fake.safeStorage.available = false; // must not matter under E2E
      const { layer, logger } = build({ isE2E: true, secureStoreMode: 'e2e-fake' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      fake.safeStorage.available = true;
      const store = Context.get(ctx, SecureStore);
      const db = Context.get(ctx, OperationalDb);

      yield* store.setSecret('k', 'v');
      const stored = yield* db.getSetting('secure:k');
      assert.strictEqual(Buffer.from(stored ?? '', 'base64').toString('utf8'), 'e2e:v');
      assert.strictEqual(yield* store.getSecret('k'), 'v');
      assert.isDefined(
        logger.find(
          e => e.message === 'secure store ready' && JSON.stringify(e.data).includes('e2e-fake')
        )
      );
      yield* Scope.close(scope, Exit.void);
    })
  );
});
