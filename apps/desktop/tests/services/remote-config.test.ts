import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope, SubscriptionRef, TestClock } from 'effect';
import { initialAuthState, type AuthState } from '../../src/main/domains/auth/policy';
import { AuthService, RefreshError, type AuthApi } from '../../src/main/domains/auth/service';
import { makeRemoteConfigLive, REMOTE_CONFIG_KEY } from '../../src/main/domains/remote-config/live';
import { RemoteConfig } from '../../src/main/domains/remote-config/service';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { testTelemetryLayer } from '../helpers/telemetry';
import { makeTestLogger, testConfigLayer, testI18nLayer } from '../helpers/test-layers';

const version = '0.3.7';
const required = { required: true, evaluatedVersion: version, minimumVersion: '0.4.0' };
const allowed = { required: false, evaluatedVersion: version };
const signedIn: AuthState = {
  ...initialAuthState,
  gate: 'signed-in',
  activeSub: 'user_1',
  accounts: { user_1: { sub: 'user_1', email: 'user@example.com', orgs: [] } },
};
const settle = Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));

const setup = (
  options: {
    cached?: unknown;
    initial?: AuthState;
    token?: AuthApi['getIdToken'];
    fetch?: typeof fetch;
  } = {}
) =>
  Effect.gen(function* () {
    const db = makeFakeOperationalDb(
      options.cached === undefined
        ? {}
        : {
            [REMOTE_CONFIG_KEY]: JSON.stringify(options.cached),
          }
    );
    const sessionState = yield* SubscriptionRef.make(options.initial ?? initialAuthState);
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    let response: unknown = {};
    const auth: AuthApi = {
      sessionState,
      signIn: () => Effect.void,
      signOut: () => Effect.void,
      setActiveAccount: () => Effect.void,
      setActiveOrg: () => Effect.void,
      getIdToken: options.token ?? (() => Effect.succeed('test-token')),
      openWebSession: () => Effect.void,
      consumePendingEntry: () => Effect.succeed('rejected' as const),
      pendingAttemptState: Effect.succeed(null),
      pendingAttemptAuthorizeUrl: Effect.succeed(null),
    };
    const layer = makeRemoteConfigLive(async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return options.fetch ? options.fetch(url, init) : Response.json(response);
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          db.layer,
          makeTestLogger().layer,
          testConfigLayer({ appVersion: version }),
          testI18nLayer('de'),
          testTelemetryLayer,
          Layer.succeed(AuthService, auth)
        )
      )
    );
    const service = Context.get(yield* Layer.build(layer), RemoteConfig);
    return {
      service,
      db,
      requests,
      sessionState,
      respond: (value: unknown) => {
        response = value;
      },
    };
  });

describe('RemoteConfig', () => {
  it.scoped('fetches on every startup, even with cache, then every 15 minutes', () =>
    Effect.gen(function* () {
      const f = yield* setup({ cached: { updateRequirement: required }, initial: signedIn });
      assert.isTrue(yield* f.service.isUpdateRequired);
      yield* settle;
      assert.lengthOf(f.requests, 1);
      const { url, init } = f.requests[0]!;
      assert.equal(url.pathname, '/apps/v1/remote-config');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        version,
        platform: process.platform,
        locale: 'de',
      });
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('prismical-device-id'), 'test-device-id');
      assert.equal(headers.get('prismical-client'), 'desktop');
      assert.equal(headers.get('prismical-version'), version);
      assert.equal(headers.get('prismical-platform'), process.platform);
      assert.equal(headers.get('Accept-Language'), 'de');
      assert.match(
        headers.get('User-Agent')!,
        /^prismical-desktop\/0\.3\.7 \((macOS|Windows|Linux)\)$/
      );
      assert.equal(headers.get('Authorization'), 'Bearer test-token');
      yield* TestClock.adjust('5 minutes');
      yield* settle;
      assert.lengthOf(f.requests, 1);
      yield* TestClock.adjust('10 minutes');
      yield* settle;
      assert.lengthOf(f.requests, 2);
      yield* TestClock.adjust('15 minutes');
      yield* settle;
      assert.lengthOf(f.requests, 3);
    })
  );

  it.scoped(
    'retains cached policy for missing/invalid/offline responses; explicit false clears it',
    () =>
      Effect.gen(function* () {
        let response: unknown = {};
        const f = yield* setup({
          cached: { updateRequirement: required },
          fetch: async () => {
            if (response instanceof Error) throw response;
            return Response.json(response);
          },
        });
        yield* settle;
        for (const value of [
          {},
          { updateRequirement: { required: 'false' } },
          new Error('offline'),
        ]) {
          response = value;
          yield* f.service.refresh;
          assert.isTrue(yield* f.service.isUpdateRequired);
          assert.deepEqual(JSON.parse(f.db.store.get(REMOTE_CONFIG_KEY)!), {
            updateRequirement: required,
          });
        }
        response = { updateRequirement: allowed };
        yield* f.service.refresh;
        assert.isFalse(yield* f.service.isUpdateRequired);
        assert.deepEqual(JSON.parse(f.db.store.get(REMOTE_CONFIG_KEY)!), response);
      })
  );

  it.scoped(
    'does not apply cached or fetched requirements evaluated for a different app version',
    () =>
      Effect.gen(function* () {
        const f = yield* setup({
          cached: { updateRequirement: { ...required, evaluatedVersion: '0.3.6' } },
        });
        assert.isFalse(yield* f.service.isUpdateRequired);
        yield* settle;
        f.respond({ updateRequirement: { ...required, evaluatedVersion: '0.3.6' } });
        yield* f.service.refresh;
        assert.isFalse(yield* f.service.isUpdateRequired);
        f.respond({ updateRequirement: required });
        yield* f.service.refresh;
        assert.isTrue(yield* f.service.isUpdateRequired);
      })
  );

  it.scoped('retains cached policy when signed-in token resolution fails', () =>
    Effect.gen(function* () {
      const f = yield* setup({
        cached: { updateRequirement: required },
        initial: signedIn,
        token: () => Effect.fail(new RefreshError({ reason: 'transient' })),
      });
      yield* settle;
      assert.lengthOf(f.requests, 0);
      assert.isTrue(yield* f.service.isUpdateRequired);
    })
  );

  it.scoped(
    'refetches for a changed identity, ignores old responses, and coalesces new-identity refreshes',
    () =>
      Effect.gen(function* () {
        const replies: Array<(value: Response) => void> = [];
        const f = yield* setup({
          cached: { updateRequirement: required },
          initial: signedIn,
          fetch: () => new Promise(resolve => replies.push(resolve)),
        });
        yield* settle;
        assert.lengthOf(replies, 1);
        yield* SubscriptionRef.set(f.sessionState, initialAuthState);
        yield* settle;
        assert.lengthOf(replies, 2);
        assert.isTrue(yield* f.service.isUpdateRequired);
        assert.isNull(new Headers(f.requests[1]!.init?.headers).get('Authorization'));
        yield* f.service.refresh;
        assert.lengthOf(replies, 2);
        replies[1]!(Response.json({ updateRequirement: required }));
        yield* settle;
        replies[0]!(Response.json({ updateRequirement: allowed }));
        yield* settle;
        assert.isTrue(yield* f.service.isUpdateRequired);
        assert.deepEqual(JSON.parse(f.db.store.get(REMOTE_CONFIG_KEY)!), {
          updateRequirement: required,
        });
      })
  );

  it.scoped('times out a stalled request, aborts it, and permits the next refresh', () =>
    Effect.gen(function* () {
      const f = yield* setup({
        cached: { updateRequirement: required },
        fetch: () => new Promise(() => {}),
      });
      yield* settle;
      yield* TestClock.adjust('15 seconds');
      yield* settle;
      assert.isTrue(f.requests[0]!.init!.signal!.aborted);
      assert.isTrue(yield* f.service.isUpdateRequired);
      yield* Effect.forkScoped(f.service.refresh);
      yield* settle;
      assert.lengthOf(f.requests, 2);
    })
  );

  it.effect('scope close aborts outstanding requests and stops polling', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const f = yield* setup({ fetch: () => new Promise(() => {}) }).pipe(Scope.extend(scope));
      yield* settle;
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(f.requests[0]!.init!.signal!.aborted);
      yield* TestClock.adjust('30 minutes');
      yield* settle;
      assert.lengthOf(f.requests, 1);
    })
  );
});
