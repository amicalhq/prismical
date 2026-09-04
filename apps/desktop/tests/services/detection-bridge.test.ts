/**
 * DetectionBridge tests — the boot-to-session bridge for the
 * meeting-detection signal, the analogue of the RecordingBridge semantics:
 * register publishes the live session's state; a cleared bridge folds to idle;
 * dismiss routes to the live session or no-ops; and a stale release after a
 * successor registered does NOT clobber the live service (compare-and-clear).
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope, Stream, SubscriptionRef } from 'effect';
import { DetectionBridge, DetectionBridgeLive } from '../../src/main/domains/detection/bridge';
import { idleDetectionState, type DetectionState } from '../../src/main/domains/detection/policy';
import type { DetectionServiceApi } from '../../src/main/domains/detection/service';

const detectedState = (bundleId: string): DetectionState => ({
  status: 'detected',
  detection: {
    bundleId,
    displayName: 'Zoom',
    category: 'native',
    weight: 100,
    confidence: 1,
    since: 0,
    detectedAt: 4_000,
  },
});

const makeFakeDetection = (initial: DetectionState) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(initial);
    const dismissed = { count: 0 };
    const api: DetectionServiceApi = {
      state,
      dismiss: Effect.sync(() => {
        dismissed.count += 1;
      }),
    };
    return { api, state, dismissed };
  });

/** Let the forked stream-collector fiber settle without advancing any clock. */
const flush: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 8; i += 1) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
  }
});

const buildBridge = Effect.gen(function* () {
  const scope = yield* Scope.make();
  const ctx = yield* Layer.build(DetectionBridgeLive).pipe(Scope.extend(scope));
  const bridge = Context.get(ctx, DetectionBridge);
  const seen: DetectionState[] = [];
  yield* Effect.forkScoped(
    Stream.runForEach(bridge.stateChanges, s => Effect.sync(() => seen.push(s)))
  ).pipe(Scope.extend(scope));
  return { bridge, seen, scope };
});

describe('DetectionBridge (boot↔session bridge)', () => {
  it.effect('stateChanges: idle by default, live state after register, idle after release', () =>
    Effect.gen(function* () {
      const { bridge, seen, scope } = yield* buildBridge;
      yield* flush;
      assert.deepStrictEqual(seen.at(-1), idleDetectionState, 'idle while no session');

      const fake = yield* makeFakeDetection(detectedState('us.zoom.xos'));
      const sessionScope = yield* Scope.make();
      yield* bridge.register(fake.api).pipe(Scope.extend(sessionScope));
      yield* flush;
      assert.strictEqual(seen.at(-1)?.detection?.bundleId, 'us.zoom.xos');

      // A live update on the session's state flows through the flattened stream.
      yield* SubscriptionRef.set(fake.state, detectedState('com.microsoft.teams2'));
      yield* flush;
      assert.strictEqual(seen.at(-1)?.detection?.bundleId, 'com.microsoft.teams2');

      // Release → the flattened stream switches back to idle.
      yield* Scope.close(sessionScope, Exit.void);
      yield* flush;
      assert.deepStrictEqual(seen.at(-1), idleDetectionState, 'idle after the session releases');

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('dismiss: a no-op with no session; delegates to the live session', () =>
    Effect.gen(function* () {
      const { bridge, scope } = yield* buildBridge;
      // No session → no throw, no effect.
      yield* bridge.dismiss;

      const fake = yield* makeFakeDetection(idleDetectionState);
      const sessionScope = yield* Scope.make();
      yield* bridge.register(fake.api).pipe(Scope.extend(sessionScope));
      yield* bridge.dismiss;
      assert.strictEqual(fake.dismissed.count, 1);

      // Cleared → dismiss is a no-op again.
      yield* Scope.close(sessionScope, Exit.void);
      yield* bridge.dismiss;
      assert.strictEqual(fake.dismissed.count, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('compare-and-clear: a stale release after a successor registered does NOT clobber', () =>
    Effect.gen(function* () {
      const { bridge, seen, scope } = yield* buildBridge;

      const a = yield* makeFakeDetection(detectedState('us.zoom.xos'));
      const b = yield* makeFakeDetection(detectedState('com.microsoft.teams2'));
      const scopeA = yield* Scope.make();
      const scopeB = yield* Scope.make();

      yield* bridge.register(a.api).pipe(Scope.extend(scopeA));
      yield* flush;
      assert.strictEqual(seen.at(-1)?.detection?.bundleId, 'us.zoom.xos');

      // The successor registers while A's scope is still open.
      yield* bridge.register(b.api).pipe(Scope.extend(scopeB));
      yield* flush;
      assert.strictEqual(seen.at(-1)?.detection?.bundleId, 'com.microsoft.teams2');

      // A releases LATE — compare-and-clear must leave B as the current service.
      yield* Scope.close(scopeA, Exit.void);
      yield* flush;
      assert.strictEqual(
        seen.at(-1)?.detection?.bundleId,
        'com.microsoft.teams2',
        'stale A release did not clobber B'
      );
      yield* bridge.dismiss;
      assert.strictEqual(b.dismissed.count, 1, 'dismiss routed to B');
      assert.strictEqual(a.dismissed.count, 0);

      yield* Scope.close(scopeB, Exit.void);
      yield* flush;
      assert.deepStrictEqual(seen.at(-1), idleDetectionState);
      yield* Scope.close(scope, Exit.void);
    })
  );
});
