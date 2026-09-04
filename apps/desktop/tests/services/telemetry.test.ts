/**
 * TelemetryService domain tests — the main posthog-node client's
 * logic against a fake sink (no network): the disabled no-op path, device-id
 * mint/persist (incl. DbError fallback), super-properties + distinct-id stamping,
 * identify aliasing the device id + org grouping, reset back to anonymous, the
 * auth-state subscriber driving identify/reset, and flush-on-quit.
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope, SubscriptionRef } from 'effect';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import {
  initialAuthState,
  type AuthAccountView,
  type AuthState,
} from '../../src/main/domains/auth/policy';
import { AppModeService } from '../../src/main/domains/app-mode/service';
import { AuthService, type AuthApi } from '../../src/main/domains/auth/service';
import { makeTelemetryServiceLive } from '../../src/main/domains/telemetry/live';
import { TelemetryService } from '../../src/main/domains/telemetry/service';
import type {
  PostHogSink,
  SinkCapture,
  SinkGroupIdentify,
  SinkIdentify,
} from '../../src/main/domains/telemetry/posthog-sink';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSink extends PostHogSink {
  readonly captures: SinkCapture[];
  readonly identifies: SinkIdentify[];
  readonly groups: SinkGroupIdentify[];
  readonly exceptions: Array<{ error: unknown; distinctId: string; properties?: Record<string, unknown> }>;
  shutdownCalls: number;
}

const makeFakeSink = (): FakeSink => {
  const captures: SinkCapture[] = [];
  const identifies: SinkIdentify[] = [];
  const groups: SinkGroupIdentify[] = [];
  const exceptions: FakeSink['exceptions'] = [];
  const sink: FakeSink = {
    captures,
    identifies,
    groups,
    exceptions,
    shutdownCalls: 0,
    capture: args => captures.push(args),
    identify: args => identifies.push(args),
    groupIdentify: args => groups.push(args),
    captureException: (error, distinctId, properties) =>
      exceptions.push({ error, distinctId, properties }),
    shutdown: () => {
      sink.shutdownCalls += 1;
      return Promise.resolve();
    },
  };
  return sink;
};

const account = (sub: string, activeOrgId?: string): AuthAccountView => ({
  sub,
  email: `${sub}@example.com`,
  ...(activeOrgId === undefined ? {} : { activeOrgId }),
  orgs: [],
});

const authState = (
  gate: AuthState['gate'],
  accounts: ReadonlyArray<AuthAccountView>,
  activeSub?: string
): AuthState => ({
  gate,
  accounts: Object.fromEntries(accounts.map(a => [a.sub, a])),
  ...(activeSub === undefined ? {} : { activeSub }),
});

const authStubBase: Omit<AuthApi, 'sessionState'> = {
  signIn: () => Effect.void,
  signOut: () => Effect.void,
  setActiveAccount: () => Effect.void,
  setActiveOrg: () => Effect.void,
  getIdToken: () => Effect.succeed('idtoken'),
  openWebSession: () => Effect.void,
  consumePendingEntry: () => Effect.succeed('rejected' as const),
  pendingAttemptState: Effect.succeed(null),
  pendingAttemptAuthorizeUrl: Effect.succeed(null),
};

/** Enabled config: a key + host present, not E2E. */
const ENABLED = {
  endpoints: {
    coreApiUrl: 'https://core.test',
    noteWsUrl: 'wss://note.test/collaboration',
    webAppOrigin: 'https://app.test',
    analyticsKey: 'phc_test',
    analyticsHost: 'https://p.test',
  },
};

// Cooperative flush so the forked auth subscriber processes a sessionState set.
const flush: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 6; i++) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
  }
});
const drainUntil = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      yield* flush;
    }
  });

const setup = (opts: {
  seed?: Record<string, string>;
  initial?: AuthState;
  configOverride?: object;
  failGet?: boolean;
  mode?: 'local' | 'cloud';
}) =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const db = makeFakeOperationalDb(opts.seed ?? {});
    if (opts.failGet) db.failGet(true);
    const sink = makeFakeSink();
    const sessionState = yield* SubscriptionRef.make<AuthState>(opts.initial ?? initialAuthState);
    const authApi: AuthApi = { ...authStubBase, sessionState };
    const layer = makeTelemetryServiceLive(() => sink).pipe(
      Layer.provide(testConfigLayer(opts.configOverride ?? ENABLED)),
      Layer.provide(db.layer),
      Layer.provide(logger.layer),
      Layer.provide(Layer.succeed(AuthService, authApi)),
      Layer.provide(Layer.succeed(AppModeService, { mode: opts.mode ?? 'cloud', chosen: true }))
    );
    const scope = yield* Scope.make();
    const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
    const telemetry = Context.get(ctx, TelemetryService);
    return { logger, db, sink, sessionState, telemetry, scope };
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelemetryService', () => {
  it.effect('disabled (no key) ⇒ every method is a no-op; the sink is never opened', () =>
    Effect.gen(function* () {
      const { sink, telemetry, logger, scope } = yield* setup({ configOverride: {} });
      yield* telemetry.capture('app_launch', { foo: 'bar' });
      yield* telemetry.identify({ sub: 'u1' });
      assert.lengthOf(sink.captures, 0);
      assert.lengthOf(sink.identifies, 0);
      assert.isDefined(logger.find(e => e.message === 'telemetry disabled'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('local mode ⇒ inert: no sink, no capture, a restored session is never identified', () =>
    Effect.gen(function* () {
      const restored: AuthState = {
        gate: 'signed-in',
        accounts: {
          user_1: {
            sub: 'user_1',
            email: 'u1@e.com',
            name: 'One',
            activeOrgId: 'org_a',
            orgs: [{ id: 'ou_1', orgId: 'org_a', userId: 'user_1' }],
          },
        },
        activeSub: 'user_1',
      };
      const { sink, telemetry, logger, sessionState, scope } = yield* setup({
        mode: 'local',
        initial: restored,
      });
      yield* telemetry.capture('app_launch');
      yield* SubscriptionRef.set(sessionState, restored);
      assert.lengthOf(sink.captures, 0);
      assert.lengthOf(sink.identifies, 0);
      assert.isDefined(logger.find(e => e.message === 'telemetry disabled'));
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(sink.shutdownCalls, 0);
    })
  );

  it.effect('an unchosen fresh install ⇒ inert until a mode is picked', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const db = makeFakeOperationalDb({});
      const sink = makeFakeSink();
      const sessionState = yield* SubscriptionRef.make<AuthState>(initialAuthState);
      const layer = makeTelemetryServiceLive(() => sink).pipe(
        Layer.provide(testConfigLayer(ENABLED)),
        Layer.provide(db.layer),
        Layer.provide(logger.layer),
        Layer.provide(Layer.succeed(AuthService, { ...authStubBase, sessionState })),
        Layer.provide(Layer.succeed(AppModeService, { mode: 'cloud', chosen: false }))
      );
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Context.get(ctx, TelemetryService).capture('app_launch');
      assert.lengthOf(sink.captures, 0);
      assert.isUndefined(db.store.get('telemetry:deviceId'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('mints + persists a device id and stamps it + super-properties on capture', () =>
    Effect.gen(function* () {
      const { sink, db, telemetry, scope } = yield* setup({});
      yield* telemetry.capture('app_launch', { foo: 'bar' });

      const deviceId = db.store.get('telemetry:deviceId');
      assert.isString(deviceId);
      assert.lengthOf(sink.captures, 1);
      const [c] = sink.captures;
      assert.strictEqual(c.event, 'app_launch');
      assert.strictEqual(c.distinctId, deviceId);
      // Super-properties + the event's own property, all present.
      assert.strictEqual(c.properties?.platform, process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform);
      assert.strictEqual(c.properties?.app_version, '0.0.0-test');
      assert.strictEqual(c.properties?.app_is_packaged, false);
      assert.strictEqual(c.properties?.arch, process.arch);
      assert.strictEqual(c.properties?.foo, 'bar');
      assert.isUndefined(c.groups); // anonymous ⇒ no org group
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('reuses an existing persisted device id', () =>
    Effect.gen(function* () {
      const { sink, telemetry, scope } = yield* setup({
        seed: { 'telemetry:deviceId': 'device-abc' },
      });
      yield* telemetry.capture('app_launch');
      assert.strictEqual(sink.captures[0]?.distinctId, 'device-abc');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a DbError minting the device id never blocks boot (ephemeral id is used)', () =>
    Effect.gen(function* () {
      const { sink, telemetry, logger, scope } = yield* setup({ failGet: true });
      yield* telemetry.capture('app_launch');
      // Still captured, under a non-empty ephemeral id.
      assert.lengthOf(sink.captures, 1);
      assert.isNotEmpty(sink.captures[0]?.distinctId ?? '');
      assert.isDefined(logger.find(e => e.message === 'device id read/write failed — using an ephemeral id'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('identify sets the sub + person props, groups the org, and re-keys captures to the sub', () =>
    Effect.gen(function* () {
      const { sink, telemetry, scope } = yield* setup({});
      // Establish the device id first (an anonymous capture).
      yield* telemetry.capture('before');

      yield* telemetry.identify({ sub: 'user_1', email: 'u1@e.com', name: 'One', orgId: 'org_a' });
      assert.lengthOf(sink.identifies, 1);
      const [id] = sink.identifies;
      assert.strictEqual(id.distinctId, 'user_1');
      // No $anon_distinct_id: the device id is never merged into a user (a shared
      // device would otherwise bleed one user's identity onto the next).
      assert.isUndefined(id.properties?.$anon_distinct_id);
      assert.strictEqual(id.properties?.email, 'u1@e.com');
      assert.strictEqual(id.properties?.name, 'One');
      assert.deepStrictEqual(sink.groups[0], { groupType: 'organization', groupKey: 'org_a' });

      // Subsequent captures ride the sub + org group.
      yield* telemetry.capture('after');
      const last = sink.captures.at(-1);
      assert.strictEqual(last?.distinctId, 'user_1');
      assert.deepStrictEqual(last?.groups, { organization: 'org_a' });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('reset returns captures to the anonymous device id (no org group)', () =>
    Effect.gen(function* () {
      const { sink, db, telemetry, scope } = yield* setup({});
      yield* telemetry.capture('seed');
      const deviceId = db.store.get('telemetry:deviceId');
      yield* telemetry.identify({ sub: 'user_1', orgId: 'org_a' });
      yield* telemetry.reset;
      yield* telemetry.capture('after-reset');
      const last = sink.captures.at(-1);
      assert.strictEqual(last?.distinctId, deviceId);
      assert.isUndefined(last?.groups);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('the auth subscriber identifies on sign-in and resets on sign-out', () =>
    Effect.gen(function* () {
      const { sink, db, telemetry, sessionState, scope } = yield* setup({});
      // Establish the device id.
      yield* telemetry.capture('boot');
      const deviceId = db.store.get('telemetry:deviceId');

      // Sign in → the subscriber identifies.
      yield* SubscriptionRef.set(sessionState, authState('signed-in', [account('user_1', 'org_a')], 'user_1'));
      yield* drainUntil(() => sink.identifies.length >= 1);
      assert.strictEqual(sink.identifies.at(-1)?.distinctId, 'user_1');

      // Sign out → reset: a fresh capture rides the device id again.
      yield* SubscriptionRef.set(sessionState, authState('signed-out', []));
      yield* flush;
      yield* telemetry.capture('after-logout');
      assert.strictEqual(sink.captures.at(-1)?.distinctId, deviceId);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a restored (already signed-in) session identifies at boot', () =>
    Effect.gen(function* () {
      const { sink, scope } = yield* setup({
        initial: authState('refreshing', [account('user_1')], 'user_1'),
      });
      yield* drainUntil(() => sink.identifies.length >= 1);
      assert.strictEqual(sink.identifies.at(-1)?.distinctId, 'user_1');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('captureException carries the current distinct-id + super-properties', () =>
    Effect.gen(function* () {
      const { sink, db, telemetry, scope } = yield* setup({});
      yield* telemetry.capture('seed');
      const deviceId = db.store.get('telemetry:deviceId');
      const error = new Error('boom');
      yield* telemetry.captureException(error, { where: 'test' });
      assert.lengthOf(sink.exceptions, 1);
      assert.strictEqual(sink.exceptions[0]?.error, error);
      assert.strictEqual(sink.exceptions[0]?.distinctId, deviceId);
      assert.strictEqual(sink.exceptions[0]?.properties?.where, 'test');
      assert.strictEqual(sink.exceptions[0]?.properties?.app_version, '0.0.0-test');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('flushes the sink on scope close (quit)', () =>
    Effect.gen(function* () {
      const { sink, logger, scope } = yield* setup({});
      assert.strictEqual(sink.shutdownCalls, 0);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(sink.shutdownCalls, 1);
      assert.isDefined(logger.find(e => e.message === 'telemetry client shut down'));
    })
  );
});
