/**
 * WorkspaceBackend and session-current accessor tests.
 *
 * Two layers of coverage:
 *  - makeWorkspaceBackendRequest (pure, injected FetchLike + resolveIdentity): the
 *    envelope mapping (2xx/4xx/5xx/network/timeout/non-JSON), header stamping
 *    (Bearer + x-active-org-id incl. the org-absent omission + Content-Type on
 *    bodied methods), URL/query building, and identity-failure short-circuit.
 *  - WorkspaceTransportLive + makeCloudWorkspaceLayer (integration): the boot↔session
 *    bridge — register publishes the client, `current`/`request` fold the
 *    signed-out case onto INTERNAL, the finalizer clears on scope close, and the
 *    StaleSessionError guard blocks a request under a switched-away identity
 *    BEFORE any fetch.
 */
import { assert, describe, it } from '@effect/vitest';
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
  SubscriptionRef,
  TestClock,
} from 'effect';
import { afterEach, vi } from 'vitest';
import {
  describeAiError,
  encodeAskStreamError,
  parseAskStreamError,
} from '@prismical/api-contracts';
import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';
import {
  makeTestLogger,
  recordingLaneStub,
  testConfigLayer,
  testI18nLayer,
} from '../helpers/test-layers';
import {
  makeWorkspaceBackendRequest,
  makeOpenAskStream,
  WorkspaceTransportLive,
  REQUEST_TIMEOUT,
  type FetchLike,
  type RequestIdentity,
} from '../../src/main/domains/transport/live';
import { RecordingBridgeLive } from '../../src/main/domains/recording/bridge';
import { DetectionBridgeLive } from '../../src/main/domains/detection/bridge';
import { EventKitBridgeLive } from '../../src/main/domains/eventkit/bridge';
import { CollabBridgeLive } from '../../src/main/domains/collab/store-live';
import { OperationalDbLive } from '../../src/main/infra/operational-db/live';
import {
  AskStreamError,
  WorkspaceBackend,
  WorkspaceTransport,
  type WorkspaceBackendApi,
} from '../../src/main/domains/transport/service';
import {
  AuthService,
  AuthStateError,
  RefreshError,
  type AuthApi,
} from '../../src/main/domains/auth/service';
import {
  initialAuthState,
  type AuthAccountView,
  type AuthState,
} from '../../src/main/domains/auth/policy';
import {
  makeCloudWorkspaceLayer,
  StaleSessionError,
  type PinnedSession,
} from '../../src/main/runtime/workspace-layer';
import { workspaceEnvStubs } from '../helpers/fake-workspace-env';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array | FormData;
}

/** A FetchLike that records every call and returns a configurable Response. */
const recordingFetch = (respond: () => Promise<Response>) => {
  const calls: FetchCall[] = [];
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    return respond();
  };
  return { calls, fetchFn };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DEFAULT_IDENTITY: RequestIdentity = { idToken: 'ID-TOKEN', activeOrgId: undefined };

const runRequest = (opts: {
  readonly fetchFn: FetchLike;
  readonly req: TransportRequest;
  readonly identity?: RequestIdentity;
  readonly resolveIdentity?: Effect.Effect<
    RequestIdentity,
    StaleSessionError | RefreshError | AuthStateError
  >;
  readonly coreApiUrl?: string;
}): Effect.Effect<TransportResponse> =>
  makeWorkspaceBackendRequest({
    coreApiUrl: opts.coreApiUrl ?? 'https://core.test',
    fetchFn: opts.fetchFn,
    resolveIdentity: opts.resolveIdentity ?? Effect.succeed(opts.identity ?? DEFAULT_IDENTITY),
  })(opts.req);

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

const makeAuthStub = Effect.gen(function* () {
  const sessionState = yield* SubscriptionRef.make<AuthState>(initialAuthState);
  const api: AuthApi = {
    sessionState,
    signIn: () => Effect.void,
    signOut: () => Effect.void,
    setActiveAccount: () => Effect.void,
    setActiveOrg: () => Effect.void,
    getIdToken: sub => Effect.succeed(`idtoken-${sub ?? '(active)'}`),
    openWebSession: () => Effect.void,
    consumePendingEntry: () => Effect.succeed('rejected' as const),
    pendingAttemptState: Effect.succeed(null),
    pendingAttemptAuthorizeUrl: Effect.succeed(null),
  };
  return { api, sessionState };
});

// ---------------------------------------------------------------------------
// makeWorkspaceBackendRequest — envelope mapping + header stamping (injected fetch)
// ---------------------------------------------------------------------------

describe('makeWorkspaceBackendRequest (envelope mapping)', () => {
  it.effect('a 2xx exchange → {ok,status,bodyJson}', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse({ results: [1, 2] })));
      const res = yield* runRequest({ fetchFn, req: { method: 'GET', path: '/apps/v1/me/notes' } });
      assert.deepStrictEqual(res, { ok: true, status: 200, bodyJson: { results: [1, 2] } });
    })
  );

  it.effect('a 401 is carried through (status preserved so onUnauthorized fires)', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401))
      );
      const res = yield* runRequest({ fetchFn, req: { method: 'GET', path: '/apps/v1/me' } });
      assert.deepStrictEqual(res, {
        ok: true,
        status: 401,
        bodyJson: { error: { code: 'UNAUTHORIZED' } },
      });
    })
  );

  it.effect('a 500 is carried through as a completed exchange, not a transport error', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ error: 'boom' }, 500))
      );
      const res = yield* runRequest({ fetchFn, req: { method: 'GET', path: '/apps/v1/me' } });
      assert.deepStrictEqual(res, { ok: true, status: 500, bodyJson: { error: 'boom' } });
    })
  );

  it.effect('a non-JSON body settles bodyJson null while carrying the status', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() =>
        Promise.resolve(new Response('<html>oops</html>', { status: 502 }))
      );
      const res = yield* runRequest({ fetchFn, req: { method: 'GET', path: '/apps/v1/me' } });
      assert.deepStrictEqual(res, { ok: true, status: 502, bodyJson: null });
    })
  );

  it.effect('a network failure → INTERNAL', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() => Promise.reject(new Error('ECONNREFUSED')));
      const res = yield* runRequest({ fetchFn, req: { method: 'GET', path: '/apps/v1/me' } });
      assert.deepStrictEqual(res, { error: { code: 'INTERNAL' } });
    })
  );

  it.effect('a malformed successful body cannot acknowledge a REST write', () =>
    Effect.gen(function* () {
      const result = yield* runRequest({
        fetchFn: () => Promise.resolve(new Response('{"result":')),
        req: { method: 'POST', path: '/apps/v1/me/transcript-segments', body: {} },
      });
      assert.deepStrictEqual(result, { error: { code: 'INTERNAL' } });
    })
  );

  it.effect('a hung fetch trips the 15s budget → INTERNAL', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() => new Promise<Response>(() => {}));
      const fiber = yield* Effect.fork(
        runRequest({ fetchFn, req: { method: 'GET', path: '/apps/v1/me' } })
      );
      yield* TestClock.adjust(REQUEST_TIMEOUT);
      const res = yield* Fiber.join(fiber);
      assert.deepStrictEqual(res, { error: { code: 'INTERNAL' } });
    })
  );

  it.effect('a stalled response body shares the request deadline and abort signal', () =>
    Effect.gen(function* () {
      const readingBody = yield* Deferred.make<void>();
      let signal: AbortSignal | undefined;
      const response = new Response();
      response.json = () => {
        Deferred.unsafeDone(readingBody, Effect.void);
        return new Promise(() => {});
      };
      const fiber = yield* Effect.fork(runRequest({
        fetchFn: (_url, init) => {
          signal = init.signal;
          return Promise.resolve(response);
        },
        req: { method: 'GET', path: '/apps/v1/me' },
      }));
      yield* Deferred.await(readingBody);
      yield* TestClock.adjust(REQUEST_TIMEOUT);
      assert.isTrue(Option.isSome(yield* Fiber.poll(fiber)), 'the body shares the request deadline');
      assert.deepStrictEqual(yield* Fiber.join(fiber), { error: { code: 'INTERNAL' } });
      assert.isTrue(signal?.aborted);
    })
  );

  it.effect('an identity failure (stale/refresh) → INTERNAL and NEVER fetches', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse({})));
      const res = yield* runRequest({
        fetchFn,
        resolveIdentity: Effect.fail(new AuthStateError({ reason: 'no-active-account' })),
        req: { method: 'GET', path: '/apps/v1/me' },
      });
      assert.deepStrictEqual(res, { error: { code: 'INTERNAL' } });
      assert.strictEqual(calls.length, 0, 'no request goes out under a failed identity');
    })
  );
});

describe('makeWorkspaceBackendRequest (header + URL stamping)', () => {
  it.effect('stamps Bearer + x-active-org-id when an active org is present', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse({})));
      yield* runRequest({
        fetchFn,
        identity: { idToken: 'ID-TOKEN-123', activeOrgId: 'org_9' },
        req: { method: 'GET', path: '/apps/v1/me/notes' },
      });
      assert.strictEqual(calls[0].headers['Authorization'], 'Bearer ID-TOKEN-123');
      assert.strictEqual(calls[0].headers['x-active-org-id'], 'org_9');
      // GET carries no body → no Content-Type.
      assert.isUndefined(calls[0].headers['Content-Type']);
    })
  );

  it.effect('OMITS x-active-org-id entirely when no active org (server resolves default)', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse({})));
      yield* runRequest({
        fetchFn,
        identity: { idToken: 'T', activeOrgId: undefined },
        req: { method: 'GET', path: '/apps/v1/me' },
      });
      assert.strictEqual(calls[0].headers['Authorization'], 'Bearer T');
      assert.notProperty(calls[0].headers, 'x-active-org-id');
    })
  );

  it.effect('a bodied method stamps Content-Type + a JSON body; query builds the URL', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ result: {} }))
      );
      yield* runRequest({
        fetchFn,
        identity: { idToken: 'T', activeOrgId: 'org_1' },
        req: {
          method: 'POST',
          path: '/apps/v1/me/notes',
          body: { title: 'x' },
          query: { includeBody: 'true' },
        },
      });
      assert.strictEqual(calls[0].method, 'POST');
      assert.strictEqual(calls[0].url, 'https://core.test/apps/v1/me/notes?includeBody=true');
      assert.strictEqual(calls[0].headers['Content-Type'], 'application/json');
      assert.strictEqual(calls[0].body, JSON.stringify({ title: 'x' }));
    })
  );

  it.effect('no query → a bare path URL', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse({})));
      yield* runRequest({ fetchFn, req: { method: 'GET', path: '/apps/v1/me' } });
      assert.strictEqual(calls[0].url, 'https://core.test/apps/v1/me');
    })
  );
});

// ---------------------------------------------------------------------------
// makeOpenAskStream — the Ask streaming lane opener
// ---------------------------------------------------------------------------

const runOpen = (opts: {
  readonly fetchFn: FetchLike;
  readonly body?: unknown;
  readonly locale?: string;
  readonly identity?: RequestIdentity;
  readonly resolveIdentity?: Effect.Effect<
    RequestIdentity,
    StaleSessionError | RefreshError | AuthStateError
  >;
}): Effect.Effect<Response, AskStreamError> =>
  makeOpenAskStream({
    coreApiUrl: 'https://core.test',
    locale: opts.locale,
    fetchFn: opts.fetchFn,
    resolveIdentity: opts.resolveIdentity ?? Effect.succeed(opts.identity ?? DEFAULT_IDENTITY),
  })(opts.body ?? { messages: [] });

const sseResponse = (): Response =>
  new Response('data: {"type":"start"}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });

const readAskFailure = (response: Response) =>
  Effect.promise(async () => {
    const sse = await response.text();
    const parts = sse
      .split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)) as { type: string; errorText?: string });
    const errorText = parts.find(part => part.type === 'error')?.errorText;
    assert.isString(errorText);
    assert.notInclude(errorText!, 'PRIVATE_');
    const parsed = parseAskStreamError(errorText);
    assert.isNotNull(parsed);
    return parsed!.prismicalError;
  });

describe('makeOpenAskStream (Ask lane)', () => {
  it.effect('POSTs /apps/v1/me/ask with Bearer + org + SSE headers and the JSON body', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(sseResponse()));
      const body = { messages: [{ role: 'user', content: 'hi' }] };
      const res = yield* runOpen({
        fetchFn,
        identity: { idToken: 'ASK-TOKEN', activeOrgId: 'org_7' },
        locale: 'de',
        body,
      });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].method, 'POST');
      assert.strictEqual(calls[0].url, 'https://core.test/apps/v1/me/ask');
      assert.strictEqual(calls[0].headers['Authorization'], 'Bearer ASK-TOKEN');
      assert.strictEqual(calls[0].headers['x-active-org-id'], 'org_7');
      assert.strictEqual(calls[0].headers['Content-Type'], 'application/json');
      assert.strictEqual(calls[0].headers['Accept'], 'text/event-stream');
      assert.strictEqual(calls[0].headers['x-prismical-ask-error-format'], 'envelope');
      assert.strictEqual(calls[0].headers['x-prismical-locale'], 'de');
      assert.strictEqual(calls[0].headers['Accept-Language'], 'de');
      assert.strictEqual(calls[0].body, JSON.stringify(body));
      // The raw SSE Response is handed back untouched (the broker forwards it).
      assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
    })
  );

  it.effect('OMITS x-active-org-id when no active org (server resolves default)', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(sseResponse()));
      yield* runOpen({ fetchFn, identity: { idToken: 'T', activeOrgId: undefined } });
      assert.strictEqual(calls[0].headers['Authorization'], 'Bearer T');
      assert.notProperty(calls[0].headers, 'x-active-org-id');
    })
  );

  it.effect('a stale/failed identity → AskStreamError(no-identity) and NEVER fetches', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(sseResponse()));
      const error = yield* runOpen({
        fetchFn,
        resolveIdentity: Effect.fail(
          new StaleSessionError({ pinnedSub: 'user_1', reason: 'org-switched' })
        ),
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, 'AskStreamError');
      assert.strictEqual(error.reason, 'no-identity');
      assert.strictEqual(calls.length, 0, 'no stream opens under a stale identity');
    })
  );

  it.effect('a connection failure becomes a localized envelope error part', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() => Promise.reject(new Error('ECONNREFUSED')));
      const response = yield* runOpen({ fetchFn, locale: 'de' });
      const failure = yield* readAskFailure(response);
      assert.strictEqual(failure.code, 'ASK_REQUEST_FAILED');
      assert.strictEqual(failure.details?.user?.title, 'Ask AI konnte nicht antworten.');
      assert.deepStrictEqual(
        failure.details?.user?.actions.map(action => action.kind),
        ['retry']
      );
    })
  );

  it.effect('preserves a core pre-stream error envelope and its recovery actions over SSE', () =>
    Effect.gen(function* () {
      const details = {
        lane: 'your-key' as const,
        provider: 'openai',
        retryable: false,
        user: describeAiError({
          code: 'PROVIDER_KEY_INVALID',
          details: { lane: 'your-key', provider: 'openai' },
          locale: 'ja',
          surface: 'ask',
        }),
      };
      const { fetchFn } = recordingFetch(() =>
        Promise.resolve(
          jsonResponse(
            {
              error: { code: 'PROVIDER_KEY_INVALID', message: 'PRIVATE_PROVIDER_PROSE', details },
            },
            422
          )
        )
      );
      const response = yield* runOpen({ fetchFn });
      assert.strictEqual(response.status, 200);
      assert.include(response.headers.get('content-type') ?? '', 'text/event-stream');
      assert.deepStrictEqual(yield* readAskFailure(response), {
        code: 'PROVIDER_KEY_INVALID',
        details,
      });
    })
  );

  it.effect('an HTML gateway failure produces safe fallback copy', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() =>
        Promise.resolve(new Response('<html>PRIVATE_GATEWAY_DETAIL</html>', { status: 502 }))
      );
      const failure = yield* readAskFailure(yield* runOpen({ fetchFn }));
      assert.strictEqual(failure.code, 'ASK_REQUEST_FAILED');
      assert.strictEqual(failure.details?.user?.title, 'Ask AI couldn’t answer.');
    })
  );

  it.effect('core streaming envelopes pass through byte-for-byte', () =>
    Effect.gen(function* () {
      const wire =
        'data: ' +
        JSON.stringify({
          type: 'error',
          errorText: encodeAskStreamError('PROVIDER_RATE_LIMITED', { retryAfterMs: 7000 }),
        }) +
        '\n\n';
      const upstream = new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
      const { fetchFn } = recordingFetch(() => Promise.resolve(upstream));
      const response = yield* runOpen({ fetchFn });
      assert.strictEqual(response, upstream);
      assert.strictEqual(yield* Effect.promise(() => response.text()), wire);
    })
  );
});

// ---------------------------------------------------------------------------
// WorkspaceTransport accessor — the boot-scoped session-current bridge
// ---------------------------------------------------------------------------

const stubClient = (
  response: TransportResponse,
  collabToken: Effect.Effect<
    string,
    StaleSessionError | RefreshError | AuthStateError
  > = Effect.succeed('STUB-ID-TOKEN')
): WorkspaceBackendApi => ({
  request: () => Effect.succeed(response),
  openAskStream: () => Effect.succeed(new Response(null)),
  collabToken,
  ...recordingLaneStub,
});

describe('WorkspaceTransport (session-current accessor)', () => {
  it.effect('with no live session: current is None and request settles INTERNAL', () =>
    Effect.gen(function* () {
      const ct = yield* WorkspaceTransport;
      assert.isTrue(Option.isNone(yield* ct.current));
      assert.deepStrictEqual(yield* ct.request({ method: 'GET', path: '/apps/v1/me' }), {
        error: { code: 'INTERNAL' },
      });
    }).pipe(Effect.provide(WorkspaceTransportLive))
  );

  it.effect('register publishes the client; the finalizer clears it on scope close', () =>
    Effect.gen(function* () {
      const ct = yield* WorkspaceTransport;
      const client = stubClient({ ok: true, status: 200, bodyJson: 'X' });
      const scope = yield* Scope.make();
      yield* ct.register(client).pipe(Scope.extend(scope));

      assert.isTrue(Option.isSome(yield* ct.current));
      assert.deepStrictEqual(yield* ct.request({ method: 'GET', path: '/apps/v1/me' }), {
        ok: true,
        status: 200,
        bodyJson: 'X',
      });

      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Option.isNone(yield* ct.current));
      assert.deepStrictEqual(yield* ct.request({ method: 'GET', path: '/apps/v1/me' }), {
        error: { code: 'INTERNAL' },
      });
    }).pipe(Effect.provide(WorkspaceTransportLive))
  );

  it.effect(
    'compare-and-clear: a late release from an old session does not clobber a newer one',
    () =>
      Effect.gen(function* () {
        const ct = yield* WorkspaceTransport;
        const clientA = stubClient({ ok: true, status: 200, bodyJson: 'A' });
        const clientB = stubClient({ ok: true, status: 200, bodyJson: 'B' });
        const scopeA = yield* Scope.make();
        const scopeB = yield* Scope.make();

        // A registers, then B registers on top (the swap: the successor is current).
        yield* ct.register(clientA).pipe(Scope.extend(scopeA));
        yield* ct.register(clientB).pipe(Scope.extend(scopeB));
        assert.deepStrictEqual(yield* ct.request({ method: 'GET', path: '/apps/v1/me' }), {
          ok: true,
          status: 200,
          bodyJson: 'B',
        });

        // A's scope closes LATE (the slow-old-close race): its release must NOT
        // clear B — compare-and-clear leaves the live successor intact.
        yield* Scope.close(scopeA, Exit.void);
        assert.isTrue(Option.isSome(yield* ct.current));
        assert.deepStrictEqual(yield* ct.request({ method: 'GET', path: '/apps/v1/me' }), {
          ok: true,
          status: 200,
          bodyJson: 'B',
        });

        // B's own close still clears — it IS the current client.
        yield* Scope.close(scopeB, Exit.void);
        assert.isTrue(Option.isNone(yield* ct.current));
      }).pipe(Effect.provide(WorkspaceTransportLive))
  );

  it.effect('collabToken: None with no live session', () =>
    Effect.gen(function* () {
      const ct = yield* WorkspaceTransport;
      assert.isTrue(Option.isNone(yield* ct.collabToken));
    }).pipe(Effect.provide(WorkspaceTransportLive))
  );

  it.effect(
    "collabToken: the registered client's guarded id_token; a guard failure folds to None; cleared on teardown",
    () =>
      Effect.gen(function* () {
        const ct = yield* WorkspaceTransport;

        // A valid session publishes its guarded id_token — the sanctioned exception.
        const scope = yield* Scope.make();
        yield* ct
          .register(stubClient({ error: { code: 'INTERNAL' } }, Effect.succeed('FRESH-ID-TOKEN')))
          .pipe(Scope.extend(scope));
        assert.deepStrictEqual(yield* ct.collabToken, Option.some('FRESH-ID-TOKEN'));
        yield* Scope.close(scope, Exit.void);
        assert.isTrue(Option.isNone(yield* ct.collabToken));

        // A client whose guard fails (switched-away identity) folds to None so the
        // handler answers null instead of throwing — never a raw StaleSessionError.
        const staleScope = yield* Scope.make();
        yield* ct
          .register(
            stubClient(
              { error: { code: 'INTERNAL' } },
              Effect.fail(new StaleSessionError({ pinnedSub: 'user_1', reason: 'org-switched' }))
            )
          )
          .pipe(Scope.extend(staleScope));
        assert.isTrue(Option.isNone(yield* ct.collabToken));
        yield* Scope.close(staleScope, Exit.void);
      }).pipe(Effect.provide(WorkspaceTransportLive))
  );
});

// ---------------------------------------------------------------------------
// Integration: makeCloudWorkspaceLayer wires the WorkspaceBackend + preserves the guard
// ---------------------------------------------------------------------------

describe('makeCloudWorkspaceLayer → WorkspaceBackend (boot↔session bridge)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect(
    'publishes a guarded WorkspaceBackend: fetches when valid, blocks when stale, clears on teardown',
    () =>
      Effect.gen(function* () {
        const stamped: Array<{ auth: string; org: string | undefined }> = [];
        vi.stubGlobal('fetch', (_url: string, init: { headers: Record<string, string> }) => {
          stamped.push({
            auth: init.headers['Authorization'],
            org: init.headers['x-active-org-id'],
          });
          return Promise.resolve(jsonResponse({ results: [] }));
        });

        const logger = makeTestLogger();
        const stub = yield* makeAuthStub;
        yield* SubscriptionRef.set(
          stub.sessionState,
          authState('signed-in', [account('user_1', 'org_a')], 'user_1')
        );
        const env = Layer.mergeAll(
          testI18nLayer(),
          Layer.succeed(AuthService, stub.api),
          logger.layer,
          testConfigLayer({
            platform: 'linux',
            endpoints: {
              coreApiUrl: 'https://core.test',
              noteWsUrl: 'wss://note.test/collaboration',
              webAppOrigin: 'https://app.test',
              analyticsKey: null,
              analyticsHost: null,
            },
          }),
          WorkspaceTransportLive,
          OperationalDbLive.pipe(Layer.provide(testConfigLayer()), Layer.provide(logger.layer)),
          RecordingBridgeLive,
          DetectionBridgeLive,
          EventKitBridgeLive,
          CollabBridgeLive,
          // The workspace environment carries the transcription-engine inputs.
          workspaceEnvStubs('cloud')
        );
        const pinned: PinnedSession = {
          sub: 'user_1',
          email: 'user_1@example.com',
          activeOrgId: 'org_a',
        };
        const scope = yield* Scope.make();
        // Build the boot env first so we hold the SAME WorkspaceTransport the session's
        // WorkspaceBackend registers into, then build the session layer under it.
        const envCtx = yield* Layer.build(env).pipe(Scope.extend(scope));
        const ct = Context.get(envCtx, WorkspaceTransport);
        const sessionCtx = yield* Layer.build(makeCloudWorkspaceLayer(pinned)).pipe(
          Effect.provide(envCtx),
          Scope.extend(scope)
        );
        // The WorkspaceBackend tag is in the session context too (self-published above).
        assert.isDefined(Context.get(sessionCtx, WorkspaceBackend));

        // A valid session: the accessor holds the client and a request fetches
        // the server with the guarded id_token and active-org header stamped in main.
        assert.isTrue(Option.isSome(yield* ct.current));
        const ok = yield* ct.request({ method: 'GET', path: '/apps/v1/me/notes' });
        assert.deepStrictEqual(ok, { ok: true, status: 200, bodyJson: { results: [] } });
        assert.strictEqual(stamped.length, 1);
        assert.deepStrictEqual(stamped[0], { auth: 'Bearer idtoken-user_1', org: 'org_a' });

        // The collaboration bearer resolves the same guarded id_token — the one
        // sanctioned full-token crossing. No fetch is involved.
        assert.deepStrictEqual(yield* ct.collabToken, Option.some('idtoken-user_1'));

        // Org switched away ⇒ the SignedInSession guard fails StaleSessionError
        // and the request settles INTERNAL WITHOUT reaching the wire.
        yield* SubscriptionRef.set(
          stub.sessionState,
          authState('signed-in', [account('user_1', 'org_b')], 'user_1')
        );
        const stale = yield* ct.request({ method: 'GET', path: '/apps/v1/me/notes' });
        assert.deepStrictEqual(stale, { error: { code: 'INTERNAL' } });
        assert.strictEqual(stamped.length, 1, 'no fetch under a stale session');

        // …and the collab bearer folds the same guard failure to None (→ null).
        assert.isTrue(Option.isNone(yield* ct.collabToken));

        // Teardown clears the accessor (a signed-out request is graceful again).
        yield* Scope.close(scope, Exit.void);
        assert.isTrue(Option.isNone(yield* ct.current));
        assert.isTrue(Option.isNone(yield* ct.collabToken));
        assert.deepStrictEqual(yield* ct.request({ method: 'GET', path: '/apps/v1/me/notes' }), {
          error: { code: 'INTERNAL' },
        });
      })
  );

  it.effect(
    'the cloud recording lane rides the same guard and org stamp: creates/uploads when valid, blocks when stale',
    () =>
      Effect.gen(function* () {
        interface Wire {
          readonly url: string;
          readonly method: string;
          readonly auth: string;
          readonly org: string | undefined;
          readonly contentType: string;
          readonly body?: string | Uint8Array;
        }
        const wire: Wire[] = [];
        vi.stubGlobal(
          'fetch',
          (
            url: string,
            init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }
          ) => {
            wire.push({
              url,
              method: init.method,
              auth: init.headers['Authorization'],
              org: init.headers['x-active-org-id'],
              contentType: init.headers['Content-Type'],
              body: init.body,
            });
            return Promise.resolve(
              jsonResponse({ result: { id: 'rec_1' }, applied: true, results: [] })
            );
          }
        );

        const logger = makeTestLogger();
        const stub = yield* makeAuthStub;
        yield* SubscriptionRef.set(
          stub.sessionState,
          authState('signed-in', [account('user_1', 'org_a')], 'user_1')
        );
        const env = Layer.mergeAll(
          testI18nLayer(),
          Layer.succeed(AuthService, stub.api),
          logger.layer,
          testConfigLayer({
            platform: 'linux',
            endpoints: {
              coreApiUrl: 'https://core.test',
              noteWsUrl: 'wss://note.test/collaboration',
              webAppOrigin: 'https://app.test',
              analyticsKey: null,
              analyticsHost: null,
            },
          }),
          WorkspaceTransportLive,
          OperationalDbLive.pipe(Layer.provide(testConfigLayer()), Layer.provide(logger.layer)),
          RecordingBridgeLive,
          DetectionBridgeLive,
          EventKitBridgeLive,
          CollabBridgeLive,
          // The workspace environment carries the transcription-engine inputs.
          workspaceEnvStubs('cloud')
        );
        const pinned: PinnedSession = {
          sub: 'user_1',
          email: 'user_1@example.com',
          activeOrgId: 'org_a',
        };
        const scope = yield* Scope.make();
        const envCtx = yield* Layer.build(env).pipe(Scope.extend(scope));
        const sessionCtx = yield* Layer.build(makeCloudWorkspaceLayer(pinned)).pipe(
          Effect.provide(envCtx),
          Scope.extend(scope)
        );
        const client = Context.get(sessionCtx, WorkspaceBackend);

        // A valid session: create stamps the guarded id_token + active org in MAIN.
        const created = yield* client.createRecording({
          recordingId: 'rec_1',
          title: 'Standup',
          captureMode: 'dual',
          noteId: 'note_1',
          startedAt: 1_720_000_000_000,
        });
        assert.deepStrictEqual(created, { ok: true, value: { recordingId: 'rec_1' } });

        // …and the WAV chunk uploads the RAW audio/wav body under the same identity.
        const wav = new Uint8Array([1, 2, 3, 4]);
        const uploaded = yield* client.uploadTranscriptionChunk(
          'rec_1',
          { chunkIndex: 0, chunkStartMs: 0, source: 'system' },
          wav
        );
        assert.deepStrictEqual(uploaded, { ok: true, value: [] });

        assert.strictEqual(wire.length, 2);
        assert.deepStrictEqual(
          wire.map(w => ({
            method: w.method,
            auth: w.auth,
            org: w.org,
            contentType: w.contentType,
          })),
          [
            {
              method: 'POST',
              auth: 'Bearer idtoken-user_1',
              org: 'org_a',
              contentType: 'application/json',
            },
            {
              method: 'POST',
              auth: 'Bearer idtoken-user_1',
              org: 'org_a',
              contentType: 'audio/wav',
            },
          ]
        );
        assert.strictEqual(
          wire[1].url,
          'https://core.test/apps/v1/me/recordings/rec_1/transcribe?chunkIndex=0&chunkStartMs=0&source=system'
        );
        assert.strictEqual(wire[1].body, wav);

        // Org switched away ⇒ the SignedInSession guard fails and the upload never
        // leaves — a stale session must NEVER upload under the wrong org.
        yield* SubscriptionRef.set(
          stub.sessionState,
          authState('signed-in', [account('user_1', 'org_b')], 'user_1')
        );
        const stale = yield* client.uploadTranscriptionChunk(
          'rec_1',
          { chunkIndex: 1, chunkStartMs: 15_000, source: 'system' },
          new Uint8Array([9])
        );
        assert.deepStrictEqual(stale, {
          ok: false,
          retryable: true,
          failure: { kind: 'stale-identity' },
        });
        assert.strictEqual(wire.length, 2, 'no upload under a stale session');

        yield* Scope.close(scope, Exit.void);
      })
  );
});
