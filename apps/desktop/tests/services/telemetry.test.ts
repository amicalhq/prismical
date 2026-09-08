import { assert, describe, it } from '@effect/vitest';
import { DEFAULT_DEVICE_SETTINGS } from '@prismical/desktop-contracts';
import { Context, Effect, Exit, Fiber, Layer, Scope, SubscriptionRef, TestClock } from 'effect';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { initialAuthState, type AuthState } from '../../src/main/domains/auth/policy';
import { AppModeService, makeAppMode } from '../../src/main/domains/app-mode/service';
import { AuthService, type AuthApi } from '../../src/main/domains/auth/service';
import { SettingsService } from '../../src/main/domains/settings/service';
import { makeTelemetryServiceLive } from '../../src/main/domains/telemetry/live';
import { DEVICE_ID_KEY, TelemetryService } from '../../src/main/domains/telemetry/service';
import type {
  PostHogSink,
  SinkCapture,
  SinkIdentify,
} from '../../src/main/domains/telemetry/posthog-sink';

const signedIn = (sub = 'user_1', orgId?: string): AuthState => ({
  gate: 'signed-in',
  activeSub: sub,
  accounts: {
    [sub]: { sub, email: `${sub}@example.com`, orgs: [], ...(orgId ? { activeOrgId: orgId } : {}) },
  },
});
const authStub: Omit<AuthApi, 'sessionState'> = {
  signIn: () => Effect.void,
  signOut: () => Effect.void,
  setActiveAccount: () => Effect.void,
  setActiveOrg: () => Effect.void,
  getIdToken: () => Effect.succeed('test-token'),
  openWebSession: () => Effect.void,
  consumePendingEntry: () => Effect.succeed('rejected' as const),
  pendingAttemptState: Effect.succeed(null),
  pendingAttemptAuthorizeUrl: Effect.succeed(null),
};
const enabledConfig = {
  endpoints: {
    coreApiUrl: 'https://core.test',
    noteWsUrl: 'wss://note.test',
    webAppOrigin: 'https://app.test',
    analyticsKey: 'phc_test',
    analyticsHost: 'https://telemetry.test',
  },
};
interface FakeSink extends PostHogSink {
  captures: SinkCapture[];
  identifies: SinkIdentify[];
  exceptions: Array<{ error: unknown; distinctId: string; properties?: Record<string, unknown> }>;
  discarded: boolean;
  shutdownCalls: number;
  isAllowed: () => boolean;
}
const setup = (
  options: {
    initial?: AuthState;
    preference?: boolean;
    mode?: 'cloud' | 'local';
    chosen?: boolean;
    config?: object;
    machineId?: () => Promise<string>;
    seed?: Record<string, string>;
    failDb?: boolean;
    throwSink?: boolean;
    shutdown?: () => Promise<void>;
  } = {}
) =>
  Effect.gen(function* () {
    const db = makeFakeOperationalDb(options.seed);
    if (options.failDb) db.failGet(true);
    const logger = makeTestLogger();
    const sessionState = yield* SubscriptionRef.make(options.initial ?? initialAuthState);
    const appMode = yield* makeAppMode(options.mode ?? 'cloud', options.chosen ?? true);
    const settings = yield* SubscriptionRef.make({
      ...DEFAULT_DEVICE_SETTINGS,
      telemetryOptOut: !(options.preference ?? false),
    });
    const sinks: FakeSink[] = [];
    let machineReads = 0;
    const layer = makeTelemetryServiceLive(
      (_key, _host, isAllowed) => {
        if (options.throwSink) throw new Error('SDK unavailable');
        const sink: FakeSink = {
          captures: [],
          identifies: [],
          exceptions: [],
          discarded: false,
          shutdownCalls: 0,
          isAllowed,
          capture: event => {
            sink.captures.push(event);
          },
          identify: event => {
            sink.identifies.push(event);
          },
          captureException: (error, distinctId, properties) => {
            sink.exceptions.push({ error, distinctId, properties });
          },
          discard: () => {
            sink.discarded = true;
          },
          shutdown: () => {
            sink.shutdownCalls++;
            return options.shutdown?.() ?? Promise.resolve();
          },
        };
        sinks.push(sink);
        return sink;
      },
      () => {
        machineReads++;
        return options.machineId ? options.machineId() : Promise.resolve('hashed-machine-id');
      }
    ).pipe(
      Layer.provide(testConfigLayer(options.config ?? enabledConfig)),
      Layer.provide(db.layer),
      Layer.provide(logger.layer),
      Layer.provide(Layer.succeed(AuthService, { ...authStub, sessionState })),
      Layer.provide(Layer.succeed(AppModeService, appMode)),
      Layer.provide(
        Layer.succeed(SettingsService, {
          settings,
          get: SubscriptionRef.get(settings),
          set: patch => SubscriptionRef.update(settings, current => ({ ...current, ...patch })),
          reset: Effect.void,
        })
      )
    );
    const telemetry = Context.get(yield* Layer.build(layer), TelemetryService);
    const setPreference = (value: boolean) =>
      SubscriptionRef.update(settings, current => ({ ...current, telemetryOptOut: !value }));
    return {
      telemetry,
      sinks,
      db,
      logger,
      sessionState,
      settings,
      setPreference,
      appMode,
      get machineReads() {
        return machineReads;
      },
    };
  });

describe('TelemetryService policy and identity', () => {
  it.effect('fresh signed-out state constructs no SDK and drops events', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks } = yield* setup();
        yield* telemetry.capture('app_launch');
        yield* telemetry.captureException(new Error('secret'));
        assert.deepEqual(yield* telemetry.getState, {
          available: true,
          enabled: false,
          signedIn: false,
          preference: false,
          canChangePreference: true,
          revision: 0,
        });
        assert.lengthOf(sinks, 0);
      })
    )
  );
  it.effect(
    'choosing default cloud mode exposes anonymous preference then enables login without restart',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup({ chosen: false });
          const before = yield* f.telemetry.getState;
          assert.isFalse(before.available);
          assert.equal(f.machineReads, 0);
          // The mode owner publishes this only after the durable choice succeeds.
          yield* SubscriptionRef.set(f.appMode.chosenState, true);
          const chosen = yield* f.telemetry.getState;
          assert.isTrue(chosen.available);
          assert.isTrue(chosen.canChangePreference);
          assert.isFalse(chosen.enabled);
          assert.isAbove(chosen.revision, before.revision);
          assert.equal(f.machineReads, 0);
          yield* SubscriptionRef.set(f.sessionState, signedIn('first-session'));
          yield* f.telemetry.capture('user_signed_in');
          assert.equal(f.machineReads, 1);
          assert.equal(f.sinks[0]!.captures[0]!.distinctId, 'first-session');
        })
      )
  );
  it.effect(
    'choice transitions update subscribed authority for restored authentication; unchanged choice stays silent',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup({ chosen: false, initial: signedIn() });
          const before = yield* f.telemetry.getState;
          yield* f.telemetry.capture('before_choice');
          yield* SubscriptionRef.set(f.appMode.chosenState, false);
          for (let i = 0; i < 10; i++) yield* Effect.yieldNow();
          assert.lengthOf(f.sinks, 0);
          assert.equal(f.machineReads, 0);
          yield* SubscriptionRef.set(f.appMode.chosenState, true);
          for (let i = 0; i < 10; i++) yield* Effect.yieldNow();
          const state = yield* f.telemetry.getState;
          assert.isTrue(state.enabled);
          assert.isTrue(state.signedIn);
          assert.isFalse(state.canChangePreference);
          assert.isAbove(state.revision, before.revision);
          assert.equal((yield* SubscriptionRef.get(f.telemetry.state)).revision, state.revision);
          yield* f.telemetry.capture('stale_choice', {}, 'renderer', before.revision);
          yield* f.telemetry.capture('after_choice', {}, 'renderer', state.revision);
          assert.deepEqual(
            f.sinks.flatMap(sink => sink.captures).map(event => event.event),
            ['after_choice']
          );
          assert.equal(f.machineReads, 1);
        })
      )
  );
  for (const options of [
    { config: {} },
    { config: { ...enabledConfig, isE2E: true } },
    { chosen: false },
  ]) {
    it.effect(`hard capability gate wins: ${JSON.stringify(options)}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { telemetry, sinks, machineReads } = yield* setup({
            ...options,
            initial: signedIn(),
            preference: true,
          });
          yield* telemetry.capture('app_launch');
          assert.isFalse((yield* telemetry.getState).enabled);
          assert.isFalse((yield* telemetry.getState).available);
          assert.lengthOf(sinks, 0);
          assert.equal(machineReads, 0);
        })
      )
    );
  }
  it.effect(
    'login enables before first event; logout restores saved OFF and invalidates pending work',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { telemetry, sinks, sessionState, settings } = yield* setup();
          yield* telemetry.capture('dropped');
          yield* SubscriptionRef.set(sessionState, signedIn('user_a', 'org_a'));
          yield* telemetry.capture('recording_completed');
          assert.equal(sinks[0]!.captures[0]!.distinctId, 'user_a');
          assert.deepEqual(sinks[0]!.captures[0]!.groups, { organization: 'org_a' });
          assert.isTrue((yield* SubscriptionRef.get(settings)).telemetryOptOut);
          assert.isFalse((yield* telemetry.getState).canChangePreference);
          yield* SubscriptionRef.set(sessionState, initialAuthState);
          // Transport gate reads authority even before its subscription fiber runs.
          assert.isFalse(sinks[0]!.isAllowed());
          yield* telemetry.capture('dropped_after_logout');
          assert.isTrue(sinks[0]!.discarded);
          assert.lengthOf(sinks[0]!.captures, 1);
          assert.isFalse((yield* telemetry.getState).enabled);
        })
      )
  );
  it.effect('local opt-in uses machine ID and ignores restored cloud/synthetic accounts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks, setPreference } = yield* setup({
          mode: 'local',
          initial: signedIn('local-user'),
        });
        assert.isFalse((yield* telemetry.getState).signedIn);
        yield* setPreference(true);
        yield* telemetry.capture('app_launch');
        assert.equal(sinks[0]!.captures[0]!.distinctId, 'hashed-machine-id');
        assert.lengthOf(sinks[0]!.identifies, 0);
        assert.isFalse(sinks[0]!.captures[0]!.properties?.$process_person_profile);
      })
    )
  );
  it.effect('restored authentication enables capture despite saved opt-out', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks } = yield* setup({ initial: signedIn() });
        yield* telemetry.capture('app_launch');
        assert.equal(sinks[0]!.captures[0]!.distinctId, 'user_1');
        assert.isUndefined(sinks[0]!.identifies[0]!.properties?.$anon_distinct_id);
        assert.isUndefined(sinks[0]!.identifies[0]!.properties?.email);
      })
    )
  );
  it.effect('account and organization switches discard old queues and clear groups', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks, sessionState } = yield* setup({
          initial: signedIn('a', 'org_a'),
        });
        yield* telemetry.capture('note_created');
        yield* SubscriptionRef.set(sessionState, signedIn('b'));
        yield* telemetry.captureException(
          new Error('private'),
          { source: 'renderer' },
          'renderer',
          (yield* telemetry.getState).revision
        );
        assert.isTrue(sinks[0]!.discarded);
        assert.isFalse(sinks[0]!.isAllowed());
        assert.equal(sinks[1]!.exceptions[0]!.distinctId, 'b');
        assert.isUndefined(sinks[1]!.exceptions[0]!.properties?.$groups);
        assert.equal(sinks[1]!.exceptions[0]!.properties?.runtime, 'renderer');
      })
    )
  );
  it.effect('signed-out opt-in survives login/logout without aliasing into accounts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks, sessionState } = yield* setup({ preference: true });
        yield* telemetry.capture('app_launch');
        yield* SubscriptionRef.set(sessionState, signedIn());
        yield* telemetry.capture('user_signed_in');
        yield* SubscriptionRef.set(sessionState, initialAuthState);
        yield* telemetry.capture('note_created');
        assert.equal(sinks[2]!.captures[0]!.distinctId, 'hashed-machine-id');
        assert.isTrue((yield* telemetry.getState).preference);
      })
    )
  );
  it.effect('SDK construction and capture defects cannot fail a product operation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const disabledSdk = yield* setup({ initial: signedIn(), throwSink: true });
        yield* disabledSdk.telemetry.capture('app_launch');
        const { telemetry, sinks } = yield* setup({ initial: signedIn() });
        sinks[0]!.capture = () => {
          throw new Error('SDK defect');
        };
        yield* telemetry.capture('app_launch');
      })
    )
  );
  it.effect('safe context wins, errors are projected, and exception groups are retained', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks } = yield* setup({ initial: signedIn('a', 'org') });
        yield* telemetry.capture('note_created', {
          runtime: 'worker',
          app_version: 'spoof',
          note_id: 'note_123',
          token: 'secret',
        });
        yield* telemetry.captureException(
          Object.assign(new TypeError('token=private'), {
            code: 'ENOENT',
            reason: 'model-missing',
          }),
          { source: 'preload', error_code: 'EACCES', reason: 'timeout' }
        );
        const event = sinks[0]!.captures[0]!;
        assert.equal(event.properties?.runtime, 'main');
        assert.notEqual(event.properties?.app_version, 'spoof');
        assert.isUndefined(event.properties?.token);
        assert.equal(event.properties?.note_id, 'note_123');
        assert.equal((sinks[0]!.exceptions[0]!.error as Error).message, 'TypeError captured');
        assert.deepEqual(sinks[0]!.exceptions[0]!.properties?.$groups, { organization: 'org' });
        assert.equal(sinks[0]!.exceptions[0]!.properties?.error_code, 'ENOENT');
        assert.equal(sinks[0]!.exceptions[0]!.properties?.reason, 'model-missing');
      })
    )
  );
  it.effect(
    'deduplicates incident identity separately from repeat suppression and reports dropped counts',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { telemetry, sinks, logger } = yield* setup({ initial: signedIn() });
          const sameIncident = new Error('incident');
          yield* telemetry.captureException(sameIncident);
          yield* telemetry.captureException(sameIncident);
          assert.lengthOf(sinks[0]!.exceptions, 1);
          for (let i = 0; i < 4; i++) {
            const nextIncident = new Error('incident');
            nextIncident.stack = sameIncident.stack;
            yield* telemetry.captureException(nextIncident);
          }
          assert.lengthOf(sinks[0]!.exceptions, 3);
          yield* TestClock.adjust('1 second');
          assert.include(
            logger.find(entry => entry.message === 'Telemetry exception reports suppressed')?.data,
            { count: 2 }
          );
        })
      )
  );
  it.effect('product outcomes are not rate limited', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks } = yield* setup({ initial: signedIn() });
        for (let i = 0; i < 30; i++) yield* telemetry.capture('recording_completed');
        assert.lengthOf(sinks[0]!.captures, 30);
      })
    )
  );
  it.effect('a rapid opt-out and opt-in permanently discards the earlier queue', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks, setPreference } = yield* setup({ preference: true });
        yield* telemetry.capture('before_opt_out');
        const original = sinks[0]!;
        yield* Effect.sync(() => {
          Effect.runSync(setPreference(false));
          Effect.runSync(setPreference(true));
        });
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow();
        assert.isTrue(original.discarded);
        yield* telemetry.capture('after_opt_in');
        assert.lengthOf(original.captures, 1);
        assert.equal(sinks.at(-1)!.captures.at(-1)!.event, 'after_opt_in');
      })
    )
  );
  it.effect('returning to the same account still invalidates the pre-switch queue', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks, sessionState } = yield* setup({ initial: signedIn('a') });
        yield* telemetry.capture('before_switch');
        const original = sinks[0]!;
        yield* Effect.sync(() => {
          Effect.runSync(SubscriptionRef.set(sessionState, signedIn('b')));
          Effect.runSync(SubscriptionRef.set(sessionState, signedIn('a')));
        });
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow();
        assert.isTrue(original.discarded);
        assert.isTrue(
          sinks.every(sink => sink.identifies.every(event => event.distinctId === 'a'))
        );
        yield* telemetry.capture('after_switch');
        assert.lengthOf(original.captures, 1);
      })
    )
  );
  it.effect('unrelated settings changes and display-claim refreshes retain queued events', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sinks, sessionState, settings } = yield* setup({ initial: signedIn('a') });
        yield* SubscriptionRef.update(settings, current => ({
          ...current,
          dockContentProtection: !current.dockContentProtection,
        }));
        yield* SubscriptionRef.update(sessionState, current => ({
          ...current,
          accounts: { a: { ...current.accounts.a!, name: 'new display name' } },
        }));
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow();
        assert.lengthOf(sinks, 1);
        assert.isFalse(sinks[0]!.discarded);
      })
    )
  );
  it.effect(
    'renderer events require the revision of their emitting identity and organization',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { telemetry, sinks, sessionState } = yield* setup({
            initial: signedIn('a', 'org_1'),
          });
          const original = yield* telemetry.getState;
          yield* telemetry.capture('missing_revision', {}, 'renderer');
          yield* SubscriptionRef.set(sessionState, signedIn('b', 'org_2'));
          yield* telemetry.capture('stale_account', {}, 'renderer', original.revision);
          yield* telemetry.captureException(
            new Error('old account'),
            {},
            'renderer',
            original.revision
          );
          yield* telemetry.captureException(
            new Error('queued main failure'),
            {},
            'main',
            original.revision
          );
          const current = yield* telemetry.getState;
          assert.isAbove(current.revision, original.revision);
          assert.equal((yield* SubscriptionRef.get(telemetry.state)).revision, current.revision);
          yield* telemetry.capture('current_account', {}, 'renderer', current.revision);
          yield* SubscriptionRef.set(sessionState, signedIn('b', 'org_3'));
          yield* telemetry.capture('stale_org', {}, 'renderer', current.revision);
          const next = yield* telemetry.getState;
          assert.isAbove(next.revision, current.revision);
          assert.deepEqual(
            sinks.flatMap(sink => sink.captures).map(event => event.event),
            ['current_account']
          );
          assert.lengthOf(
            sinks.flatMap(sink => sink.exceptions),
            0
          );
          assert.deepEqual(sinks.flatMap(sink => sink.captures)[0]!.groups, {
            organization: 'org_2',
          });
        })
      )
  );
  it.effect(
    'rapid policy and account round trips invalidate renderer revisions even when policy returns unchanged',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const anonymous = yield* setup({ preference: true });
          const beforePreference = yield* anonymous.telemetry.getState;
          yield* Effect.sync(() => {
            Effect.runSync(anonymous.setPreference(false));
            Effect.runSync(anonymous.setPreference(true));
          });
          for (let i = 0; i < 10; i++) yield* Effect.yieldNow();
          const afterPreference = yield* anonymous.telemetry.getState;
          assert.isAbove(afterPreference.revision, beforePreference.revision);
          assert.equal(afterPreference.enabled, beforePreference.enabled);
          yield* anonymous.telemetry.capture(
            'stale_policy',
            {},
            'renderer',
            beforePreference.revision
          );
          assert.lengthOf(
            anonymous.sinks.flatMap(sink => sink.captures),
            0
          );

          const signed = yield* setup({ initial: signedIn('a') });
          const beforeIdentity = yield* signed.telemetry.getState;
          yield* Effect.sync(() => {
            Effect.runSync(SubscriptionRef.set(signed.sessionState, signedIn('b')));
            Effect.runSync(SubscriptionRef.set(signed.sessionState, signedIn('a')));
          });
          for (let i = 0; i < 10; i++) yield* Effect.yieldNow();
          const afterIdentity = yield* signed.telemetry.getState;
          assert.isAbove(afterIdentity.revision, beforeIdentity.revision);
          assert.equal(afterIdentity.signedIn, beforeIdentity.signedIn);
          yield* signed.telemetry.capture(
            'stale_identity',
            {},
            'renderer',
            beforeIdentity.revision
          );
          assert.lengthOf(
            signed.sinks.flatMap(sink => sink.captures),
            0
          );
        })
      )
  );
});

describe('device fallback and lifecycle', () => {
  const unavailable = () => Promise.reject(new Error('machine unavailable'));
  it.effect('resolves the shared device ID for updates without starting telemetry or substituting an account ID', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const setupResult = yield* setup();
        const { telemetry, setPreference, sessionState } = setupResult;
        assert.strictEqual(setupResult.machineReads, 0);
        assert.strictEqual(yield* telemetry.getDeviceId, 'hashed-machine-id');
        assert.lengthOf(setupResult.sinks, 0);
        assert.isFalse((yield* telemetry.getState).enabled);
        yield* setPreference(true);
        yield* telemetry.getState;
        yield* SubscriptionRef.set(sessionState, signedIn('account-a'));
        yield* telemetry.getState;
        assert.strictEqual(yield* telemetry.getDeviceId, 'hashed-machine-id');
        assert.strictEqual(setupResult.machineReads, 1);
      })
    )
  );
  it.effect('reuses the persisted installation fallback for updates with telemetry disabled', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup({ machineId: unavailable, seed: { [DEVICE_ID_KEY]: 'install-id' } });
        const ids = yield* Effect.all([f.telemetry.getDeviceId, f.telemetry.getDeviceId], {
          concurrency: 'unbounded',
        });
        assert.deepStrictEqual(ids, ['install-id', 'install-id']);
        assert.strictEqual(f.machineReads, 1);
        assert.lengthOf(f.sinks, 0);
        assert.isFalse((yield* f.telemetry.getState).enabled);
      })
    )
  );
  it.effect('machine ID takes precedence over a saved fallback', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks, db } = yield* setup({
          preference: true,
          seed: { [DEVICE_ID_KEY]: 'old-fallback' },
        });
        yield* telemetry.capture('app_launch');
        assert.equal(sinks[0]!.captures[0]!.distinctId, 'hashed-machine-id');
        assert.equal(db.store.get(DEVICE_ID_KEY), 'old-fallback');
      })
    )
  );
  it.effect('uses a persisted installation ID when machine lookup fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { telemetry, sinks } = yield* setup({
          preference: true,
          machineId: unavailable,
          seed: { [DEVICE_ID_KEY]: 'fallback' },
        });
        yield* telemetry.capture('app_launch');
        assert.equal(sinks[0]!.captures[0]!.distinctId, 'fallback');
        assert.equal(yield* telemetry.getDeviceId, 'fallback');
      })
    )
  );
  it.effect('persists a new fallback, or uses an ephemeral ID when storage fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persisted = yield* setup({ preference: true, machineId: unavailable });
        yield* persisted.telemetry.capture('app_launch');
        assert.equal(
          persisted.sinks[0]!.captures[0]!.distinctId,
          persisted.db.store.get(DEVICE_ID_KEY)
        );
        const ephemeral = yield* setup({ preference: true, machineId: unavailable, failDb: true });
        yield* ephemeral.telemetry.capture('app_launch');
        assert.match(ephemeral.sinks[0]!.captures[0]!.distinctId, /^[0-9a-f-]{36}$/);
        assert.lengthOf(
          ephemeral.logger.entries.filter(
            entry =>
              entry.message === 'Persistent device identity unavailable; using temporary identity'
          ),
          1
        );
      })
    )
  );
  it.effect('scope close flushes enabled client and later calls are inert', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* setup({ initial: signedIn() });
          yield* fixture.telemetry.capture('app_launch');
          return fixture;
        })
      );
      assert.equal(fixture.sinks[0]!.shutdownCalls, 1);
      assert.isTrue(fixture.sinks[0]!.discarded);
      yield* fixture.telemetry.capture('after_close');
      assert.lengthOf(fixture.sinks[0]!.captures, 1);
    })
  );
  it.effect('shutdown deadline aborts the retained sink and closes delivery authority', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* setup({
        initial: signedIn(),
        shutdown: () => new Promise(() => {}),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const closing = yield* Effect.fork(Scope.close(scope, Exit.void));
      yield* TestClock.adjust('2 seconds');
      yield* Fiber.join(closing);
      assert.equal(fixture.sinks[0]!.shutdownCalls, 1);
      assert.isTrue(fixture.sinks[0]!.discarded);
      assert.isFalse(fixture.sinks[0]!.isAllowed());
    })
  );
});
