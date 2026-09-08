/**
 * The workspace lifecycle is one loop, forked by the boot program,
 * reconciling "which workspace should be mounted" — keyed on (mode, identity)
 * — against the boot-resolved AppMode and AuthService.sessionState. In cloud
 * mode the desired workspace is one (account, org) identity, exactly the old
 * session lifecycle; in local mode it is the accountless local workspace,
 * mounted unconditionally and indifferent to auth emissions.
 *
 * Invariants:
 * - at most ONE workspace scope is ever live: the old scope closes FULLY
 *   (bounded by WORKSPACE_CLOSE_DEADLINE) before a successor is built;
 * - acquire failure rolls back the whole layer — partial acquisitions release,
 *   zero runtimes remain. The auth gate may still claim signed-in; the
 *   fallback is log + stay torn down (never crash boot), retrying on the next
 *   sessionState emission — or, after ACQUIRE_RETRY_DELAY, on a timed wake-up
 *   (local mode may see no further auth emissions, so a failed local.db
 *   open must not brick the workspace until quit);
 * - interrupting the loop (boot scope close / quit) closes any live workspace
 *   scope through the same bounded path, so quit leaves zero workspace fibers.
 */
import type { SessionProbe } from '@prismical/desktop-contracts';
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { AppMode } from '../domains/app-mode/service';
import { AppModeService } from '../domains/app-mode/service';
import type { AuthState } from '../domains/auth/policy';
import { AuthService } from '../domains/auth/service';
import { MainLogger } from '../infra/logging/service';
import { ProductDbError } from '../infra/product-db/service';
import {
  makeWorkspaceLayer,
  type DesiredWorkspace,
  type PinnedSession,
  type WorkspaceLayerEnv,
} from './workspace-layer';

/**
 * Old-scope close budget during swap/teardown (mirrors shutdown's
 * DISPOSE_DEADLINE). A wedged finalizer must not wedge auth transitions or
 * quit: on timeout the close keeps draining in a disconnected fiber while the
 * lifecycle moves on — the abandoned workspace is already deregistered and (in
 * cloud mode) its SignedInSession guard makes it inert.
 */
export const WORKSPACE_CLOSE_DEADLINE = Duration.seconds(5);

/**
 * Delay before a failed workspace acquisition is retried WITHOUT waiting for
 * an auth emission. Cloud failures have a natural retry trigger
 * (the next sessionState emission); local mode's auth stream is essentially
 * silent after boot, so the loop arms this timed wake-up after every acquire
 * failure. The wake-up is a plain reconcile: if the desired workspace already
 * mounted (or changed) in the meantime it is a no-op.
 */
export const ACQUIRE_RETRY_DELAY = Duration.seconds(5);

/**
 * Gate → desired-identity mapping (cloud mode):
 * - 'signed-in' / 'refreshing' / 'offline' with an active account ⇒ that
 *   account owns a session. refreshing/offline ARE a signed-in session with
 *   stale tokens — a temporarily-offline session must not tear down;
 * - 'signing-in' with an active account keeps its session (a re-auth or
 *   add-account browser dance runs on TOP of the live session); without one
 *   it is the pre-auth gate ⇒ none;
 * - 'signed-out' ⇒ none, unconditionally.
 * Identity is (sub, activeOrgId): refreshed display claims (email/name) never
 * swap the runtime — sessionState pushes those, not the pin.
 */
export const desiredSession = (state: AuthState): PinnedSession | null => {
  if (state.gate === 'signed-out' || state.activeSub === undefined) return null;
  const account = state.accounts[state.activeSub];
  if (account === undefined) return null;
  return {
    sub: account.sub,
    email: account.email,
    ...(account.name === undefined ? {} : { name: account.name }),
    ...(account.activeOrgId === undefined ? {} : { activeOrgId: account.activeOrgId }),
  };
};

/**
 * (mode, auth state) → desired workspace. Local mode wants its workspace
 * unconditionally — no identity, no auth dependence; cloud mode wants exactly
 * the old desired session, or none.
 */
export const desiredWorkspace = (mode: AppMode, state: AuthState): DesiredWorkspace | null => {
  if (mode === 'local') return { mode: 'local' };
  const pinned = desiredSession(state);
  return pinned === null ? null : { mode: 'cloud', pinned };
};

const sameIdentity = (a: PinnedSession, b: PinnedSession): boolean =>
  a.sub === b.sub && a.activeOrgId === b.activeOrgId;

/** Same workspace ⇒ never re-acquire: same mode, and in cloud the same (sub, org). */
const sameWorkspace = (a: DesiredWorkspace, b: DesiredWorkspace): boolean =>
  a.mode === 'cloud' && b.mode === 'cloud' ? sameIdentity(a.pinned, b.pinned) : a.mode === b.mode;

const subPrefix = (sub: string): string => sub.slice(0, 6) + '…';

/** Token-free log fields naming a workspace: its mode + (cloud) the sub prefix. */
const describeWorkspace = (
  desired: DesiredWorkspace
): { readonly mode: AppMode; readonly sub?: string } =>
  desired.mode === 'cloud'
    ? { mode: 'cloud', sub: subPrefix(desired.pinned.sub) }
    : { mode: 'local' };

/**
 * Test-only lifecycle observability: acquisition failure is
 * deliberately silent to the UI (the gate may still claim signed-in), so
 * WITHOUT this probe no e2e can observe "exactly one workspace per valid
 * callback". The lifecycle loop below is the only writer; the e2e IPC
 * channel (e2e:sessionProbe, registered ONLY under PRISMICAL_E2E, mirroring
 * streamStats/authPendingState) is the only production-code reader. Counters
 * carry sub/org identity only — never tokens; a local workspace counts with
 * `pinned: null`.
 */
export interface SessionLifecycleProbeApi {
  readonly snapshot: Effect.Effect<SessionProbe>;
  readonly recordAcquire: (pinned: PinnedSession | null) => Effect.Effect<void>;
  readonly recordRelease: Effect.Effect<void>;
  readonly recordFailure: Effect.Effect<void>;
}

export class SessionLifecycleProbe extends Context.Tag('desktop/SessionLifecycleProbe')<
  SessionLifecycleProbe,
  SessionLifecycleProbeApi
>() {}

export const SessionLifecycleProbeLive: Layer.Layer<SessionLifecycleProbe> = Layer.effect(
  SessionLifecycleProbe,
  Effect.gen(function* () {
    const state = yield* Ref.make<SessionProbe>({
      acquires: 0,
      releases: 0,
      acquireFailures: 0,
      pinned: null,
    });
    const api: SessionLifecycleProbeApi = {
      snapshot: Ref.get(state),
      recordAcquire: pinned =>
        Ref.update(state, current => ({
          ...current,
          acquires: current.acquires + 1,
          pinned: pinned === null ? null : { sub: pinned.sub, orgId: pinned.activeOrgId ?? null },
        })),
      recordRelease: Ref.update(state, current => ({
        ...current,
        releases: current.releases + 1,
        pinned: null,
      })),
      recordFailure: Ref.update(state, current => ({
        ...current,
        acquireFailures: current.acquireFailures + 1,
        pinned: null,
      })),
    };
    return api;
  })
);

export interface WorkspaceLifecycleOptions {
  /** Injected by tests (probe layers, failure injection); defaults to makeWorkspaceLayer. */
  readonly makeLayer?: (
    desired: DesiredWorkspace
  ) => Layer.Layer<never, unknown, WorkspaceLayerEnv>;
  readonly closeDeadline?: Duration.Duration;
  /**
   * How long a failed acquisition stays torn down before the loop wakes itself
   * to reconcile again; defaults to ACQUIRE_RETRY_DELAY. Tests drive it with
   * the TestClock.
   */
  readonly acquireRetryDelay?: Duration.Duration;
}

interface LiveWorkspace {
  readonly desired: DesiredWorkspace;
  readonly scope: Scope.CloseableScope;
}

export const runWorkspaceLifecycle = (
  options: WorkspaceLifecycleOptions = {}
): Effect.Effect<void, never, WorkspaceLayerEnv | SessionLifecycleProbe | AppModeService> =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const log = (yield* MainLogger).scoped('session');
    const probe = yield* SessionLifecycleProbe;
    // Boot-resolved and immutable for the process: a mode switch is a
    // destructive reset + relaunch, so the loop reconciles auth
    // emissions under one constant mode.
    const { mode } = yield* AppModeService;
    const makeLayer = options.makeLayer ?? makeWorkspaceLayer;
    const deadline = options.closeDeadline ?? WORKSPACE_CLOSE_DEADLINE;
    const retryDelay = options.acquireRetryDelay ?? ACQUIRE_RETRY_DELAY;

    const currentRef = yield* Ref.make<Option.Option<LiveWorkspace>>(Option.none());
    // Timed retry wake-ups: sliding(1) coalesces overlapping timers —
    // one queued wake-up is enough, reconcile re-reads the current state. The
    // timer fibers live in their own scope so quit interrupts any pending one.
    const retryWakeups = yield* Queue.sliding<void>(1);
    const retryScope = yield* Scope.make();

    // Effect.disconnect lets the deadline fire even against uninterruptible
    // finalizers (Scope.close cannot be interrupted from the outside).
    const closeWorkspace = (workspace: LiveWorkspace): Effect.Effect<void> =>
      Scope.close(workspace.scope, Exit.void).pipe(
        Effect.disconnect,
        Effect.timeoutFail({ duration: deadline, onTimeout: () => 'close-deadline' as const }),
        Effect.catchAllCause(cause =>
          log.error('workspace scope close did not complete cleanly', {
            context: { ...describeWorkspace(workspace.desired) },
            error: Cause.squash(cause),
          })
        )
      );

    // getAndSet empties the slot BEFORE closing: even a timed-out close leaves
    // the workspace deregistered, so no path can observe two live workspaces.
    // Releases count here (a REAL workspace ended) — the acquire-failure
    // rollback below calls closeWorkspace directly and counts as a failure,
    // not a release.
    const closeCurrent: Effect.Effect<void> = Ref.getAndSet(currentRef, Option.none()).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: workspace => closeWorkspace(workspace).pipe(Effect.zipRight(probe.recordRelease)),
        })
      )
    );

    const acquire = (desired: DesiredWorkspace): Effect.Effect<void, never, WorkspaceLayerEnv> =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        // Registered BEFORE building: an interrupt mid-acquire still releases
        // the partial acquisition via the loop finalizer below.
        yield* Ref.set(currentRef, Option.some({ desired, scope }));
        const exit = yield* Effect.exit(Layer.build(makeLayer(desired)).pipe(Scope.extend(scope)));
        if (Exit.isFailure(exit)) {
          // Atomic acquisition: any acquire failure rolls the whole layer
          // back (closing the scope releases acquires 1..N-1). Zero runtimes
          // remain; the loop stays up and retries on the next state change.
          yield* Ref.set(currentRef, Option.none());
          yield* closeWorkspace({ desired, scope });
          yield* probe.recordFailure;
          // Unwrap Effect at its owner boundary; the shared codec preserves
          // the typed error and its cause without importing Effect internals.
          const failure = Cause.squash(exit.cause);
          yield* log.error('workspace scope acquisition failed — torn down', {
            context: {
              ...describeWorkspace(desired),
              ...(failure instanceof ProductDbError ? { op: failure.op } : {}),
            },
            error: failure,
          });
          // Arm the timed retry: in local mode there may be no further
          // auth emissions, so without this a failed local.db open would stay
          // torn down until quit. The fiber just sleeps then wakes the loop.
          yield* Effect.sleep(retryDelay).pipe(
            Effect.zipRight(Queue.offer(retryWakeups, void 0)),
            Effect.forkIn(retryScope)
          );
        } else {
          yield* probe.recordAcquire(desired.mode === 'cloud' ? desired.pinned : null);
        }
      });

    const reconcile: Effect.Effect<void, never, WorkspaceLayerEnv> = Effect.gen(function* () {
      const state = yield* SubscriptionRef.get(auth.sessionState);
      const desired = desiredWorkspace(mode, state);
      const current = Option.getOrNull(yield* Ref.get(currentRef));
      // Idempotent: equal/duplicate emissions never re-acquire.
      if (desired === null && current === null) return;
      if (desired !== null && current !== null && sameWorkspace(desired, current.desired)) return;
      // Swap discipline: close FULLY, then build — no instant with two live
      // workspaces, and a late fiber of the old one cannot outlive it.
      yield* closeCurrent;
      if (desired !== null) yield* acquire(desired);
    });

    // Emissions are wake-ups; reconcile reads the CURRENT state, so bursts
    // coalesce (a queued stale emission reconciles to a no-op). The loop never
    // writes sessionState — the self-wake trap noted in domains/auth/
    // consumer.ts cannot arise here. `changes` emits the current value first,
    // so a restored account (gate 'refreshing' on boot) acquires immediately —
    // and the local workspace mounts on the very first emission, whatever the
    // auth gate says. The merged retry queue is the second wake-up source
    // through a timed poke after an acquire failure, identical to an emission.
    yield* Stream.runForEach(
      Stream.merge(auth.sessionState.changes, Stream.fromQueue(retryWakeups)),
      () => reconcile
    ).pipe(
      // Quit path: the boot scope interrupts this fiber; the live workspace
      // (or a partial acquisition) closes within the bounded deadline, and any
      // pending retry timer is interrupted with its scope.
      Effect.ensuring(closeCurrent),
      Effect.ensuring(Scope.close(retryScope, Exit.void))
    );
  });
