/**
 * AppModeService boot resolution: the mode is read once
 * from the operational KV row `app:mode`, defaults to 'cloud' on every
 * missing/malformed/unreadable outcome, and never blocks boot.
 */
import { assert, describe, it } from '@effect/vitest';
import { Effect, SubscriptionRef } from 'effect';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { makeTestLogger } from '../helpers/test-layers';
import { APP_MODE_KEY, AppModeLive } from '../../src/main/domains/app-mode/live';
import { AppModeService } from '../../src/main/domains/app-mode/service';
import { ACCOUNT_INDEX_KEY } from '../../src/main/domains/auth/live';
import { encodeAccountIndex } from '../../src/main/domains/auth/policy';

describe('AppModeService', () => {
  const setup = (seed: Record<string, string> = {}, failGet = false) => {
    const logger = makeTestLogger();
    const db = makeFakeOperationalDb(seed);
    db.failGet(failGet);
    const program = Effect.gen(function* () {
      const { mode } = yield* AppModeService;
      return mode;
    }).pipe(Effect.provide(AppModeLive), Effect.provide(db.layer), Effect.provide(logger.layer));
    const full = Effect.gen(function* () {
      const { mode, chosenState } = yield* AppModeService;
      return { mode, chosen: yield* SubscriptionRef.get(chosenState) };
    }).pipe(Effect.provide(AppModeLive), Effect.provide(db.layer), Effect.provide(logger.layer));
    return { program, full, logger, db };
  };

  it.effect('no persisted row ⇒ cloud, not chosen (the first-run chooser keys on this)', () =>
    Effect.gen(function* () {
      const { program, full, db } = setup();
      assert.strictEqual(yield* program, 'cloud');
      assert.deepStrictEqual(yield* full, { mode: 'cloud', chosen: false });
      // Nothing is written by a fresh, undecided boot.
      assert.isUndefined(db.store.get(APP_MODE_KEY));
    })
  );

  it.effect('a persisted row ⇒ chosen', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* setup({ [APP_MODE_KEY]: 'local' }).full, {
        mode: 'local',
        chosen: true,
      });
      assert.deepStrictEqual(yield* setup({ [APP_MODE_KEY]: 'cloud' }).full, {
        mode: 'cloud',
        chosen: true,
      });
    })
  );

  it.effect('a signed-in roster with no row is an upgraded cloud install: chosen, and the row is self-healed', () =>
    Effect.gen(function* () {
      const index = encodeAccountIndex({
        gate: 'signed-in',
        accounts: {
          user_1: {
            sub: 'user_1',
            email: 'u1@example.com',
            activeOrgId: 'org_1',
            orgs: [{ id: 'ou_1', orgId: 'org_1', userId: 'user_1' }],
          },
        },
        activeSub: 'user_1',
      });
      const { full, db, logger } = setup({ [ACCOUNT_INDEX_KEY]: index });
      assert.deepStrictEqual(yield* full, { mode: 'cloud', chosen: true });
      assert.strictEqual(db.store.get(APP_MODE_KEY), 'cloud');
      assert.isDefined(logger.find(e => e.message === 'app mode resolved'));
    })
  );

  it.effect('an empty or corrupt roster does not count as chosen', () =>
    Effect.gen(function* () {
      const empty = encodeAccountIndex({ gate: 'signed-out', accounts: {} });
      assert.deepStrictEqual(yield* setup({ [ACCOUNT_INDEX_KEY]: empty }).full, {
        mode: 'cloud',
        chosen: false,
      });
      assert.deepStrictEqual(yield* setup({ [ACCOUNT_INDEX_KEY]: '{not json' }).full, {
        mode: 'cloud',
        chosen: false,
      });
    })
  );

  it.effect("persisted 'local' ⇒ local", () =>
    Effect.gen(function* () {
      const { program } = setup({ [APP_MODE_KEY]: 'local' });
      assert.strictEqual(yield* program, 'local');
    })
  );

  it.effect("persisted 'cloud' ⇒ cloud", () =>
    Effect.gen(function* () {
      const { program } = setup({ [APP_MODE_KEY]: 'cloud' });
      assert.strictEqual(yield* program, 'cloud');
    })
  );

  it.effect('a malformed row falls back to cloud, not chosen', () =>
    Effect.gen(function* () {
      for (const bad of ['LOCAL', 'Local ', '"local"', 'offline', '']) {
        const { program, full } = setup({ [APP_MODE_KEY]: bad });
        assert.strictEqual(yield* program, 'cloud', `malformed value ${JSON.stringify(bad)}`);
        assert.deepStrictEqual(yield* full, { mode: 'cloud', chosen: false });
      }
    })
  );

  it.effect('a DbError on the boot read defaults to cloud and never fails the layer', () =>
    Effect.gen(function* () {
      const { program, logger } = setup({ [APP_MODE_KEY]: 'local' }, true);
      assert.strictEqual(yield* program, 'cloud');
      assert.isDefined(
        logger.find(e => e.message === 'app-mode read failed at boot — defaulting to cloud')
      );
    })
  );
});
