/**
 * PendingResetLive — the boot-time half of the destructive
 * reset: applies the marker the reset handler wrote (paths + local_model
 * rows), keeps it when incomplete, and blocks boot if device cleanup cannot run.
 */
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer } from 'effect';
import { DbError, OperationalDb } from '../../src/main/infra/operational-db/service';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { makeTestLogger } from '../helpers/test-layers';
import { PendingResetLive } from '../../src/main/infra/pending-reset/live';
import {
  MAX_PURGE_ATTEMPTS,
  PENDING_PURGE_KEY,
  PendingReset,
  encodePendingPurge,
} from '../../src/main/infra/pending-reset/service';
import type { LocalModelRow } from '../../src/main/infra/operational-db/service';

const row = (modelId: string): LocalModelRow => ({
  modelId,
  filename: `${modelId}.bin`,
  path: `/fake/${modelId}.bin`,
  sizeBytes: 1,
  checksum: 'x',
  downloadedAt: '2026-01-01T00:00:00.000Z',
  verifiedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const build = (seed: Record<string, string>, localModels?: ReadonlyArray<LocalModelRow>) =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const db = makeFakeOperationalDb(seed, localModels === undefined ? {} : { localModels });
    const layer = PendingResetLive.pipe(Layer.provide(db.layer), Layer.provide(logger.layer));
    const ctx = yield* Layer.build(layer);
    return { logger, db, api: Context.get(ctx, PendingReset) };
  }).pipe(Effect.scoped);

describe('PendingResetLive boot-time purge', () => {
  it.effect('finishes interrupted reset and removes credentials and settings written during shutdown', () =>
    Effect.gen(function* () {
      const { db } = yield* build({
        [PENDING_PURGE_KEY]: encodePendingPurge({
          v: 1, paths: [], localModels: true,
          settings: { 'telemetry:deviceId': 'fresh-device' },
        }),
        'auth.accounts': 'late-oauth-account',
        'secure:auth.refreshToken.late': 'late-oauth-token',
        'pref:launchAtLogin': 'true',
        'app:mode': 'local',
        'legacy.setting': 'old',
      }, [row('m1')]);

      assert.deepStrictEqual(Object.fromEntries(db.store), { 'telemetry:deviceId': 'fresh-device' });
      assert.strictEqual(db.localModels.size, 0);
    })
  );

  it.effect('a failed device wipe stops boot and retains the reset marker for retry', () =>
    Effect.gen(function* () {
      const marker = encodePendingPurge({ v: 1, paths: [], localModels: false, settings: {} });
      const db = makeFakeOperationalDb({ [PENDING_PURGE_KEY]: marker, 'auth.accounts': 'old' });
      const failingDb = Layer.effect(OperationalDb, Effect.map(OperationalDb, service => ({
        ...service,
        resetDeviceState: () => Effect.fail(new DbError({ op: 'resetDeviceState', cause: 'disk unavailable' })),
      }))).pipe(Layer.provide(db.layer));
      const result = yield* Effect.exit(Layer.build(PendingResetLive.pipe(
        Layer.provide(failingDb), Layer.provide(makeTestLogger().layer)
      )));

      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.include(JSON.stringify(result.cause), 'BootError');
      assert.strictEqual(db.store.get(PENDING_PURGE_KEY), marker);
    }).pipe(Effect.scoped)
  );

  it.effect('no marker ⇒ nothing applied, no rows touched', () =>
    Effect.gen(function* () {
      const { api, db } = yield* build({}, [row('m1')]);
      assert.isNull(api.applied);
      assert.strictEqual(db.localModels.size, 1);
    })
  );

  it.effect('applies the marker: trees + .db siblings removed, local_model rows dropped, marker cleared', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(path.join(tmpdir(), 'prismical-purge-'));
      const localDb = path.join(root, 'local.db');
      const cloudCache = path.join(root, 'cloud-cache');
      const models = path.join(root, 'models');
      const recovery = path.join(root, 'recovery');
      const missing = path.join(root, 'never-existed');
      writeFileSync(localDb, 'db');
      // The SQLite WAL/SHM siblings a hard-killed run leaves behind — a stale
      // -wal beside a fresh DB would replay the OLD database into the new one.
      writeFileSync(`${localDb}-wal`, 'wal');
      writeFileSync(`${localDb}-shm`, 'shm');
      mkdirSync(path.join(cloudCache, 'nested'), { recursive: true });
      writeFileSync(path.join(cloudCache, 'nested', 'a.db'), 'x');
      mkdirSync(models, { recursive: true });
      writeFileSync(path.join(models, 'w.bin'), 'weights');
      mkdirSync(recovery, { recursive: true });
      const survivor = path.join(root, 'operational.db');
      writeFileSync(survivor, 'keep');

      const marker = encodePendingPurge({
        v: 1,
        paths: [localDb, cloudCache, models, recovery, missing],
        localModels: true,
      });
      const { api, db, logger } = yield* build({ [PENDING_PURGE_KEY]: marker }, [
        row('m1'),
        row('m2'),
      ]);

      assert.deepStrictEqual(api.applied, {
        removed: [localDb, cloudCache, models, recovery, missing],
        failed: [],
        localModelsCleared: true,
      });
      for (const gone of [localDb, `${localDb}-wal`, `${localDb}-shm`, cloudCache, models, recovery]) {
        assert.isFalse(existsSync(gone), gone);
      }
      // Never touched: anything not in the marker.
      assert.isTrue(existsSync(survivor));
      assert.strictEqual(db.localModels.size, 0);
      assert.isUndefined(db.store.get(PENDING_PURGE_KEY));
      assert.isTrue(logger.entries.some(entry => entry.message === 'pending purge applied'));
    })
  );

  it.effect('a malformed marker is dropped (never re-applied, never a boot failure)', () =>
    Effect.gen(function* () {
      const { api, db } = yield* build({ [PENDING_PURGE_KEY]: '{"v":2,"paths":"nope"}' }, [row('m1')]);
      assert.isNull(api.applied);
      assert.isUndefined(db.store.get(PENDING_PURGE_KEY));
      assert.strictEqual(db.localModels.size, 1);
    })
  );

  it.effect('an unreadable marker stops boot so account restoration cannot bypass reset', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const db = makeFakeOperationalDb({ [PENDING_PURGE_KEY]: encodePendingPurge({ v: 1, paths: [], localModels: false }) });
      db.failGet(true);
      const layer = PendingResetLive.pipe(Layer.provide(db.layer), Layer.provide(logger.layer));
      const result = yield* Effect.exit(Layer.build(layer));
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.include(JSON.stringify(result.cause), 'BootError');
      // Kept: the next boot retries.
      assert.isString(db.store.get(PENDING_PURGE_KEY));
    }).pipe(Effect.scoped)
  );

  it.effect('an incomplete purge re-arms ONLY the outstanding work, with an attempt count', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(path.join(tmpdir(), 'prismical-purge-'));
      const target = path.join(root, 'models');
      mkdirSync(target);
      const marker = encodePendingPurge({ v: 1, paths: [target], localModels: true, settings: { 'app:mode': 'local' } });
      const logger = makeTestLogger();
      const db = makeFakeOperationalDb({ [PENDING_PURGE_KEY]: marker }, { localModels: [row('m1')] });
      // The row clear fails as a typed DbError (the real store's failure shape).
      const failingDb = Layer.effect(
        OperationalDb,
        Effect.map(OperationalDb, service => ({
          ...service,
          deleteAllLocalModels: () =>
            Effect.fail(new DbError({ op: 'deleteAllLocalModels', cause: 'injected' })),
        }))
      ).pipe(Layer.provide(db.layer));
      const layer = PendingResetLive.pipe(Layer.provide(failingDb), Layer.provide(logger.layer));
      const ctx = yield* Layer.build(layer);
      const api = Context.get(ctx, PendingReset);
      // The files went; the rows did not. The re-armed marker names NO path
      // (the removed one must never be deleted again — the user's rebuilt
      // workspace would sit there by the next boot), only the rows, once more.
      assert.isFalse(existsSync(target));
      assert.deepStrictEqual(api.applied, { removed: [target], failed: [], localModelsCleared: false });
      assert.deepStrictEqual(JSON.parse(db.store.get(PENDING_PURGE_KEY)!), {
        v: 1,
        paths: [],
        localModels: true,
        attempts: 1,
      });
      // Device cleanup completed. Retrying the files/model rows must not wipe
      // a new session or preferences created after this boot.
      assert.strictEqual(db.store.get('app:mode'), 'local');
      db.store.set('pref:language', '"en"');
      yield* Layer.build(PendingResetLive.pipe(
        Layer.provide(failingDb), Layer.provide(logger.layer)
      ));
      assert.strictEqual(db.store.get('pref:language'), '"en"');
      assert.isTrue(
        logger.entries.some(
          entry => entry.message === 'pending purge incomplete — outstanding work re-armed for the next boot'
        )
      );
    }).pipe(Effect.scoped)
  );

  it.effect('the retry budget is bounded: the marker is dropped after MAX_PURGE_ATTEMPTS boots', () =>
    Effect.gen(function* () {
      const marker = encodePendingPurge({
        v: 1,
        paths: [],
        localModels: true,
        attempts: MAX_PURGE_ATTEMPTS - 1,
      });
      const logger = makeTestLogger();
      const db = makeFakeOperationalDb({ [PENDING_PURGE_KEY]: marker }, { localModels: [row('m1')] });
      const failingDb = Layer.effect(
        OperationalDb,
        Effect.map(OperationalDb, service => ({
          ...service,
          deleteAllLocalModels: () =>
            Effect.fail(new DbError({ op: 'deleteAllLocalModels', cause: 'injected' })),
        }))
      ).pipe(Layer.provide(db.layer));
      const layer = PendingResetLive.pipe(Layer.provide(failingDb), Layer.provide(logger.layer));
      yield* Layer.build(layer);
      // Still incomplete, but out of budget: dropped, loudly — never a boot-time wipe forever.
      assert.isUndefined(db.store.get(PENDING_PURGE_KEY));
      assert.isTrue(
        logger.entries.some(
          entry => entry.message === 'pending purge abandoned — still incomplete after the retry budget'
        )
      );
    }).pipe(Effect.scoped)
  );

  it.effect('a legacy marker without an attempt count parses as attempt 0', () =>
    Effect.gen(function* () {
      const { api, db } = yield* build(
        { [PENDING_PURGE_KEY]: JSON.stringify({ v: 1, paths: [], localModels: false }) },
        []
      );
      assert.deepStrictEqual(api.applied, { removed: [], failed: [], localModelsCleared: false });
      assert.isUndefined(db.store.get(PENDING_PURGE_KEY));
    })
  );
});
