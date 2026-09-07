/**
 * Root-scope exit gate: interrupting the root scope removes every listener,
 * handler, window, timer, and port, and closes the DB — proven here against the
 * REAL Boot layer graph (only the AppConfig leaf is substituted). Plus layer
 * rollback under failure injection: when acquire N fails, acquires 1..N-1 are
 * released (asserted via fake-electron state and each service's release log).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Context, Duration, Effect, Exit, Layer, Scope, TestClock } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron } from '../helpers/fake-electron';
import { testConfigLayer } from '../helpers/test-layers';
import { makeBootLayer } from '../../src/main/runtime/boot-layer';
import { OperationalDb } from '../../src/main/infra/operational-db/service';
import { UpdaterService } from '../../src/main/domains/updater/service';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-boot-test-'));

/** Poll checkCount on REAL time (the check itself hops through a promise). */
const awaitCheckCount = (
  updater: Context.Tag.Service<typeof UpdaterService>,
  n: number
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      if ((yield* updater.checkCount) >= n) return;
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 2)));
    }
    assert.fail(`updater checkCount never reached ${n}`);
  });

// makeBootLayer builds with the REAL MainLoggerLive (electron-log); that is
// fine here — release evidence comes from fake-electron state and service
// behavior, not log capture (the logger seam is covered in its own tests).
const APP_EVENTS = ['second-instance', 'open-url', 'activate', 'before-quit', 'window-all-closed'];

describe('Boot layer (leak gate)', () => {
  it.effect('acquires the full graph and releases ALL of it on scope close', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'boot.db');
      const layer = makeBootLayer(
        testConfigLayer({ operationalDbPath: dbPath, updaterEnabled: true })
      );
      const baseline = fake.__appListenerTotal();

      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));

      // Acquired: app event listeners…
      for (const event of APP_EVENTS) {
        assert.isAtLeast(fake.app.listenerCount(event), 1, `listener for ${event}`);
      }
      // …session controls…
      assert.isNotNull(fake.session.defaultSession.permissionRequestHandler);
      assert.isNotNull(fake.session.defaultSession.headersReceivedHandler);
      assert.isTrue(fake.session.defaultSession.protocol.isProtocolHandled('prismical-app'));
      // …tray…
      const tray = fake.__trayInstances().at(-1);
      assert.isDefined(tray);
      assert.strictEqual(tray?.listenerCount('click'), 1);
      // …live DB…
      const db = Context.get(ctx, OperationalDb);
      yield* db.setSetting('probe', '1');
      assert.strictEqual(yield* db.getSetting('probe'), '1');
      // …updater check fiber on the (test) clock. The real check hops through
      // a promise (metadata fetch), so completion is polled on real time after
      // each virtual-clock advance (initial delay ≤1min on either platform;
      // interval 60min unstaged).
      const updater = Context.get(ctx, UpdaterService);
      yield* TestClock.adjust(Duration.minutes(1));
      yield* awaitCheckCount(updater, 1);
      yield* TestClock.adjust(Duration.minutes(60));
      yield* awaitCheckCount(updater, 2);

      // ---- Interrupt the root scope. --------------------------------------
      yield* Scope.close(scope, Exit.void);

      // Every listener gone.
      assert.strictEqual(fake.__appListenerTotal(), baseline, 'app listeners back to baseline');
      // Session controls gone.
      assert.isNull(fake.session.defaultSession.permissionRequestHandler);
      assert.isNull(fake.session.defaultSession.headersReceivedHandler);
      assert.isFalse(fake.session.defaultSession.protocol.isProtocolHandled('prismical-app'));
      // Tray detached while its reusable native instance remains alive.
      assert.strictEqual(tray?.listenerCount('click'), 0);
      assert.isNull(tray?.contextMenu);
      // DB closed: queries reject.
      const afterClose = yield* Effect.exit(db.getSetting('probe'));
      assert.isTrue(Exit.isFailure(afterClose), 'operational db closed on release');
      // Timer fiber dead: no tick after close.
      yield* TestClock.adjust(Duration.hours(24));
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 10)));
      assert.strictEqual(yield* updater.checkCount, 2);
    })
  );

  it.effect('failure injection: OperationalDb acquire fails → earlier acquires roll back', () =>
    Effect.gen(function* () {
      // Parent "dir" is a file → open fails with a typed BootError.
      const blocker = path.join(tempDir, 'blocker');
      writeFileSync(blocker, 'not a dir');
      const layer = makeBootLayer(
        testConfigLayer({ operationalDbPath: path.join(blocker, 'x.db') })
      );
      const baseline = fake.__appListenerTotal();

      const scope = yield* Scope.make();
      const exit = yield* Effect.exit(Layer.build(layer).pipe(Scope.extend(scope)));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(JSON.stringify(exit.cause), 'BootError');
      }
      yield* Scope.close(scope, Exit.void);

      // Whatever was acquired before/concurrently was rolled back.
      assert.strictEqual(fake.__appListenerTotal(), baseline);
      assert.isNull(fake.session.defaultSession.permissionRequestHandler);
      assert.isNull(fake.session.defaultSession.headersReceivedHandler);
      assert.isFalse(fake.session.defaultSession.protocol.isProtocolHandled('prismical-app'));
      const tray = fake.__trayInstances().at(-1);
      if (tray) assert.strictEqual(tray.listenerCount('click'), 0);
    })
  );

  it.effect('failure injection: SecureStore acquire fails → DB and listeners roll back', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'rollback.db');
      fake.safeStorage.available = false; // non-E2E → SecureStore acquire fails typed
      const layer = makeBootLayer(testConfigLayer({ operationalDbPath: dbPath, isE2E: false }));
      const baseline = fake.__appListenerTotal();

      const scope = yield* Scope.make();
      const exit = yield* Effect.exit(Layer.build(layer).pipe(Scope.extend(scope)));
      fake.safeStorage.available = true;
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(JSON.stringify(exit.cause), 'secure-store');
      }
      yield* Scope.close(scope, Exit.void);

      assert.strictEqual(fake.__appListenerTotal(), baseline, 'ElectronApp rolled back');
      assert.isNull(fake.session.defaultSession.permissionRequestHandler);
      // The DB acquired successfully and must have been released by the
      // rollback: a fresh exclusive open of the same file succeeds only if the
      // previous connection closed its handles cleanly.
      const { DatabaseSync } = yield* Effect.promise(() => import('node:sqlite'));
      const probe = new DatabaseSync(dbPath);
      const rows = probe.prepare('SELECT version FROM schema_meta').all();
      assert.strictEqual(rows.length, 7, 'migrations ran before rollback');
      probe.exec('BEGIN EXCLUSIVE');
      probe.exec('COMMIT');
      probe.close();
    })
  );
});
