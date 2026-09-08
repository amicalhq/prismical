/**
 * AuthService live-layer tests: browser launch, attempt
 * single-consumption, exchange pipeline against an injected fetch stub,
 * ID token claim validation, single-flight refresh
 * under TestClock, resume/focus re-checks, restart-restore, sign-out
 * revocation, and regressions for earlier token-custody defects.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
  SubscriptionRef,
  TestClock,
} from 'effect';
import { generateKeyPair, SignJWT } from 'jose';
import { vi } from 'vitest';
import type { SessionGateState } from '@prismical/desktop-contracts';
import type { FakeElectron } from '../helpers/fake-electron';
import { makeTestLogger, testConfig, testConfigLayer } from '../helpers/test-layers';
import { runAuthConsumer } from '../../src/main/domains/auth/consumer';
import {
  ACCOUNT_INDEX_KEY,
  makeAuthLive,
  TOKEN_REQUEST_TIMEOUT,
  type AuthLiveOptions,
  type FetchLike,
} from '../../src/main/domains/auth/live';
import { ATTEMPT_TTL_MS, type RandomSource } from '../../src/main/domains/auth/policy';
import { AuthService, type AuthApi } from '../../src/main/domains/auth/service';
import { DeepLinksLive } from '../../src/main/domains/deep-link/live';
import { DeepLinks, type DeepLinksService } from '../../src/main/domains/deep-link/service';
import {
  WindowRegistry,
  type WindowEvent,
  type WindowRegistryService,
} from '../../src/main/domains/windows/service';
import { ElectronAppLive } from '../../src/main/infra/electron/live';
import { DbError, OperationalDb, type OperationalDbService } from '../../src/main/infra/operational-db/service';
import { OperationalDbLive } from '../../src/main/infra/operational-db/live';
import * as dbSchema from '../../src/main/infra/operational-db/schema';
import {
  SecureStore,
  SecureStoreError,
  type SecureStoreService,
} from '../../src/main/infra/secure-store/service';
import { SecureStoreLive } from '../../src/main/infra/secure-store/live';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

// ---------------------------------------------------------------------------
// Fixtures: keys, tokens, fetch stub, deterministic PKCE
// ---------------------------------------------------------------------------

const goodKeys = await generateKeyPair('ES256');
const evilKeys = await generateKeyPair('ES256');

const AUTH = testConfig().auth;
const SENTINEL_REFRESH_1 = 'SENTINEL-REFRESH-TOKEN-1';
const SENTINEL_REFRESH_2 = 'SENTINEL-REFRESH-TOKEN-2';
const SENTINEL_REFRESH_3 = 'SENTINEL-REFRESH-TOKEN-3';
const SENTINEL_ACCESS = 'SENTINEL-ACCESS-TOKEN';

/** Deterministic bytes so the authorize URL is predictable byte-for-byte. */
const fixedRandom: RandomSource = length => Uint8Array.from({ length }, (_, i) => i + 1);
const expectedVerifier = Buffer.from(fixedRandom(32)).toString('base64url');
const expectedChallenge = createHash('sha256').update(expectedVerifier).digest().toString('base64url');
const expectedState = Buffer.from(fixedRandom(16)).toString('base64url');

interface MintOptions {
  readonly sub?: string;
  readonly email?: string;
  readonly firstParty?: boolean;
  readonly key?: CryptoKey;
  /** Wrong-issuer and wrong-audience negatives; defaults match testConfig. */
  readonly issuer?: string;
  readonly audience?: string;
  readonly expiresAt?: number;
  /**
   * `org_users` claim org ids; defaults to the single 'org_1'. Overriding it only for the
   * REFRESH response models the membership the current token predates — a just-created or
   * just-accepted org, which is what setActiveOrg's refresh-on-miss exists to pick up.
   */
  readonly orgIds?: readonly string[];
}

let lastMintedIdToken = '';

const mintIdToken = async (opts: MintOptions = {}): Promise<string> => {
  const token = await new SignJWT({
    email: opts.email ?? 'u1@example.com',
    name: 'User One',
    prismical_first_party: opts.firstParty ?? true,
    org_users: (opts.orgIds ?? ['org_1']).map((orgId, index) => ({
      id: `ou_${index + 1}`,
      org_id: orgId,
      user_id: opts.sub ?? 'user_1',
    })),
  })
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(opts.sub ?? 'user_1')
    .setIssuer(opts.issuer ?? AUTH.issuer)
    .setAudience(opts.audience ?? AUTH.oauthClientId)
    .setIssuedAt()
    .setExpirationTime(opts.expiresAt ?? '10h')
    .sign(opts.key ?? goodKeys.privateKey);
  lastMintedIdToken = token;
  return token;
};

interface TokenBodyOptions extends MintOptions {
  readonly expiresIn?: number | string;
  /** null ⇒ omit refresh_token from the response entirely. */
  readonly refreshToken?: string | null;
}

const tokenBody = async (opts: TokenBodyOptions = {}): Promise<Record<string, unknown>> => ({
  access_token: SENTINEL_ACCESS,
  expires_in: opts.expiresIn ?? 36000,
  token_type: 'Bearer',
  ...(opts.refreshToken === null ? {} : { refresh_token: opts.refreshToken ?? SENTINEL_REFRESH_1 }),
  scope: 'openid profile email offline_access',
  id_token: await mintIdToken(opts),
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

type StubHandler = (
  url: string,
  body: Record<string, unknown>
) => Response | Promise<Response>;

interface FetchStub {
  readonly requests: RecordedRequest[];
  handler: StubHandler;
  readonly fetchFn: FetchLike;
  readonly exchangeCalls: () => RecordedRequest[];
  readonly refreshCalls: () => RecordedRequest[];
  readonly revokeCalls: () => RecordedRequest[];
}

const makeFetchStub = (handler: StubHandler): FetchStub => {
  const requests: RecordedRequest[] = [];
  const stub: FetchStub = {
    requests,
    handler,
    fetchFn: (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push({ url, body, headers: init.headers });
      return Promise.resolve(stub.handler(url, body));
    },
    exchangeCalls: () =>
      requests.filter(r => r.url === AUTH.tokenUrl && r.body['grant_type'] === 'authorization_code'),
    refreshCalls: () =>
      requests.filter(r => r.url === AUTH.tokenUrl && r.body['grant_type'] === 'refresh_token'),
    revokeCalls: () => requests.filter(r => r.url === AUTH.revokeUrl),
  };
  return stub;
};

/** Standard happy-path IdP: exchange + refresh mint good tokens, revoke 200s. */
const happyHandler =
  (overrides: { exchange?: TokenBodyOptions; refresh?: TokenBodyOptions } = {}): StubHandler =>
  async (url, body) => {
    if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
      return jsonResponse(await tokenBody(overrides.exchange ?? {}));
    }
    if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
      return jsonResponse(await tokenBody(overrides.refresh ?? { refreshToken: SENTINEL_REFRESH_2 }));
    }
    if (url === AUTH.revokeUrl) {
      return jsonResponse({});
    }
    throw new Error(`unexpected request: ${url}`);
  };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface WindowsStubHolder {
  offer: (event: WindowEvent) => void;
}

const makeWindowsStub = () => {
  const holder: WindowsStubHolder = {
    offer: () => {
      throw new Error('windows stub not built yet');
    },
  };
  const layer = Layer.effect(
    WindowRegistry,
    Effect.gen(function* () {
      const events = yield* Queue.sliding<WindowEvent>(16);
      holder.offer = event => {
        Queue.unsafeOffer(events, event);
      };
      const service: WindowRegistryService = {
        openMainWindow: Effect.die('unused in stub'),
        setThemeSource: () => Effect.void,
        identityForWebContents: () => Effect.succeed(Option.none()),
        mainWindow: Effect.succeed(Option.none()),
        focusMainWindow: Effect.void,
        sendToMainWindow: () => Effect.succeed(true),
        windowEvents: events,
        openWidgetWindow: Effect.die('unused in stub'),
        widgetWindow: Effect.succeed(Option.none()),
        sendToWidgetWindow: () => Effect.succeed(false),
        setWidgetIgnoreMouse: () => Effect.void,
        dragDockWindow: () => Effect.succeed(Option.none()),
        openNotifyWindow: Effect.never as never,
        notifyWindow: Effect.succeed(Option.none()),
        sendToNotifyWindow: () => Effect.succeed(false),
        setNotifyIgnoreMouse: () => Effect.void,
        repositionNotifyWindow: Effect.void,
        openFloatNoteWindow: () => Effect.void,
        floatNoteWindow: Effect.succeed(Option.none()),
        closeFloatNoteWindow: Effect.void,
        hideFloatNoteWindow: Effect.void,
        sendToFloatNoteWindow: () => Effect.succeed(false),
        sendToAppWindows: () => Effect.void,
        repositionDockWindow: Effect.void,
        repositionFloatNoteWindow: Effect.void,
        setDockContentProtection: () => Effect.void,
        mainWindowFocused: yield* SubscriptionRef.make(false),
      };
      return service;
    })
  );
  return { holder, layer };
};

interface BuildExtras {
  /** Overrides for the injected auth-live seams (e.g. a varying randomSource). */
  readonly auth?: Partial<AuthLiveOptions>;
  /** Wraps the REAL secure store — failure injection for custody tests. */
  readonly decorateSecureStore?: (service: SecureStoreService) => SecureStoreService;
  /** Wraps the REAL operational DB — failure injection for index tests. */
  readonly decorateDb?: (service: OperationalDbService) => OperationalDbService;
}

const build = (
  fetchStub: FetchStub,
  configOverrides: Parameters<typeof testConfigLayer>[0] = {},
  extras: BuildExtras = {}
) => {
  const logger = makeTestLogger();
  const config = testConfigLayer(configOverrides);
  const electronApp = ElectronAppLive.pipe(Layer.provide(logger.layer));
  const baseDb = OperationalDbLive.pipe(Layer.provide(config), Layer.provide(logger.layer));
  const db = extras.decorateDb
    ? Layer.effect(OperationalDb, Effect.map(OperationalDb, extras.decorateDb)).pipe(
        Layer.provide(baseDb)
      )
    : baseDb;
  const baseSecureStore = SecureStoreLive.pipe(
    Layer.provide(config),
    Layer.provide(electronApp),
    Layer.provide(db),
    Layer.provide(logger.layer)
  );
  const secureStore = extras.decorateSecureStore
    ? Layer.effect(SecureStore, Effect.map(SecureStore, extras.decorateSecureStore)).pipe(
        Layer.provide(baseSecureStore)
      )
    : baseSecureStore;
  const windows = makeWindowsStub();
  const deepLinks = DeepLinksLive.pipe(Layer.provide(electronApp), Layer.provide(logger.layer));
  const auth = makeAuthLive({
    fetchFn: fetchStub.fetchFn,
    randomSource: fixedRandom,
    ...extras.auth,
  }).pipe(
    Layer.provide(config),
    Layer.provide(secureStore),
    Layer.provide(db),
    Layer.provide(electronApp),
    Layer.provide(windows.layer),
    Layer.provide(logger.layer)
  );
  const layer = Layer.mergeAll(
    config,
    logger.layer,
    electronApp,
    db,
    secureStore,
    windows.layer,
    deepLinks,
    auth
  );
  return { logger, layer, windows: windows.holder };
};

/** Lets real-promise work (fetch stub, jose) land between fiber steps. */
const flush: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 6; i++) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
  }
});

/** Wait for an async watcher/flight side effect without assuming a fixed event-loop speed. */
const awaitCallCount = (
  calls: () => readonly unknown[],
  expected: number,
  message: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && calls().length < expected; i++) {
      yield* flush;
    }
    assert.strictEqual(calls().length, expected, message);
  });

const awaitGate = (auth: AuthApi, gate: SessionGateState): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const state = yield* SubscriptionRef.get(auth.sessionState);
      if (state.gate === gate) return;
      yield* flush;
    }
    const state = yield* SubscriptionRef.get(auth.sessionState);
    assert.strictEqual(state.gate, gate, 'session gate did not settle');
  });

const deliverCallback = (
  deepLinks: DeepLinksService,
  code: string,
  state: string
): Effect.Effect<void> =>
  SubscriptionRef.update(deepLinks.pendingOAuth, entries => [
    ...entries,
    { _tag: 'OAuthCallback' as const, code, state, receivedAt: Date.now() },
  ]);

const failureReason = (exit: Exit.Exit<unknown, unknown>): string | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(
        Option.map(Cause.failureOption(exit.cause), error =>
          typeof error === 'object' && error !== null && 'reason' in error
            ? String((error as { reason: unknown }).reason)
            : undefined
        )
      )
    : undefined;

/** signIn → deliver the matching callback → wait for signed-in. */
const completeSignIn = (
  auth: AuthApi,
  deepLinks: DeepLinksService,
  shellBase: number
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    yield* auth.signIn().pipe(Effect.orDie);
    const launched = fake.shell.openExternalCalls[shellBase];
    assert.isDefined(launched, 'browser launch recorded');
    const state = new URL(launched).searchParams.get('state') ?? '';
    yield* deliverCallback(deepLinks, 'code-1', state);
    yield* awaitGate(auth, 'signed-in');
  });

describe('AuthService', () => {
  it.effect('boots signed-out and signIn launches the browser with the exact authorize URL', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const shellBase = fake.shell.openExternalCalls.length;

      const initial = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(initial.gate, 'signed-out');
      assert.deepStrictEqual(initial.accounts, {});

      yield* auth.signIn();
      const expected = new URL(AUTH.authorizeUrl);
      expected.searchParams.set('client_id', AUTH.oauthClientId);
      expected.searchParams.set('redirect_uri', AUTH.redirectUri);
      expected.searchParams.set('response_type', 'code');
      expected.searchParams.set('scope', 'openid profile email offline_access');
      expected.searchParams.set('code_challenge', expectedChallenge);
      expected.searchParams.set('code_challenge_method', 'S256');
      expected.searchParams.set('state', expectedState);
      assert.deepStrictEqual(fake.shell.openExternalCalls.slice(shellBase), [expected.toString()]);
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).gate, 'signing-in');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('opens an authenticated web handoff for the active desktop account', () =>
    Effect.gen(function* () {
      const handoffEndpoint = 'https://core.test/api/auth/handoff/web-session';
      const handoffUrl =
        'https://app.test/auth/handoff?token=opaque-token&return=%2Fsettings%2Faccount';
      const baseHandler = happyHandler();
      const stub = makeFetchStub((url, body) =>
        url === handoffEndpoint ? jsonResponse({ url: handoffUrl }) : baseHandler(url, body)
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const shellBase = fake.shell.openExternalCalls.length;
      yield* auth.openWebSession('/settings/account', 'org_1');

      const handoffRequest = stub.requests.find(request => request.url === handoffEndpoint);
      assert.deepStrictEqual(handoffRequest?.body, {
        return: '/settings/account',
        activeOrgId: 'org_1',
      });
      assert.strictEqual(handoffRequest?.headers.authorization, `Bearer ${lastMintedIdToken}`);
      assert.deepStrictEqual(fake.shell.openExternalCalls.slice(shellBase), [handoffUrl]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('accepts an HTTPS handoff URL on a sibling subdomain of the CONFIGURED web origin', () =>
    Effect.gen(function* () {
      // The allowlist derives from the configured webAppOrigin
      // (its apex + subdomains) instead of a baked production hostname — an
      // OSS build pointed elsewhere must not implicitly trust prismical.ai.
      // A 3-label origin exercises the apex derivation.
      const handoffEndpoint = 'https://core.test/api/auth/handoff/web-session';
      const handoffUrl = 'https://web.prismical.test/session/continue';
      const baseHandler = happyHandler();
      const stub = makeFetchStub((url, body) =>
        url === handoffEndpoint ? jsonResponse({ url: handoffUrl }) : baseHandler(url, body)
      );
      const { layer } = build(stub, {
        endpoints: {
          coreApiUrl: 'https://core.test',
          noteWsUrl: 'wss://note.test/collaboration',
          webAppOrigin: 'https://app.prismical.test',
          analyticsKey: null,
          analyticsHost: null,
        },
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const shellBase = fake.shell.openExternalCalls.length;
      yield* auth.openWebSession('/home');

      assert.deepStrictEqual(fake.shell.openExternalCalls.slice(shellBase), [handoffUrl]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('rejects a handoff URL outside the configured and official web origins', () =>
    Effect.gen(function* () {
      for (const unsafeUrl of [
        'https://prismical.ai.evil.test/session/continue',
        'http://app.prismical.ai/session/continue',
      ]) {
        const handoffEndpoint = 'https://core.test/api/auth/handoff/web-session';
        const baseHandler = happyHandler();
        const stub = makeFetchStub((url, body) =>
          url === handoffEndpoint ? jsonResponse({ url: unsafeUrl }) : baseHandler(url, body)
        );
        const { layer } = build(stub);
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
        const auth = Context.get(ctx, AuthService);
        const deepLinks = Context.get(ctx, DeepLinks);

        yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
        const shellBase = fake.shell.openExternalCalls.length;
        const exit = yield* Effect.exit(auth.openWebSession('/home'));

        assert.strictEqual(failureReason(exit), 'unsafe-url');
        assert.strictEqual(fake.shell.openExternalCalls.length, shellBase);
        yield* Scope.close(scope, Exit.void);
      }
    })
  );

  it.effect('empty client id ⇒ NOT_CONFIGURED-mapped failure, no browser launch', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer } = build(stub, { auth: { ...AUTH, oauthClientId: '' } });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const shellBase = fake.shell.openExternalCalls.length;

      const exit = yield* Effect.exit(auth.signIn());
      assert.strictEqual(failureReason(exit), 'not-configured');
      assert.strictEqual(fake.shell.openExternalCalls.length, shellBase);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // Abandoned-flow lockout: a user retry replaces the parked
  // attempt — fresh state, browser relaunched — instead of failing
  // FLOW_ALREADY_PENDING for the full 10-minute attempt TTL.
  it.effect('a second signIn REPLACES the parked attempt: new state, relaunched browser, stale callback rejected', () =>
    Effect.gen(function* () {
      // Varying randomness so the replacement attempt gets a DIFFERENT state.
      let counter = 0;
      const varyingRandom: RandomSource = length => {
        counter += 1;
        return Uint8Array.from({ length }, (_, i) => (i + counter) % 256);
      };
      const stub = makeFetchStub(happyHandler());
      const { layer, logger } = build(stub, {}, { auth: { randomSource: varyingRandom } });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const shellBase = fake.shell.openExternalCalls.length;

      yield* auth.signIn();
      const firstState = yield* auth.pendingAttemptState;
      yield* auth.signIn();
      const secondState = yield* auth.pendingAttemptState;
      // Browser relaunched, exactly ONE pending slot holding the NEW attempt.
      assert.strictEqual(fake.shell.openExternalCalls.length - shellBase, 2);
      assert.isNotNull(firstState);
      assert.isNotNull(secondState);
      assert.notStrictEqual(secondState, firstState);

      // The stale browser tab's callback fails the state match: rejected AND
      // counted, never exchanged.
      yield* deliverCallback(deepLinks, 'stale-code', String(firstState));
      yield* flush;
      assert.strictEqual(stub.exchangeCalls().length, 0);
      assert.isDefined(logger.find(e => e.message === 'oauth entry rejected'));
      assert.strictEqual(yield* auth.pendingAttemptState, secondState);

      // The replacement attempt completes normally.
      yield* deliverCallback(deepLinks, 'code-1', String(secondState));
      yield* awaitGate(auth, 'signed-in');
      assert.strictEqual(stub.exchangeCalls().length, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // FLOW_ALREADY_PENDING is only the concurrent-invoke guard —
  // a double-click storm single-flights into one attempt + one browser launch.
  it.effect('concurrent signIn invokes single-flight into ONE attempt', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const shellBase = fake.shell.openExternalCalls.length;

      const [first, second] = yield* Effect.all(
        [Effect.exit(auth.signIn()), Effect.exit(auth.signIn())],
        { concurrency: 'unbounded' }
      );
      const outcomes = [first, second].map(exit =>
        Exit.isSuccess(exit) ? 'ok' : failureReason(exit)
      );
      assert.deepStrictEqual(outcomes.sort(), ['flow-already-pending', 'ok']);
      assert.strictEqual(fake.shell.openExternalCalls.length - shellBase, 1);
      // The guard released: a sequential retry replaces freely.
      yield* auth.signIn();
      assert.strictEqual(fake.shell.openExternalCalls.length - shellBase, 2);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('full sign-in: exact JSON exchange body (no client_secret), verified account in state', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);

      const exchanges = stub.exchangeCalls();
      assert.strictEqual(exchanges.length, 1);
      assert.deepStrictEqual(exchanges[0].body, {
        grant_type: 'authorization_code',
        code: 'code-1',
        client_id: AUTH.oauthClientId,
        redirect_uri: AUTH.redirectUri,
        code_verifier: expectedVerifier,
      });
      assert.notProperty(exchanges[0].body, 'client_secret');

      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(state.activeSub, 'user_1');
      assert.deepStrictEqual(state.accounts['user_1'], {
        sub: 'user_1',
        email: 'u1@example.com',
        name: 'User One',
        orgs: [{ id: 'ou_1', orgId: 'org_1', userId: 'user_1' }],
      });
      // Fresh token served from memory — no refresh call.
      assert.strictEqual(yield* auth.getIdToken(), lastMintedIdToken);
      assert.strictEqual(stub.refreshCalls().length, 0);
      // Refresh token persisted through SecureStore only.
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('pendingAttemptState (e2e seam) exposes the state param only, and clears on consumption', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      assert.isNull(yield* auth.pendingAttemptState);
      yield* auth.signIn();
      // The public state param — NEVER the verifier (that stays in the Ref;
      // the exchange body is the only place it may appear).
      assert.strictEqual(yield* auth.pendingAttemptState, expectedState);
      assert.notStrictEqual(yield* auth.pendingAttemptState, expectedVerifier);
      const authorizeUrl = new URL(String(yield* auth.pendingAttemptAuthorizeUrl));
      assert.strictEqual(authorizeUrl.searchParams.get('state'), expectedState);
      assert.strictEqual(authorizeUrl.searchParams.get('code_challenge'), expectedChallenge);
      assert.strictEqual(authorizeUrl.searchParams.get('code_verifier'), null);

      yield* deliverCallback(deepLinks, 'code-1', expectedState);
      yield* awaitGate(auth, 'signed-in');
      assert.isNull(yield* auth.pendingAttemptState);
      assert.isNull(yield* auth.pendingAttemptAuthorizeUrl);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('attempt consumed exactly once: a duplicate callback never re-exchanges', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer, logger } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const shellBase = fake.shell.openExternalCalls.length;

      yield* auth.signIn();
      const launched = fake.shell.openExternalCalls[shellBase];
      const state = new URL(launched).searchParams.get('state') ?? '';
      // Same state delivered twice (duplicate deep link).
      yield* deliverCallback(deepLinks, 'code-1', state);
      yield* deliverCallback(deepLinks, 'code-1', state);
      yield* awaitGate(auth, 'signed-in');
      yield* flush;

      assert.strictEqual(stub.exchangeCalls().length, 1, 'exactly one exchange');
      // The duplicate is rejected and counted.
      assert.isDefined(logger.find(e => e.message === 'oauth entry rejected'));
      assert.strictEqual(yield* Effect.map(SubscriptionRef.get(deepLinks.pendingOAuth), p => p.length), 0);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('wrong-state callback is rejected, never exchanged; the attempt survives', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer, logger } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* auth.signIn();
      yield* deliverCallback(deepLinks, 'stolen-code', 'attacker-state');
      yield* flush;

      assert.strictEqual(stub.exchangeCalls().length, 0, 'no exchange for a wrong state');
      assert.isDefined(logger.find(e => e.message === 'oauth callback rejected — no matching attempt'));
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).gate, 'signing-in');
      // The pending attempt was not consumed by the bogus callback.
      assert.strictEqual(yield* auth.pendingAttemptState, expectedState);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('OAuthError with the matching state definitively fails the attempt', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const shellBase = fake.shell.openExternalCalls.length;

      yield* auth.signIn();
      const launched = fake.shell.openExternalCalls[shellBase];
      const state = new URL(launched).searchParams.get('state') ?? '';
      yield* SubscriptionRef.update(deepLinks.pendingOAuth, entries => [
        ...entries,
        { _tag: 'OAuthError' as const, error: 'access_denied', state, receivedAt: Date.now() },
      ]);
      yield* awaitGate(auth, 'signed-out');

      assert.strictEqual(stub.exchangeCalls().length, 0, 'a provider error never exchanges');
      // The slot is cleared — a new flow starts immediately.
      yield* auth.signIn();
      assert.strictEqual(fake.shell.openExternalCalls.length - shellBase, 2);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('OAuthError with an unknown state is rejected+counted; the attempt survives', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer, logger } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* auth.signIn();
      yield* SubscriptionRef.update(deepLinks.pendingOAuth, entries => [
        ...entries,
        {
          _tag: 'OAuthError' as const,
          error: 'access_denied',
          state: 'attacker-state',
          receivedAt: Date.now(),
        },
      ]);
      yield* flush;

      assert.isDefined(logger.find(e => e.message === 'oauth entry rejected'));
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).gate, 'signing-in');
      // The parked attempt survived the unknown-state error untouched.
      assert.strictEqual(yield* auth.pendingAttemptState, expectedState);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('accepts ID token claims from the token endpoint without a signing-key lookup', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler({ exchange: { key: evilKeys.privateKey } }));
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);

      const sessionState = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(sessionState.activeSub, 'user_1');
      assert.strictEqual(sessionState.accounts['user_1']?.email, 'u1@example.com');
      assert.strictEqual(stub.revokeCalls().length, 0);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('missing prismical_first_party is rejected as a sign-in preflight', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler({ exchange: { firstParty: false } }));
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const shellBase = fake.shell.openExternalCalls.length;

      yield* auth.signIn();
      const launched = fake.shell.openExternalCalls[shellBase];
      const state = new URL(launched).searchParams.get('state') ?? '';
      yield* deliverCallback(deepLinks, 'code-1', state);
      yield* awaitGate(auth, 'signed-out');
      assert.deepStrictEqual((yield* SubscriptionRef.get(auth.sessionState)).accounts, {});
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('single-flight refresh: concurrent getIdToken callers share ONE http call', () =>
    Effect.gen(function* () {
      // Exchange hands out a token already inside the 10-minute skew.
      const stub = makeFetchStub(
        happyHandler({ exchange: { expiresIn: 600 }, refresh: { refreshToken: SENTINEL_REFRESH_2 } })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);

      const tokens = yield* Effect.all(
        [auth.getIdToken(), auth.getIdToken(), auth.getIdToken()],
        { concurrency: 'unbounded' }
      );
      assert.strictEqual(stub.refreshCalls().length, 1, 'exactly one refresh HTTP call');
      assert.deepStrictEqual(tokens, [lastMintedIdToken, lastMintedIdToken, lastMintedIdToken]);
      assert.deepStrictEqual(stub.refreshCalls()[0].body, {
        grant_type: 'refresh_token',
        client_id: AUTH.oauthClientId,
        refresh_token: SENTINEL_REFRESH_1,
      });
      assert.notProperty(stub.refreshCalls()[0].body, 'client_secret');
      // Rotation persisted through SecureStore.
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_2);
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).gate, 'signed-in');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a refresh response without refresh_token KEEPS the old refresh token', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(
        happyHandler({ exchange: { expiresIn: 600 }, refresh: { refreshToken: null } })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      yield* auth.getIdToken();
      assert.strictEqual(stub.refreshCalls().length, 1);
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('scheduled refresh fires at the expiry skew under TestClock', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      // Token minted at t≈0 with expires_in 36000s ⇒ due at 35400s (10-min skew).
      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      assert.strictEqual(stub.refreshCalls().length, 0);

      yield* TestClock.adjust(Duration.seconds(35_340));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 0, 'not yet due');

      yield* TestClock.adjust(Duration.seconds(60));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 1, 'fired exactly at expiry-skew');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('powerMonitor resume and window focus force a due-check', () =>
    Effect.gen(function* () {
      // Every response is already inside the skew, so each trigger refreshes.
      const stub = makeFetchStub(
        happyHandler({ exchange: { expiresIn: 600 }, refresh: { expiresIn: 600 } })
      );
      const { layer, windows } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      assert.strictEqual(stub.refreshCalls().length, 0);

      fake.powerMonitor.emit('resume');
      yield* awaitCallCount(stub.refreshCalls, 1, 'resume triggered a re-check');

      windows.offer({ _tag: 'focused', windowId: 1 });
      yield* awaitCallCount(stub.refreshCalls, 2, 'focus triggered a re-check');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('refresh 401 ⇒ definitive: account dropped, secret wiped, never retried', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(async (url, body) => {
        if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
          return jsonResponse(await tokenBody({ expiresIn: 600 }));
        }
        if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
          return jsonResponse({ error: 'invalid_grant' }, 401);
        }
        throw new Error(`unexpected request: ${url}`);
      });
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const exit = yield* Effect.exit(auth.getIdToken());
      assert.strictEqual(failureReason(exit), 'revoked');

      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(state.gate, 'signed-out');
      assert.deepStrictEqual(state.accounts, {});
      assert.isNull(yield* store.getSecret('auth.refreshToken.user_1'), 'secret wiped');
      assert.strictEqual(stub.refreshCalls().length, 1, 'the dead token is never replayed');
      // The account is gone — later callers fail typed without touching HTTP.
      const after = yield* Effect.exit(auth.getIdToken('user_1'));
      assert.strictEqual(failureReason(after), 'unknown-account');
      assert.strictEqual(stub.refreshCalls().length, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('network failure is NOT a sign-out: account kept, secret kept, gate offline', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(async (url, body) => {
        if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
          // Already-expired token so a failed refresh means "no valid token".
          return jsonResponse(await tokenBody({ expiresIn: 0 }));
        }
        if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
          throw new TypeError('fetch failed');
        }
        throw new Error(`unexpected request: ${url}`);
      });
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const exit = yield* Effect.exit(auth.getIdToken());
      assert.strictEqual(failureReason(exit), 'transient');

      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(state.gate, 'offline', 'offline, never a silent sign-out');
      assert.isDefined(state.accounts['user_1'], 'account kept');
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('restart restores securely: rebuild refreshes the active account from SecureStore', () =>
    Effect.gen(function* () {
      const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'prismical-auth-test-')), 'auth.db');

      // --- First run: full sign-in, then the scope closes (app quit). --------
      const firstStub = makeFetchStub(happyHandler());
      const first = build(firstStub, { operationalDbPath: dbPath });
      const firstScope = yield* Scope.make();
      const firstCtx = yield* Layer.build(first.layer).pipe(Scope.extend(firstScope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(firstCtx), Scope.extend(firstScope));
      yield* completeSignIn(
        Context.get(firstCtx, AuthService),
        Context.get(firstCtx, DeepLinks),
        fake.shell.openExternalCalls.length
      );
      yield* Scope.close(firstScope, Exit.void);

      // --- Second run: same profile, tokens re-obtained via refresh. ---------
      const secondStub = makeFetchStub(
        happyHandler({ refresh: { refreshToken: SENTINEL_REFRESH_2 } })
      );
      const second = build(secondStub, { operationalDbPath: dbPath });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(second.layer).pipe(Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const store = Context.get(ctx, SecureStore);

      yield* awaitGate(auth, 'signed-in');
      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(state.activeSub, 'user_1');
      assert.strictEqual(state.accounts['user_1']?.email, 'u1@example.com');
      // The eager restore refresh presented the persisted secret…
      assert.strictEqual(secondStub.refreshCalls().length, 1);
      assert.strictEqual(secondStub.refreshCalls()[0].body['refresh_token'], SENTINEL_REFRESH_1);
      // …and persisted the rotated replacement.
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_2);
      // Tokens are fresh in memory — no extra HTTP for getIdToken.
      assert.strictEqual(yield* auth.getIdToken(), lastMintedIdToken);
      assert.strictEqual(secondStub.refreshCalls().length, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('restart while offline: eager refresh failure keeps the account, gate offline', () =>
    Effect.gen(function* () {
      const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'prismical-auth-test-')), 'auth.db');
      const firstStub = makeFetchStub(happyHandler());
      const first = build(firstStub, { operationalDbPath: dbPath });
      const firstScope = yield* Scope.make();
      const firstCtx = yield* Layer.build(first.layer).pipe(Scope.extend(firstScope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(firstCtx), Scope.extend(firstScope));
      yield* completeSignIn(
        Context.get(firstCtx, AuthService),
        Context.get(firstCtx, DeepLinks),
        fake.shell.openExternalCalls.length
      );
      yield* Scope.close(firstScope, Exit.void);

      const offlineStub = makeFetchStub(() => {
        throw new TypeError('fetch failed');
      });
      const second = build(offlineStub, { operationalDbPath: dbPath });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(second.layer).pipe(Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const store = Context.get(ctx, SecureStore);

      yield* awaitGate(auth, 'offline');
      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.isDefined(state.accounts['user_1'], 'account survives an offline boot');
      assert.strictEqual(state.activeSub, 'user_1');
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // Regression: the earlier logout did not revoke the token server-side.
  it.effect('signOut revokes server-side, wipes the secret, and drops the account', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      yield* auth.signOut();

      const revokes = stub.revokeCalls();
      assert.strictEqual(revokes.length, 1);
      assert.deepStrictEqual(revokes[0].body, {
        token: SENTINEL_REFRESH_1,
        client_id: AUTH.oauthClientId,
      });
      // The SSO-cookie sign-out endpoint is browser-side — never called from main.
      assert.isUndefined(stub.requests.find(r => r.url.includes('/api/auth/sign-out')));
      assert.isNull(yield* store.getSecret('auth.refreshToken.user_1'));
      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(state.gate, 'signed-out');
      assert.deepStrictEqual(state.accounts, {});
      // Idempotent: a second sign-out is a no-op.
      yield* auth.signOut();
      assert.strictEqual(stub.revokeCalls().length, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('setActiveOrg refreshes once for an org the current token predates', () =>
    Effect.gen(function* () {
      // Sign-in mints org_1 only; the refresh mints org_1 + org_2 — i.e. the caller joined
      // org_2 (created it, or accepted an invite) after the token in hand was issued. Before
      // the refresh-on-miss this failed 'invalid-org' and, because the renderer's port is
      // fire-and-forget, the switch silently no-opped and left the user on the old org.
      const stub = makeFetchStub(
        happyHandler({ refresh: { refreshToken: SENTINEL_REFRESH_2, orgIds: ['org_1', 'org_2'] } })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      assert.strictEqual(stub.refreshCalls().length, 0, 'no refresh before the switch');

      yield* auth.setActiveOrg('org_2');
      assert.strictEqual(stub.refreshCalls().length, 1, 'exactly one refresh to re-check');
      assert.strictEqual(
        (yield* SubscriptionRef.get(auth.sessionState)).accounts['user_1']?.activeOrgId,
        'org_2'
      );

      // An org that is absent even from the FRESH claim is a real rejection — and costs one
      // more refresh, never an unbounded retry.
      const stillUnknown = yield* Effect.exit(auth.setActiveOrg('org_absent'));
      assert.strictEqual(failureReason(stillUnknown), 'invalid-org');
      assert.strictEqual(stub.refreshCalls().length, 2, 'one refresh per attempt, not a loop');
      assert.strictEqual(
        (yield* SubscriptionRef.get(auth.sessionState)).accounts['user_1']?.activeOrgId,
        'org_2',
        'a rejected switch leaves the active org untouched'
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('setActiveAccount / setActiveOrg validate against verified state', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);

      yield* auth.setActiveOrg('org_1');
      assert.strictEqual(
        (yield* SubscriptionRef.get(auth.sessionState)).accounts['user_1']?.activeOrgId,
        'org_1'
      );
      const badOrg = yield* Effect.exit(auth.setActiveOrg('org_unknown'));
      assert.strictEqual(failureReason(badOrg), 'invalid-org');
      yield* auth.setActiveOrg(null);
      assert.isUndefined(
        (yield* SubscriptionRef.get(auth.sessionState)).accounts['user_1']?.activeOrgId
      );
      const badAccount = yield* Effect.exit(auth.setActiveAccount('ghost'));
      assert.strictEqual(failureReason(badAccount), 'unknown-account');
      yield* auth.setActiveAccount('user_1');
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).activeSub, 'user_1');
      yield* Scope.close(scope, Exit.void);
    })
  );

  // ---------------------------------------------------------------------------
  // iss/aud verification (OIDC Core §3.1.3.7)
  // ---------------------------------------------------------------------------

  it.effect('a wrong-issuer id_token never becomes a session (exchange path)', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(
        happyHandler({ exchange: { issuer: 'https://evil.test/api/auth' } })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const shellBase = fake.shell.openExternalCalls.length;

      yield* auth.signIn();
      const launched = fake.shell.openExternalCalls[shellBase];
      const state = new URL(launched).searchParams.get('state') ?? '';
      yield* deliverCallback(deepLinks, 'code-1', state);
      yield* awaitGate(auth, 'signed-out');

      assert.deepStrictEqual((yield* SubscriptionRef.get(auth.sessionState)).accounts, {});
      // The untrusted mint was revoked best-effort, like any verify failure.
      assert.strictEqual(stub.revokeCalls().length, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a sibling-client (wrong aud) refresh id_token fails verification; the account is kept', () =>
    Effect.gen(function* () {
      // Same signature keys, same first-party marker — only the audience is a
      // DIFFERENT first-party client. Signature+preflight alone accepts this.
      const stub = makeFetchStub(
        happyHandler({
          exchange: { expiresIn: 0 },
          refresh: { refreshToken: SENTINEL_REFRESH_2, audience: 'prismical-web-client' },
        })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const exit = yield* Effect.exit(auth.getIdToken());
      assert.strictEqual(failureReason(exit), 'verification');
      // Verification failures keep the account — and the rotated token was
      // persisted before verification for zero-grace custody.
      assert.isDefined((yield* SubscriptionRef.get(auth.sessionState)).accounts['user_1']);
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_2);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // ---------------------------------------------------------------------------
  // Refresh-path verification failure (persist-before-
  // verify custody — the implementer-flagged invariant had zero coverage)
  // ---------------------------------------------------------------------------

  it.effect('refresh verify failure: rotated token persisted first, account kept, retry presents only the rotated token', () =>
    Effect.gen(function* () {
      let refreshRound = 0;
      const stub = makeFetchStub(async (url, body) => {
        if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
          return jsonResponse(await tokenBody({ expiresIn: 0 }));
        }
        if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
          refreshRound += 1;
          return refreshRound === 1
            ? // Rotation succeeded server-side, but the returned ID token is expired.
              jsonResponse(
                await tokenBody({ refreshToken: SENTINEL_REFRESH_2, expiresAt: 0 })
              )
            : jsonResponse(await tokenBody({ refreshToken: SENTINEL_REFRESH_3 }));
        }
        throw new Error(`unexpected request: ${url}`);
      });
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const exit = yield* Effect.exit(auth.getIdToken());
      assert.strictEqual(failureReason(exit), 'verification');
      // Account kept (expired memory token ⇒ offline, never a silent sign-out)
      // and the ROTATED token holds custody: the old one is dead server-side.
      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.isDefined(state.accounts['user_1']);
      assert.strictEqual(state.gate, 'offline');
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_2);

      // The retry presents the rotated token — the dead one is NEVER replayed
      // (a replay would trip refresh-family invalidation on every install).
      yield* auth.getIdToken();
      assert.deepStrictEqual(
        stub.refreshCalls().map(call => call.body['refresh_token']),
        [SENTINEL_REFRESH_1, SENTINEL_REFRESH_2]
      );
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_3);
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).gate, 'signed-in');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a wrong-sub refresh id_token fails verification and keeps the account', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(
        happyHandler({
          exchange: { expiresIn: 0 },
          refresh: { sub: 'user_2', refreshToken: SENTINEL_REFRESH_2 },
        })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const exit = yield* Effect.exit(auth.getIdToken());
      assert.strictEqual(failureReason(exit), 'verification');
      assert.isDefined((yield* SubscriptionRef.get(auth.sessionState)).accounts['user_1']);
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_2);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // ---------------------------------------------------------------------------
  // Rotation custody under interruption.
  // ---------------------------------------------------------------------------

  /** Gated refresh: the flight parks on a promise until the test releases it. */
  const gatedRefreshStub = (releasedBody: () => Promise<Record<string, unknown>>) => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const stub = makeFetchStub(async (url, body) => {
      if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
        return jsonResponse(await tokenBody({ expiresIn: 600 }));
      }
      if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
        await gate;
        return jsonResponse(await releasedBody());
      }
      if (url === AUTH.revokeUrl) {
        return jsonResponse({});
      }
      throw new Error(`unexpected request: ${url}`);
    });
    return { stub, release: () => release() };
  };

  it.effect('a dying getIdToken caller never aborts the flight — the rotation still lands in the store', () =>
    Effect.gen(function* () {
      const { stub, release } = gatedRefreshStub(() =>
        tokenBody({ refreshToken: SENTINEL_REFRESH_2 })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const caller = yield* Effect.fork(auth.getIdToken());
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 1, 'flight is on the wire');

      // The caller dies mid-flight (session-scope close / abandoned invoke).
      // The server may already have consumed the old token — the flight MUST
      // complete and persist the replacement, or the next boot replays a dead
      // token and kills the whole refresh-token family.
      yield* Fiber.interrupt(caller);
      release();
      yield* flush;

      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_2);
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).gate, 'signed-in');
      // The committed rotation serves later callers from memory — no new HTTP.
      assert.strictEqual(yield* auth.getIdToken(), lastMintedIdToken);
      assert.strictEqual(stub.refreshCalls().length, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('persist failure after rotation is definitive: new token revoked, account dropped, dead token never replayed', () =>
    Effect.gen(function* () {
      let setSecretAttempts = 0;
      const stub = makeFetchStub(
        happyHandler({ exchange: { expiresIn: 600 }, refresh: { refreshToken: SENTINEL_REFRESH_2 } })
      );
      const { layer, logger } = build(stub, {}, {
        decorateSecureStore: real => ({
          ...real,
          setSecret: (key, value) =>
            value === SENTINEL_REFRESH_2
              ? Effect.sync(() => {
                  setSecretAttempts += 1;
                }).pipe(
                  Effect.zipRight(Effect.fail(new SecureStoreError({ reason: 'unavailable' })))
                )
              : real.setSecret(key, value),
        }),
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const exit = yield* Effect.exit(auth.getIdToken());
      // NOT 'transient': the old token died with the rotation response; a
      // backoff retry would replay it and kill the whole family.
      assert.strictEqual(failureReason(exit), 'persist-failed');
      assert.strictEqual(setSecretAttempts, 3, 'persist re-attempted (bounded) before giving up');
      // The un-persistable NEW token was revoked best-effort; the account
      // dropped cleanly (secret wiped, state cleared).
      assert.deepStrictEqual(
        stub.revokeCalls().map(call => call.body['token']),
        [SENTINEL_REFRESH_2]
      );
      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(state.gate, 'signed-out');
      assert.deepStrictEqual(state.accounts, {});
      assert.isNull(yield* store.getSecret('auth.refreshToken.user_1'));
      assert.isDefined(logger.find(e => e.message === 'account dropped'));

      // NO code path re-sends the dead pre-rotation token.
      const after = yield* Effect.exit(auth.getIdToken('user_1'));
      assert.strictEqual(failureReason(after), 'unknown-account');
      assert.deepStrictEqual(
        stub.refreshCalls().map(call => call.body['refresh_token']),
        [SENTINEL_REFRESH_1]
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('signOut racing an in-flight refresh revokes the just-minted token too', () =>
    Effect.gen(function* () {
      const { stub, release } = gatedRefreshStub(() =>
        tokenBody({ refreshToken: SENTINEL_REFRESH_2 })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const caller = yield* Effect.fork(auth.getIdToken());
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 1, 'flight is on the wire');

      // signOut completes while the rotation response is still in flight: it
      // revokes the (already-consumed) OLD token. The flight must then revoke
      // the NEW one — otherwise a live, never-revoked grant outlives sign-out.
      yield* auth.signOut();
      release();
      yield* awaitCallCount(stub.revokeCalls, 2, 'old and rotated tokens were revoked');

      assert.deepStrictEqual(
        stub.revokeCalls().map(call => call.body['token']),
        [SENTINEL_REFRESH_1, SENTINEL_REFRESH_2]
      );
      // Never resurrected, nothing persisted.
      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(state.gate, 'signed-out');
      assert.deepStrictEqual(state.accounts, {});
      assert.isNull(yield* store.getSecret('auth.refreshToken.user_1'));
      const exit = yield* Effect.exit(Fiber.join(caller));
      assert.strictEqual(failureReason(exit), 'transient');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('interrupting the single-flight winner cannot kill awaiting background fibers', () =>
    Effect.gen(function* () {
      let refreshRound = 0;
      const { stub, release } = gatedRefreshStub(() => {
        refreshRound += 1;
        // Every mint stays inside the skew so each trigger finds it due again.
        return tokenBody({
          expiresIn: 600,
          refreshToken: refreshRound === 1 ? SENTINEL_REFRESH_2 : SENTINEL_REFRESH_3,
        });
      });
      const { layer, windows } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      // Token minted with expires_in 600 s — already inside the skew.
      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const winner = yield* Effect.fork(auth.getIdToken());
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 1, 'flight is on the wire');

      // The focus watcher joins the SAME in-flight Deferred as an awaiter (no
      // clock advance — the flight's 15 s budget must not trip).
      windows.offer({ _tag: 'focused', windowId: 1 });
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 1, 'single flight — no second HTTP call');

      // The winner dies. The Deferred must settle TYPED (success here) — an
      // interrupted exit would propagate interruption into the watcher/
      // scheduler fibers and kill proactive refresh for the process lifetime.
      yield* Fiber.interrupt(winner);
      release();
      yield* flush;
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_2);

      // The watcher survived: a fresh focus event fires the next refresh…
      windows.offer({ _tag: 'focused', windowId: 1 });
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 2, 'focus watcher survived the interrupt');
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_3);
      // …and so did the scheduler (idle-poll wake finds the short token due).
      yield* TestClock.adjust(Duration.seconds(60));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 3, 'scheduler survived the interrupt');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a defecting flight fails awaiters with a typed error, and heals on the next call', () =>
    Effect.gen(function* () {
      let explode = false;
      const stub = makeFetchStub(
        happyHandler({ exchange: { expiresIn: 600 }, refresh: { refreshToken: SENTINEL_REFRESH_2 } })
      );
      const { layer } = build(stub, {}, {
        decorateSecureStore: real => ({
          ...real,
          getSecret: key =>
            explode ? Effect.die(new Error('keychain exploded')) : real.getSecret(key),
        }),
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      explode = true;
      const exit = yield* Effect.exit(auth.getIdToken());
      // A defect must surface as a typed RefreshError, never a Die/interrupt
      // that background awaiters cannot catch.
      assert.strictEqual(failureReason(exit), 'transient');

      // The single-flight slot is not wedged: the next call runs a new flight.
      explode = false;
      yield* auth.getIdToken();
      assert.strictEqual(stub.refreshCalls().length, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('short-TTL tokens pace the scheduler at the sleep floor — no busy-loop storm', () =>
    Effect.gen(function* () {
      // Lifetime (60 s) ≤ the 10-min skew: every fresh token is instantly due.
      const stub = makeFetchStub(
        happyHandler({ exchange: { expiresIn: 60 }, refresh: { expiresIn: 60 } })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      // Scheduler idle-poll wake at t=60 s refreshes once…
      yield* TestClock.adjust(Duration.seconds(60));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 1, 'one refresh per wake, not per round-trip');
      // …then paces at the 1 s floor instead of hammering the endpoint.
      yield* TestClock.adjust(Duration.seconds(1));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 2);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 3);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // ---------------------------------------------------------------------------
  // Backoff machinery.
  // ---------------------------------------------------------------------------

  it.effect('transient scheduled failures back off 30 s doubling to the 10-minute cap', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(async (url, body) => {
        if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
          return jsonResponse(await tokenBody());
        }
        if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
          return jsonResponse({ error: 'internal_error' }, 500);
        }
        throw new Error(`unexpected request: ${url}`);
      });
      const { layer, logger } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      // Token minted at t≈0, expires_in 36000 ⇒ first refresh at t=35400 s.
      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      yield* TestClock.adjust(Duration.seconds(35_400));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 1);

      // 30 s → 60 s → … → capped at 600 s; never a retry before the boundary.
      let expected = 1;
      for (const backoffSeconds of [30, 60, 120, 240, 480, 600, 600]) {
        yield* TestClock.adjust(Duration.seconds(backoffSeconds - 1));
        yield* flush;
        assert.strictEqual(stub.refreshCalls().length, expected, 'no retry before the backoff');
        yield* TestClock.adjust(Duration.seconds(1));
        yield* flush;
        expected += 1;
        assert.strictEqual(stub.refreshCalls().length, expected, 'retry at the backoff boundary');
      }
      const retryLog = logger.entries
        .filter(e => e.message === 'refresh failed transiently — account kept')
        .map(e => (e.data as { retryInMs?: number }).retryInMs);
      assert.deepStrictEqual(
        retryLog,
        [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]
      );
      // The account survives the entire backoff ladder.
      assert.isDefined((yield* SubscriptionRef.get(auth.sessionState)).accounts['user_1']);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('resume/focus force a due-check that ignores backoff; success clears it', () =>
    Effect.gen(function* () {
      let healed = false;
      const stub = makeFetchStub(async (url, body) => {
        if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
          return jsonResponse(await tokenBody({ expiresIn: 600 }));
        }
        if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
          return healed
            ? jsonResponse(await tokenBody({ refreshToken: SENTINEL_REFRESH_2 }))
            : jsonResponse({ error: 'internal_error' }, 500);
        }
        throw new Error(`unexpected request: ${url}`);
      });
      const { layer, logger, windows } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      // Scheduler idle-poll wake fails ⇒ 30 s backoff parked.
      yield* TestClock.adjust(Duration.seconds(60));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 1);

      // Resume re-checks IMMEDIATELY (no clock advance): the network likely
      // changed, waiting out the backoff would be wrong. Still failing ⇒ 60 s.
      fake.powerMonitor.emit('resume');
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 2, 'resume ignored the backoff');

      // Focus re-checks too; the success clears the backoff state entirely.
      healed = true;
      windows.offer({ _tag: 'focused', windowId: 1 });
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 3, 'focus ignored the backoff');
      yield* awaitGate(auth, 'signed-in');
      assert.deepStrictEqual(
        logger.entries
          .filter(e => e.message === 'refresh failed transiently — account kept')
          .map(e => (e.data as { retryInMs?: number }).retryInMs),
        [30_000, 60_000]
      );
      // Cleared: the scheduler's old retry slot fires nothing (fresh token).
      yield* TestClock.adjust(Duration.seconds(120));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 3);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('on-demand getIdToken bypasses the backoff', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(async (url, body) => {
        if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
          return jsonResponse(await tokenBody({ expiresIn: 0 }));
        }
        if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
          return jsonResponse({ error: 'internal_error' }, 500);
        }
        throw new Error(`unexpected request: ${url}`);
      });
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const first = yield* Effect.exit(auth.getIdToken());
      assert.strictEqual(failureReason(first), 'transient');
      assert.strictEqual(stub.refreshCalls().length, 1);

      // A 30 s backoff is parked, but an on-demand WorkspaceBackend caller must
      // not be wedged behind it — it fires its own single flight immediately.
      const second = yield* Effect.exit(auth.getIdToken());
      assert.strictEqual(failureReason(second), 'transient');
      assert.strictEqual(stub.refreshCalls().length, 2, 'getIdToken bypassed the backoff');
      yield* Scope.close(scope, Exit.void);
    })
  );

  // ---------------------------------------------------------------------------
  // Token-endpoint 15 s budget and transient 5xx paths.
  // Deep time lives HERE under TestClock by design — the fake e2e server's
  // 'timeout'/'server-error' refresh behaviors stay unexercised at e2e level.
  // ---------------------------------------------------------------------------

  it.effect('a hung refresh trips the 15 s budget: transient, account kept, backoff armed, later caller un-wedged', () =>
    Effect.gen(function* () {
      let hang = true;
      const stub = makeFetchStub(async (url, body) => {
        if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
          // Already-expired memory token so the failed refresh means offline.
          return jsonResponse(await tokenBody({ expiresIn: 0 }));
        }
        if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
          if (hang) {
            // Never settles — only Effect.timeoutFail in postJson can end this.
            return new Promise<Response>(() => {});
          }
          return jsonResponse(await tokenBody({ refreshToken: SENTINEL_REFRESH_2 }));
        }
        throw new Error(`unexpected request: ${url}`);
      });
      const { layer, logger } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const caller = yield* Effect.fork(Effect.exit(auth.getIdToken()));
      yield* flush;
      assert.strictEqual(stub.refreshCalls().length, 1, 'flight is on the wire');

      // Nothing settles before the budget…
      const budgetMs = Duration.toMillis(TOKEN_REQUEST_TIMEOUT);
      yield* TestClock.adjust(Duration.millis(budgetMs - 1000));
      yield* flush;
      assert.isNull(Option.getOrNull(yield* Fiber.poll(caller)), 'caller still parked inside the budget');
      // …and at the 15 s boundary the budget trips with a TYPED transient failure.
      yield* TestClock.adjust(Duration.seconds(1));
      yield* flush;
      const exit = yield* Fiber.join(caller);
      assert.strictEqual(failureReason(exit), 'transient');

      // Account + secret kept, gate offline — a hung endpoint is not a sign-out.
      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(state.gate, 'offline');
      assert.isDefined(state.accounts['user_1']);
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_1);
      // Backoff armed like any transient failure (30 s base).
      const transientLog = logger.find(
        e => e.message === 'refresh failed transiently — account kept'
      );
      assert.strictEqual((transientLog?.data as { retryInMs?: number }).retryInMs, 30_000);

      // The single-flight slot is NOT wedged behind the abandoned socket: a
      // later on-demand caller fires a fresh flight and recovers.
      hang = false;
      yield* auth.getIdToken();
      assert.strictEqual(stub.refreshCalls().length, 2);
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_2);
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).gate, 'signed-in');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('exchange 500 fails the attempt with the exchange verdict: no account, no code retry, nothing to revoke', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(async (url, body) => {
        if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
          return jsonResponse({ error: 'internal_error' }, 500);
        }
        throw new Error(`unexpected request: ${url}`);
      });
      const { layer, logger } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);
      const shellBase = fake.shell.openExternalCalls.length;

      yield* auth.signIn();
      const launched = fake.shell.openExternalCalls[shellBase];
      const state = new URL(launched).searchParams.get('state') ?? '';
      yield* deliverCallback(deepLinks, 'code-1', state);
      yield* awaitGate(auth, 'signed-out');

      // Codes are single-use: ONE exchange, never retried, flow restarts.
      assert.strictEqual(stub.exchangeCalls().length, 1);
      assert.isDefined(logger.find(e => e.message === 'oauth exchange failed — flow must restart'));
      // No tokens were minted — nothing revoked, nothing persisted, no account.
      assert.strictEqual(stub.revokeCalls().length, 0);
      assert.isNull(yield* store.getSecret('auth.refreshToken.user_1'));
      const sessionState = yield* SubscriptionRef.get(auth.sessionState);
      assert.deepStrictEqual(sessionState.accounts, {});
      assert.isUndefined(sessionState.activeSub);
      // The slot cleared — a fresh signIn starts a new flow immediately.
      yield* auth.signIn();
      assert.strictEqual(fake.shell.openExternalCalls.length - shellBase, 2);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // ---------------------------------------------------------------------------
  // Expired-attempt callback at the live layer.
  // ---------------------------------------------------------------------------

  it.effect('an expired attempt never exchanges: matching late callback is rejected and clears the slot', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer, logger } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* auth.signIn();
      yield* TestClock.adjust(Duration.millis(ATTEMPT_TTL_MS));
      yield* deliverCallback(deepLinks, 'late-code', expectedState);
      yield* flush;

      assert.strictEqual(stub.exchangeCalls().length, 0, 'expired state never exchanges');
      assert.isDefined(logger.find(e => e.message === 'oauth callback rejected — attempt expired'));
      // The matching-but-expired state emptied the slot exactly once —
      // the stale verifier does not linger parked.
      assert.isNull(yield* auth.pendingAttemptState);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // ---------------------------------------------------------------------------
  // Attempt failure with an active account (re-auth-on-
  // top) must never reset the gate to signed-out
  // ---------------------------------------------------------------------------

  it.effect('a failed re-auth attempt reverts the gate to the live account, never signed-out', () =>
    Effect.gen(function* () {
      let exchangeRound = 0;
      const stub = makeFetchStub(async (url, body) => {
        if (url === AUTH.tokenUrl && body['grant_type'] === 'authorization_code') {
          exchangeRound += 1;
          return exchangeRound === 1
            ? jsonResponse(await tokenBody({ expiresIn: 0 }))
            : jsonResponse({ error: 'internal_error' }, 500);
        }
        if (url === AUTH.tokenUrl && body['grant_type'] === 'refresh_token') {
          throw new TypeError('fetch failed');
        }
        throw new Error(`unexpected request: ${url}`);
      });
      const { layer, logger } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      // Active account A goes offline (transient IdP outage).
      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      yield* Effect.exit(auth.getIdToken());
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).gate, 'offline');

      // Re-auth on top: the browser flow runs while A's session lives.
      yield* auth.signIn();
      assert.strictEqual((yield* SubscriptionRef.get(auth.sessionState)).gate, 'signing-in');
      const state1 = String(yield* auth.pendingAttemptState);
      yield* SubscriptionRef.update(deepLinks.pendingOAuth, entries => [
        ...entries,
        { _tag: 'OAuthError' as const, error: 'access_denied', state: state1, receivedAt: Date.now() },
      ]);
      yield* awaitGate(auth, 'offline');
      // A's account and session survive — the failure only ended the ATTEMPT.
      const afterError = yield* SubscriptionRef.get(auth.sessionState);
      assert.isDefined(afterError.accounts['user_1']);
      assert.strictEqual(afterError.activeSub, 'user_1');

      // Same contract on the exchange-failure arm.
      yield* auth.signIn();
      const state2 = String(yield* auth.pendingAttemptState);
      yield* deliverCallback(deepLinks, 'code-2', state2);
      yield* awaitGate(auth, 'offline');
      assert.isDefined((yield* SubscriptionRef.get(auth.sessionState)).accounts['user_1']);
      assert.isDefined(logger.find(e => e.message === 'oauth exchange failed — flow must restart'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  // ---------------------------------------------------------------------------
  // completeExchange post-mint local failures.
  // ---------------------------------------------------------------------------

  it.effect('exchange setSecret failure revokes the minted refresh token and reports persist-failed', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer, logger } = build(stub, {}, {
        decorateSecureStore: real => ({
          ...real,
          setSecret: () => Effect.fail(new SecureStoreError({ reason: 'unavailable' })),
        }),
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);
      const shellBase = fake.shell.openExternalCalls.length;

      yield* auth.signIn();
      const launched = fake.shell.openExternalCalls[shellBase];
      const state = new URL(launched).searchParams.get('state') ?? '';
      yield* deliverCallback(deepLinks, 'code-1', state);
      yield* awaitGate(auth, 'signed-out');

      // The mint we could not take custody of was revoked — no live 90-day
      // family lingers server-side with no client holding it.
      assert.deepStrictEqual(
        stub.revokeCalls().map(call => call.body['token']),
        [SENTINEL_REFRESH_1]
      );
      assert.deepStrictEqual((yield* SubscriptionRef.get(auth.sessionState)).accounts, {});
      assert.isNull(yield* store.getSecret('auth.refreshToken.user_1'));
      // Truthful verdict: NOT an exchange failure — the exchange succeeded.
      assert.isDefined(
        logger.find(e => e.message === 'sign-in could not be committed locally — flow must restart')
      );
      assert.isUndefined(logger.find(e => e.message === 'oauth exchange failed — flow must restart'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('an index write failure after a committed sign-in degrades to a warning — the user is signed in', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer, logger } = build(stub, {}, {
        decorateDb: real => ({
          ...real,
          setSetting: (key, value) =>
            key === ACCOUNT_INDEX_KEY
              ? Effect.fail(new DbError({ op: 'setSetting', cause: 'injected index failure' }))
              : real.setSetting(key, value),
        }),
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const store = Context.get(ctx, SecureStore);

      // Sign-in is committed (secret + state) before the index write: its
      // failure must not fail a succeeded sign-in into 'exchange-failed'.
      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const state = yield* SubscriptionRef.get(auth.sessionState);
      assert.strictEqual(state.gate, 'signed-in');
      assert.isDefined(state.accounts['user_1']);
      assert.strictEqual(yield* store.getSecret('auth.refreshToken.user_1'), SENTINEL_REFRESH_1);
      assert.isDefined(logger.find(e => e.message === 'sign-in complete'));
      assert.isDefined(logger.find(e => e.message === 'account index write failed'));
      assert.isUndefined(logger.find(e => e.message === 'oauth exchange failed — flow must restart'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  // ---------------------------------------------------------------------------
  // signOut storage-failure ordering.
  // ---------------------------------------------------------------------------

  it.effect('signOut with a failing secret wipe still resolves: index rewritten, orphan logged loudly', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(happyHandler());
      const { layer, logger } = build(stub, {}, {
        decorateSecureStore: real => ({
          ...real,
          deleteSecret: () =>
            Effect.fail(new DbError({ op: 'deleteSetting', cause: 'injected wipe failure' })),
        }),
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const db = Context.get(ctx, OperationalDb);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      // The invoke resolves truthfully — the renderer already shows signed-out
      // and a rejection would offer a retry that no-ops (idempotency guard).
      const exit = yield* Effect.exit(auth.signOut());
      assert.isTrue(Exit.isSuccess(exit));

      // Revoked server-side, and the persisted index no longer restores the
      // account — the wipe failure cannot resurrect it on the next launch.
      assert.strictEqual(stub.revokeCalls().length, 1);
      const index = yield* db.getSetting(ACCOUNT_INDEX_KEY);
      assert.deepStrictEqual(JSON.parse(String(index)), {
        version: 1,
        activeSub: null,
        accounts: [],
      });
      // The orphaned (index-less, encrypted) secret is loudly greppable.
      assert.isDefined(
        logger.find(e => e.message === 'sign-out left an orphaned refresh-token secret on disk')
      );
      // Idempotent: a retried signOut is a clean no-op.
      yield* auth.signOut();
      assert.strictEqual(stub.revokeCalls().length, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // Regression: the earlier app persisted the whole token response into an app_settings row.
  it.effect('no plaintext token strings in the operational DB', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(
        happyHandler({ exchange: { expiresIn: 600 }, refresh: { refreshToken: SENTINEL_REFRESH_2 } })
      );
      const { layer } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);
      const db = Context.get(ctx, OperationalDb);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const exchangedIdToken = lastMintedIdToken;
      yield* auth.getIdToken(); // refresh too — rotation must also stay ciphertext
      const refreshedIdToken = lastMintedIdToken;

      const rows = yield* Effect.promise(() => db.db.select().from(dbSchema.settings));
      assert.isAtLeast(rows.length, 2, 'index + secret rows exist');
      const dump = JSON.stringify(rows);
      assert.notInclude(dump, SENTINEL_REFRESH_1);
      assert.notInclude(dump, SENTINEL_REFRESH_2);
      assert.notInclude(dump, SENTINEL_ACCESS);
      assert.notInclude(dump, exchangedIdToken);
      assert.notInclude(dump, refreshedIdToken);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // Regression: the earlier app logged the full token response and authorize URL.
  it.effect('no token strings in captured logs during sign-in and refresh', () =>
    Effect.gen(function* () {
      const stub = makeFetchStub(
        happyHandler({ exchange: { expiresIn: 600 }, refresh: { refreshToken: SENTINEL_REFRESH_2 } })
      );
      const { layer, logger } = build(stub);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runAuthConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      const auth = Context.get(ctx, AuthService);
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* completeSignIn(auth, deepLinks, fake.shell.openExternalCalls.length);
      const exchangedIdToken = lastMintedIdToken;
      yield* auth.getIdToken();
      const refreshedIdToken = lastMintedIdToken;

      const dump = JSON.stringify(logger.entries);
      assert.notInclude(dump, SENTINEL_REFRESH_1);
      assert.notInclude(dump, SENTINEL_REFRESH_2);
      assert.notInclude(dump, SENTINEL_ACCESS);
      assert.notInclude(dump, exchangedIdToken);
      assert.notInclude(dump, refreshedIdToken);
      assert.notInclude(dump, expectedVerifier, 'PKCE verifier never logged');
      yield* Scope.close(scope, Exit.void);
    })
  );
});
