/**
 * Workspace lifecycle and layer tests: exactly one
 * workspace per valid (mode, identity), idempotent duplicate emissions,
 * close-before-build swap on account/org switch, sign-out/quit teardown with
 * fiber interruption asserted (not hoped), stale-session no-resurrection,
 * atomic-acquire rollback, offline/refreshing NOT tearing a cloud workspace
 * down, the desiredWorkspace mode mapping, and the local-mode workspace
 * (mounts pre-auth, ignores auth, releases on quit). AuthService is stubbed —
 * the lifecycle consumes only sessionState + getIdToken; the real machinery
 * has its own suite (tests/services/auth.test.ts).
 */
import { assert, describe, it } from '@effect/vitest';
import {
  Cause,
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
import type { SessionProbe } from '@prismical/desktop-contracts';
import {
  makeTestLogger,
  testConfigLayer,
  testI18nLayer,
  type TestLogger,
} from '../helpers/test-layers';
import {
  initialAuthState,
  type AuthAccountView,
  type AuthState,
} from '../../src/main/domains/auth/policy';
import { AuthService, type AuthApi } from '../../src/main/domains/auth/service';
import { RecordingBridgeLive } from '../../src/main/domains/recording/bridge';
import { DetectionBridgeLive } from '../../src/main/domains/detection/bridge';
import { EventKitBridgeLive } from '../../src/main/domains/eventkit/bridge';
import { CollabBridgeLive } from '../../src/main/domains/collab/store-live';
import { CollabBridge } from '../../src/main/domains/collab/store';
import { WorkspaceTransportLive } from '../../src/main/domains/transport/live';
import { WorkspaceTransport } from '../../src/main/domains/transport/service';
import { OperationalDbLive } from '../../src/main/infra/operational-db/live';
import { AppModeService, type AppMode } from '../../src/main/domains/app-mode/service';
import {
  fakeAiProviderLayer,
  fakeModelManagerLayer,
  fakeSecureStoreLayer,
  makeFakeSettings,
  makeFakeWhisperEngine,
  workspaceEnvStubs,
} from '../helpers/fake-workspace-env';
import {
  makeCloudWorkspaceLayer,
  makeWorkspaceLayer,
  SignedInSession,
  StaleSessionError,
  type DesiredWorkspace,
  type PinnedSession,
} from '../../src/main/runtime/workspace-layer';
import {
  ACQUIRE_RETRY_DELAY,
  desiredSession,
  desiredWorkspace,
  runWorkspaceLifecycle,
  WORKSPACE_CLOSE_DEADLINE,
  SessionLifecycleProbe,
  SessionLifecycleProbeLive,
  type WorkspaceLifecycleOptions,
  type SessionLifecycleProbeApi,
} from '../../src/main/runtime/workspace-lifecycle';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  const getIdTokenCalls: string[] = [];
  const api: AuthApi = {
    sessionState,
    signIn: () => Effect.void,
    signOut: () => Effect.void,
    setActiveAccount: () => Effect.void,
    setActiveOrg: () => Effect.void,
    getIdToken: sub =>
      Effect.sync(() => {
        getIdTokenCalls.push(sub ?? '(active)');
        return `idtoken-${sub ?? '(active)'}`;
      }),
    openWebSession: () => Effect.void,
    consumePendingEntry: () => Effect.succeed('rejected' as const),
    pendingAttemptState: Effect.succeed(null),
    pendingAttemptAuthorizeUrl: Effect.succeed(null),
  };
  return { api, sessionState, getIdTokenCalls };
});

// Probe service the test factories merge into the signed-in layer: counts
// acquire/release (with the pinned identity) and parks a forkScoped fiber in
// the session scope so "no live fiber after close" is asserted via its Exit.
class ProbeReady extends Context.Tag('test/ProbeReady')<ProbeReady, true>() {}

const makeProbe = () => {
  const events: string[] = [];
  const fibers: Array<Fiber.RuntimeFiber<never, never>> = [];
  const layerFor = (pinned: PinnedSession): Layer.Layer<ProbeReady> =>
    Layer.scoped(
      ProbeReady,
      Effect.gen(function* () {
        const label = `${pinned.sub}/${pinned.activeOrgId ?? '-'}`;
        yield* Effect.acquireRelease(
          Effect.sync(() => events.push(`acquire:${label}`)),
          () => Effect.sync(() => events.push(`release:${label}`))
        );
        fibers.push(yield* Effect.forkScoped(Effect.never));
        return true as const;
      })
    );
  return { events, fibers, layerFor };
};
type Probe = ReturnType<typeof makeProbe>;

/** These lifecycle tests run in cloud mode — the desired workspace always carries a pin. */
const cloudPinned = (desired: DesiredWorkspace): PinnedSession => {
  if (desired.mode !== 'cloud') throw new Error(`expected a cloud workspace, got ${desired.mode}`);
  return desired.pinned;
};

const probedFactory =
  (probe: Probe): NonNullable<WorkspaceLifecycleOptions['makeLayer']> =>
  desired =>
    Layer.mergeAll(makeWorkspaceLayer(desired), probe.layerFor(cloudPinned(desired)));

/** Local-mode probe: no pin exists, so label the probe by the mode itself. */
const localProbedFactory =
  (probe: Probe): NonNullable<WorkspaceLifecycleOptions['makeLayer']> =>
  desired =>
    Layer.mergeAll(
      makeWorkspaceLayer(desired),
      probe.layerFor({ sub: desired.mode, email: 'local@device' })
    );

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Lets forked lifecycle steps land between test steps. */
const flush: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 6; i++) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
  }
});

const awaitEventCount = (probe: Probe, count: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (probe.events.length >= count) return;
      yield* flush;
    }
    assert.isAtLeast(probe.events.length, count, 'probe events did not settle');
  });

const awaitEvent = (probe: Probe, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (probe.events.includes(label)) return;
      yield* flush;
    }
    assert.include(probe.events, label, 'probe event did not settle');
  });

const awaitLog = (logger: TestLogger, message: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (logger.find(e => e.message === message) !== undefined) return;
      yield* flush;
    }
    assert.isDefined(
      logger.find(e => e.message === message),
      `log line "${message}"`
    );
  });

const setup = (
  makeLayer: NonNullable<WorkspaceLifecycleOptions['makeLayer']>,
  mode: AppMode = 'cloud',
  options: Omit<WorkspaceLifecycleOptions, 'makeLayer'> = {}
) =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const stub = yield* makeAuthStub;
    // The session layer composes the WorkspaceBackend, which needs AppConfig
    // (coreApiUrl) and self-publishes into the boot-scoped WorkspaceTransport.
    const env = Layer.mergeAll(
      Layer.succeed(AuthService, stub.api),
      logger.layer,
      testConfigLayer(),
      testI18nLayer(),
      WorkspaceTransportLive,
      // The session layer composes the RecordingService, which shares
      // the boot OperationalDb for the recovery outbox.
      OperationalDbLive.pipe(Layer.provide(testConfigLayer()), Layer.provide(logger.layer)),
      // RecordingService self-publishes into the boot-scoped bridge.
      RecordingBridgeLive,
      // DetectionService self-publishes into the boot-scoped bridge.
      DetectionBridgeLive,
      EventKitBridgeLive,
      CollabBridgeLive,
      SessionLifecycleProbeLive,
      // The lifecycle reconciles under the boot-resolved mode.
      Layer.succeed(AppModeService, { mode, chosen: true }),
      // The workspace environment carries the transcription-engine inputs.
      makeFakeSettings().layer,
      fakeSecureStoreLayer(),
      fakeModelManagerLayer(),
      makeFakeWhisperEngine().layer,
      // The local backend resolves its language model through AiProvider.
      fakeAiProviderLayer()
    );
    const scope = yield* Scope.make();
    const ctx = yield* Layer.build(env).pipe(Scope.extend(scope));
    yield* Effect.forkScoped(runWorkspaceLifecycle({ makeLayer, ...options })).pipe(
      Effect.provide(ctx),
      Scope.extend(scope)
    );
    return {
      logger,
      stub,
      scope,
      lifecycleProbe: Context.get(ctx, SessionLifecycleProbe),
      // The boot-scoped accessor the mounted WorkspaceBackend registers into.
      transport: Context.get(ctx, WorkspaceTransport),
      // The boot-scoped accessor the mounted NoteBodyStore registers into.
      collabBridge: Context.get(ctx, CollabBridge),
    };
  });

/** Poll the lifecycle probe until the predicate holds (counters settle async). */
const awaitProbe = (
  probeApi: SessionLifecycleProbeApi,
  predicate: (snapshot: SessionProbe) => boolean
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (predicate(yield* probeApi.snapshot)) return;
      yield* flush;
    }
    assert.isTrue(predicate(yield* probeApi.snapshot), 'lifecycle probe did not settle');
  });

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

// ---------------------------------------------------------------------------
// Gate → desired-identity mapping (pure)
// ---------------------------------------------------------------------------

describe('desiredSession mapping', () => {
  it('signed-out ⇒ none, unconditionally', () => {
    assert.isNull(desiredSession(authState('signed-out', [account('u1')], 'u1')));
    assert.isNull(desiredSession(initialAuthState));
  });

  it('signing-in pre-auth (no active account) ⇒ none', () => {
    assert.isNull(desiredSession(authState('signing-in', [])));
  });

  it('signing-in on top of a live account keeps its session', () => {
    assert.deepStrictEqual(desiredSession(authState('signing-in', [account('u1', 'o1')], 'u1')), {
      sub: 'u1',
      email: 'u1@example.com',
      activeOrgId: 'o1',
    });
  });

  it('signed-in / refreshing / offline with an active account ⇒ that identity', () => {
    for (const gate of ['signed-in', 'refreshing', 'offline'] as const) {
      assert.deepStrictEqual(desiredSession(authState(gate, [account('u1')], 'u1')), {
        sub: 'u1',
        email: 'u1@example.com',
      });
    }
  });

  it('an activeSub without a matching account entry ⇒ none (defensive)', () => {
    assert.isNull(desiredSession(authState('signed-in', [account('u2')], 'u1')));
  });
});

describe('desiredWorkspace mapping', () => {
  it('local mode wants its workspace unconditionally — identity-free', () => {
    assert.deepStrictEqual(desiredWorkspace('local', initialAuthState), { mode: 'local' });
    assert.deepStrictEqual(desiredWorkspace('local', authState('signed-out', [])), {
      mode: 'local',
    });
    assert.deepStrictEqual(
      desiredWorkspace('local', authState('signed-in', [account('u1', 'o1')], 'u1')),
      { mode: 'local' }
    );
  });

  it('cloud mode delegates to the desired session', () => {
    assert.isNull(desiredWorkspace('cloud', initialAuthState));
    assert.isNull(desiredWorkspace('cloud', authState('signed-out', [account('u1')], 'u1')));
    assert.deepStrictEqual(
      desiredWorkspace('cloud', authState('signed-in', [account('u1', 'o1')], 'u1')),
      { mode: 'cloud', pinned: { sub: 'u1', email: 'u1@example.com', activeOrgId: 'o1' } }
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('SignedInRuntime lifecycle', () => {
  it.effect('a valid signed-in state acquires exactly ONE runtime; quit releases it', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const { logger, stub, scope } = yield* setup(probedFactory(probe));

      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1')], 'user_1')
      );
      yield* awaitEventCount(probe, 1);
      assert.deepStrictEqual(probe.events, ['acquire:user_1/-']);
      assert.isDefined(logger.find(e => e.message === 'signed-in scope acquired'));

      // Quit path: closing the loop's scope closes the live session first.
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(probe.events, ['acquire:user_1/-', 'release:user_1/-']);
      assert.isDefined(logger.find(e => e.message === 'signed-in scope released'));
      const fiberExit = yield* Fiber.await(probe.fibers[0]);
      assert.isTrue(Exit.isInterrupted(fiberExit), 'session fiber interrupted on quit');
    })
  );

  it.effect('duplicate/equal state emissions are idempotent — no re-acquisition', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const { stub, scope } = yield* setup(probedFactory(probe));

      const signedIn = () => authState('signed-in', [account('user_1', 'org_a')], 'user_1');
      yield* SubscriptionRef.set(stub.sessionState, signedIn());
      yield* awaitEventCount(probe, 1);
      // Fresh (but identity-equal) objects, twice.
      yield* SubscriptionRef.set(stub.sessionState, signedIn());
      yield* SubscriptionRef.set(stub.sessionState, signedIn());
      // A refreshed display claim (name) with the same identity must not swap.
      yield* SubscriptionRef.set(stub.sessionState, {
        ...signedIn(),
        accounts: { user_1: { ...account('user_1', 'org_a'), name: 'Renamed' } },
      });
      yield* flush;

      assert.deepStrictEqual(probe.events, ['acquire:user_1/org_a']);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('account switch: the old scope closes FULLY before the new one builds', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const { stub, scope } = yield* setup(probedFactory(probe));

      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1')], 'user_1')
      );
      yield* awaitEventCount(probe, 1);
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1'), account('user_2')], 'user_2')
      );
      yield* awaitEventCount(probe, 3);

      assert.deepStrictEqual(probe.events, [
        'acquire:user_1/-',
        'release:user_1/-',
        'acquire:user_2/-',
      ]);
      const oldFiber = yield* Fiber.await(probe.fibers[0]);
      assert.isTrue(Exit.isInterrupted(oldFiber), 'old session fiber interrupted');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('org switch swaps the runtime the same way', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const { stub, scope } = yield* setup(probedFactory(probe));

      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1', 'org_a')], 'user_1')
      );
      yield* awaitEventCount(probe, 1);
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1', 'org_b')], 'user_1')
      );
      yield* awaitEventCount(probe, 3);

      assert.deepStrictEqual(probe.events, [
        'acquire:user_1/org_a',
        'release:user_1/org_a',
        'acquire:user_1/org_b',
      ]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('sign-out closes the scope: release ran and the session fiber is interrupted', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const { stub, scope } = yield* setup(probedFactory(probe));

      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1')], 'user_1')
      );
      yield* awaitEventCount(probe, 1);
      yield* SubscriptionRef.set(stub.sessionState, authState('signed-out', []));
      yield* awaitEventCount(probe, 2);

      assert.deepStrictEqual(probe.events, ['acquire:user_1/-', 'release:user_1/-']);
      // No live fiber after scope close — asserted, not hoped.
      const fiberExit = yield* Fiber.await(probe.fibers[0]);
      assert.isTrue(Exit.isInterrupted(fiberExit), 'session fiber interrupted on sign-out');

      // Torn down stays torn down on repeated signed-out emissions.
      yield* SubscriptionRef.set(stub.sessionState, authState('signed-out', []));
      yield* flush;
      assert.strictEqual(probe.events.length, 2);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(probe.events.length, 2, 'nothing left for quit to close');
    })
  );

  it.effect('a stale SignedInSession fails typed — a late token fetch cannot resurrect', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const stub = yield* makeAuthStub;
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1')], 'user_1')
      );
      const env = Layer.mergeAll(
        Layer.succeed(AuthService, stub.api),
        logger.layer,
        testConfigLayer({ platform: 'linux' }),
        testI18nLayer(),
        WorkspaceTransportLive,
        OperationalDbLive.pipe(Layer.provide(testConfigLayer()), Layer.provide(logger.layer)),
        RecordingBridgeLive,
        DetectionBridgeLive,
        EventKitBridgeLive,
        CollabBridgeLive,
        workspaceEnvStubs('cloud')
      );
      const pinned: PinnedSession = { sub: 'user_1', email: 'user_1@example.com' };
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(makeCloudWorkspaceLayer(pinned).pipe(Layer.provide(env))).pipe(
        Scope.extend(scope)
      );
      const session = Context.get(ctx, SignedInSession);
      assert.deepStrictEqual(session.pinned, pinned);
      // Matching identity delegates to AuthService…
      assert.strictEqual(yield* session.idToken, 'idtoken-user_1');
      // …including while refreshing/offline (stale tokens ≠ stale identity).
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('refreshing', [account('user_1')], 'user_1')
      );
      assert.strictEqual(yield* session.idToken, 'idtoken-user_1');
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('offline', [account('user_1')], 'user_1')
      );
      assert.strictEqual(yield* session.idToken, 'idtoken-user_1');
      assert.deepStrictEqual(stub.getIdTokenCalls, ['user_1', 'user_1', 'user_1']);

      // Account switched away.
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1'), account('user_2')], 'user_2')
      );
      const switched = failureOf(yield* Effect.exit(session.idToken));
      assert.instanceOf(switched, StaleSessionError);
      assert.strictEqual((switched as StaleSessionError).reason, 'account-switched');

      // Org switched.
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1', 'org_b')], 'user_1')
      );
      const orgSwitched = failureOf(yield* Effect.exit(session.idToken));
      assert.instanceOf(orgSwitched, StaleSessionError);
      assert.strictEqual((orgSwitched as StaleSessionError).reason, 'org-switched');

      // Account dropped.
      yield* SubscriptionRef.set(stub.sessionState, authState('signed-out', []));
      const dropped = failureOf(yield* Effect.exit(session.idToken));
      assert.instanceOf(dropped, StaleSessionError);
      assert.strictEqual((dropped as StaleSessionError).reason, 'account-dropped');

      // The stale session never reached the token seam again.
      assert.deepStrictEqual(stub.getIdTokenCalls, ['user_1', 'user_1', 'user_1']);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('rejects a token resolved after the pinned org changed', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const stub = yield* makeAuthStub;
      const resolving = yield* Deferred.make<void>();
      const token = yield* Deferred.make<string>();
      yield* SubscriptionRef.set(stub.sessionState, authState('signed-in', [account('user_1', 'org_a')], 'user_1'));
      const env = Layer.mergeAll(
        Layer.succeed(AuthService, {
          ...stub.api,
          getIdToken: () => Deferred.succeed(resolving, undefined).pipe(Effect.zipRight(Deferred.await(token))),
        }),
        logger.layer, testConfigLayer({ platform: 'linux' }), testI18nLayer(), WorkspaceTransportLive,
        OperationalDbLive.pipe(Layer.provide(testConfigLayer()), Layer.provide(logger.layer)),
        RecordingBridgeLive, DetectionBridgeLive, EventKitBridgeLive, CollabBridgeLive, workspaceEnvStubs('cloud')
      );
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(makeCloudWorkspaceLayer({
        sub: 'user_1', email: 'user_1@example.com', activeOrgId: 'org_a',
      }).pipe(Layer.provide(env))).pipe(Scope.extend(scope));
      const pending = yield* Effect.fork(Context.get(ctx, SignedInSession).idToken);
      yield* Deferred.await(resolving);
      yield* SubscriptionRef.set(stub.sessionState, authState('signed-in', [account('user_1', 'org_b')], 'user_1'));
      yield* Deferred.succeed(token, 'late-token');
      const failure = failureOf(yield* Fiber.await(pending));
      assert.instanceOf(failure, StaleSessionError);
      assert.strictEqual((failure as StaleSessionError).reason, 'org-switched');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('acquire failure rolls the whole layer back; the loop survives and retries', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const failing = { on: true };
      const factory: NonNullable<WorkspaceLifecycleOptions['makeLayer']> = desired => {
        const probeLayer = probe.layerFor(cloudPinned(desired));
        // Depends on ProbeReady so the probe acquires BEFORE the failure —
        // making "acquires 1..N-1 are released" deterministic.
        const failLayer = Layer.effectDiscard(
          ProbeReady.pipe(
            Effect.flatMap(() =>
              failing.on ? Effect.fail(new Error('acquire boom')) : Effect.void
            )
          )
        ).pipe(Layer.provide(probeLayer));
        return Layer.mergeAll(makeWorkspaceLayer(desired), probeLayer, failLayer);
      };
      const { logger, stub, scope } = yield* setup(factory);

      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1')], 'user_1')
      );
      yield* awaitLog(logger, 'workspace scope acquisition failed — torn down');

      // Rollback: the probe acquired, then released exactly once. Zero runtimes.
      assert.deepStrictEqual(probe.events, ['acquire:user_1/-', 'release:user_1/-']);
      const fiberExit = yield* Fiber.await(probe.fibers[0]);
      assert.isTrue(Exit.isInterrupted(fiberExit), 'partial acquisition fiber interrupted');

      // The gate still claims signed-in; the loop stayed torn down but ALIVE:
      // the next state emission acquires once the failure is gone.
      failing.on = false;
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1')], 'user_1')
      );
      yield* awaitEventCount(probe, 3);
      assert.deepStrictEqual(probe.events, [
        'acquire:user_1/-',
        'release:user_1/-',
        'acquire:user_1/-',
      ]);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(probe.events.length, 4, 'recovered session released on quit');
    })
  );

  it.effect('offline/refreshing with an unchanged identity never tears the runtime down', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const { stub, scope } = yield* setup(probedFactory(probe));

      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1', 'org_a')], 'user_1')
      );
      yield* awaitEventCount(probe, 1);
      for (const gate of ['refreshing', 'offline', 'signed-in'] as const) {
        yield* SubscriptionRef.set(
          stub.sessionState,
          authState(gate, [account('user_1', 'org_a')], 'user_1')
        );
        yield* flush;
      }
      assert.deepStrictEqual(probe.events, ['acquire:user_1/org_a']);
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(probe.events, ['acquire:user_1/org_a', 'release:user_1/org_a']);
    })
  );

  // ---------------------------------------------------------------------------
  // The lifecycle probe (e2e:sessionProbe's data source) counts
  // must mirror the real acquire/release/failure transitions, never tokens.
  // ---------------------------------------------------------------------------

  it.effect('the lifecycle probe counts acquire/release and pins the identity', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const { stub, scope, lifecycleProbe } = yield* setup(probedFactory(probe));

      assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
        acquires: 0,
        releases: 0,
        acquireFailures: 0,
        pinned: null,
      });

      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1', 'org_a')], 'user_1')
      );
      yield* awaitProbe(lifecycleProbe, s => s.acquires === 1);
      assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
        acquires: 1,
        releases: 0,
        acquireFailures: 0,
        pinned: { sub: 'user_1', orgId: 'org_a' },
      });

      // Org switch: one release + one re-acquire; the pin follows.
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1', 'org_b')], 'user_1')
      );
      yield* awaitProbe(lifecycleProbe, s => s.acquires === 2);
      assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
        acquires: 2,
        releases: 1,
        acquireFailures: 0,
        pinned: { sub: 'user_1', orgId: 'org_b' },
      });

      // Sign-out: release only; nothing pinned.
      yield* SubscriptionRef.set(stub.sessionState, authState('signed-out', []));
      yield* awaitProbe(lifecycleProbe, s => s.releases === 2);
      assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
        acquires: 2,
        releases: 2,
        acquireFailures: 0,
        pinned: null,
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'an acquire failure counts as acquireFailures — never as acquire or release',
    () =>
      Effect.gen(function* () {
        const probe = makeProbe();
        const failing = { on: true };
        const factory: NonNullable<WorkspaceLifecycleOptions['makeLayer']> = desired => {
          const probeLayer = probe.layerFor(cloudPinned(desired));
          const failLayer = Layer.effectDiscard(
            ProbeReady.pipe(
              Effect.flatMap(() =>
                failing.on ? Effect.fail(new Error('acquire boom')) : Effect.void
              )
            )
          ).pipe(Layer.provide(probeLayer));
          return Layer.mergeAll(makeWorkspaceLayer(desired), probeLayer, failLayer);
        };
        const { logger, stub, scope, lifecycleProbe } = yield* setup(factory);

        yield* SubscriptionRef.set(
          stub.sessionState,
          authState('signed-in', [account('user_1')], 'user_1')
        );
        yield* awaitLog(logger, 'workspace scope acquisition failed — torn down');
        yield* awaitProbe(lifecycleProbe, s => s.acquireFailures === 1);
        // The rollback close of the PARTIAL acquisition is not a session release.
        assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
          acquires: 0,
          releases: 0,
          acquireFailures: 1,
          pinned: null,
        });

        // Recovery acquires for real; quit releases it.
        failing.on = false;
        yield* SubscriptionRef.set(
          stub.sessionState,
          authState('signed-in', [account('user_1')], 'user_1')
        );
        yield* awaitProbe(lifecycleProbe, s => s.acquires === 1);
        yield* Scope.close(scope, Exit.void);
        assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
          acquires: 1,
          releases: 1,
          acquireFailures: 1,
          pinned: null,
        });
      })
  );

  it.effect('a wedged finalizer is bounded: swap proceeds after WORKSPACE_CLOSE_DEADLINE', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      // Only user_1's session wedges its release, so end-of-test teardown of
      // the successor stays clean.
      const hangRelease = Layer.scopedDiscard(
        Effect.acquireRelease(Effect.void, () => Effect.never)
      );
      const factory: NonNullable<WorkspaceLifecycleOptions['makeLayer']> = desired =>
        cloudPinned(desired).sub === 'user_1'
          ? Layer.mergeAll(makeWorkspaceLayer(desired), probe.layerFor(cloudPinned(desired)), hangRelease)
          : Layer.mergeAll(makeWorkspaceLayer(desired), probe.layerFor(cloudPinned(desired)));
      const { logger, stub, scope } = yield* setup(factory);

      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1')], 'user_1')
      );
      yield* awaitEventCount(probe, 1);
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1'), account('user_2')], 'user_2')
      );
      yield* flush;
      // The swap is parked on the wedged close — and the successor is NOT
      // built early (no window with two runtimes).
      assert.notInclude(probe.events, 'acquire:user_2/-');

      yield* TestClock.adjust(WORKSPACE_CLOSE_DEADLINE);
      yield* awaitLog(logger, 'workspace scope close did not complete cleanly');
      yield* awaitEvent(probe, 'acquire:user_2/-');
      yield* Scope.close(scope, Exit.void);
      assert.include(probe.events, 'release:user_2/-');
    })
  );

  // ---------------------------------------------------------------------------
  // Local mode: one identity-free workspace, indifferent to auth.
  // ---------------------------------------------------------------------------

  it.effect('local mode mounts one workspace pre-auth, ignores auth, releases on quit', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const { logger, stub, scope, lifecycleProbe, transport, collabBridge } = yield* setup(
        localProbedFactory(probe),
        'local'
      );

      // `changes` emits the current (pre-auth) state first: the local
      // workspace mounts with no account at all.
      yield* awaitEventCount(probe, 1);
      assert.deepStrictEqual(probe.events, ['acquire:local/-']);
      assert.isDefined(logger.find(e => e.message === 'local workspace scope acquired'));
      // The probe counts the acquire but pins no identity (SessionProbe.pinned
      // stays null for a local workspace).
      yield* awaitProbe(lifecycleProbe, s => s.acquires === 1);
      assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
        acquires: 1,
        releases: 0,
        acquireFailures: 0,
        pinned: null,
      });

      // The workspace is no longer a service-less placeholder: the
      // LocalBackend registered into the boot-scoped WorkspaceTransport and
      // serves the /apps/v1/me dialect from the (in-memory) product store.
      assert.isTrue(Option.isSome(yield* transport.current), 'local backend registered');
      // NoteBodyStore registered into the boot-scoped CollabBridge.
      assert.isTrue(Option.isSome(yield* collabBridge.current), 'note-body store registered');
      const served = yield* transport.request({ method: 'GET', path: '/apps/v1/me/tags' }, { mode: 'local' });
      assert.deepStrictEqual(served, { ok: true, status: 200, bodyJson: { results: [] } });

      // Auth traffic never swaps or tears the local workspace down.
      yield* SubscriptionRef.set(
        stub.sessionState,
        authState('signed-in', [account('user_1', 'org_a')], 'user_1')
      );
      yield* SubscriptionRef.set(stub.sessionState, authState('signed-out', []));
      yield* flush;
      assert.deepStrictEqual(probe.events, ['acquire:local/-']);

      // Quit path: closing the loop's scope closes the live workspace — and
      // deregisters the backend (requests fold back to INTERNAL).
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(probe.events, ['acquire:local/-', 'release:local/-']);
      assert.isDefined(logger.find(e => e.message === 'local workspace scope released'));
      const fiberExit = yield* Fiber.await(probe.fibers[0]);
      assert.isTrue(Exit.isInterrupted(fiberExit), 'local workspace fiber interrupted on quit');
      assert.isTrue(Option.isNone(yield* transport.current), 'local backend deregistered');
      assert.isTrue(Option.isNone(yield* collabBridge.current), 'note-body store deregistered');
      assert.deepStrictEqual(yield* transport.request({ method: 'GET', path: '/apps/v1/me/tags' }, { mode: 'local' }), {
        error: { code: 'INTERNAL' },
      });
    })
  );

  it.effect('a failed local acquire retries after acquireRetryDelay — no auth emission needed', () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const failing = { on: true };
      const factory: NonNullable<WorkspaceLifecycleOptions['makeLayer']> = desired => {
        const probeLayer = probe.layerFor({ sub: desired.mode, email: 'local@device' });
        const failLayer = Layer.effectDiscard(
          ProbeReady.pipe(
            Effect.flatMap(() =>
              failing.on ? Effect.fail(new Error('local acquire boom')) : Effect.void
            )
          )
        ).pipe(Layer.provide(probeLayer));
        return Layer.mergeAll(makeWorkspaceLayer(desired), probeLayer, failLayer);
      };
      const { logger, scope, lifecycleProbe } = yield* setup(factory, 'local', {
        acquireRetryDelay: ACQUIRE_RETRY_DELAY,
      });

      // The very first emission mounts local, which fails and rolls back.
      yield* awaitLog(logger, 'workspace scope acquisition failed — torn down');
      yield* awaitProbe(lifecycleProbe, s => s.acquireFailures === 1);
      // No auth emission arrives in local mode — nothing retries early.
      failing.on = false;
      yield* flush;
      assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
        acquires: 0,
        releases: 0,
        acquireFailures: 1,
        pinned: null,
      });

      // The timed wake-up fires after the retry delay and the second attempt
      // acquires for real (identity-free — pinned stays null).
      yield* TestClock.adjust(ACQUIRE_RETRY_DELAY);
      yield* awaitProbe(lifecycleProbe, s => s.acquires === 1);
      assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
        acquires: 1,
        releases: 0,
        acquireFailures: 1,
        pinned: null,
      });
      yield* awaitEvent(probe, 'acquire:local/-');

      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(yield* lifecycleProbe.snapshot, {
        acquires: 1,
        releases: 1,
        acquireFailures: 1,
        pinned: null,
      });
    })
  );
});
