import { assert, it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, SubscriptionRef } from 'effect';
import {
  bindLauncherWindow,
  cancelLauncherIntent,
  forgetLauncherWindow,
  guardLauncherStart,
  validateLauncherIntent,
  type LauncherIntent,
} from '../../src/main/domains/launcher/intent';
import { makeRecordingBridgeLive, RecordingBridge } from '../../src/main/domains/recording/bridge';
import {
  idleRecordingState,
  type RecordingServiceApi,
} from '../../src/main/domains/recording/service';

it.effect(
  'intent binds one note and rejects wrong window, note, session and expired requests',
  () =>
    Effect.gen(function* () {
      const intent: LauncherIntent = {
        id: 'one',
        generation: 1,
        expires: Date.now() + 10000,
        canceled: yield* Deferred.make<void>(),
        claimed: false,
        finished: false,
      };
      bindLauncherWindow(intent, 91);
      assert.isFalse(validateLauncherIntent(92, 1, 'one', 'n'));
      assert.isFalse(validateLauncherIntent(91, 2, 'one', 'n'));
      assert.isTrue(validateLauncherIntent(91, 1, 'one', 'n'));
      assert.isFalse(validateLauncherIntent(91, 1, 'one', 'other'));
      cancelLauncherIntent(intent);
      assert.isFalse(validateLauncherIntent(91, 1, 'one', 'n'));
      forgetLauncherWindow(91);
    })
);
it.effect('cancellation interrupts permission preflight without reaching capture', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const permission = yield* Deferred.make<void>();
    let captured = false;
    const intent: LauncherIntent = {
      id: 'two',
      generation: 1,
      expires: Date.now() + 10000,
      canceled: yield* Deferred.make<void>(),
      claimed: false,
      finished: false,
    };
    bindLauncherWindow(intent, 92);
    const start = Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(permission);
      captured = true;
      return { ok: true as const, recordingId: 'r' };
    });
    const fiber = yield* Effect.forkChild(guardLauncherStart(92, 1, 'two', 'note', start));
    yield* Deferred.await(entered);
    cancelLauncherIntent(intent);
    assert.isFalse((yield* Fiber.join(fiber)).ok);
    yield* Deferred.succeed(permission, undefined);
    assert.isFalse(captured);
  })
);
it.effect('universal Stop cancels preflight before a recording ID exists', () =>
  Effect.gen(function* () {
    const bridge = Context.get(yield* Layer.build(makeRecordingBridgeLive()), RecordingBridge);
    const entered = yield* Deferred.make<void>();
    const permission = yield* Deferred.make<void>();
    let captured = false;
    const service = {
      state: yield* SubscriptionRef.make(idleRecordingState),
      level: yield* SubscriptionRef.make(0),
      start: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(permission);
          captured = true;
          return 'r';
        }),
      stop: () => Effect.void,
    } as unknown as RecordingServiceApi;
    yield* bridge.register(service);
    const fiber = yield* Effect.forkChild(bridge.start({ captureMode: 'mic' }));
    yield* Deferred.await(entered);
    yield* bridge.stopActive;
    assert.isFalse((yield* Fiber.join(fiber)).ok);
    yield* Deferred.succeed(permission, undefined);
    assert.isFalse(captured);
  })
);
it.effect('an old cancel cannot interrupt a replacement intent', () =>
  Effect.gen(function* () {
    const first: LauncherIntent = {
      id: 'old',
      generation: 1,
      expires: Date.now() + 10000,
      canceled: yield* Deferred.make<void>(),
      claimed: false,
      finished: false,
    };
    const next: LauncherIntent = {
      ...first,
      id: 'new',
      generation: 2,
      canceled: yield* Deferred.make<void>(),
    };
    bindLauncherWindow(first, 93);
    bindLauncherWindow(next, 93);
    cancelLauncherIntent(first);
    assert.isTrue(validateLauncherIntent(93, 2, 'new', 'n'));
    assert.isTrue(
      (yield* guardLauncherStart(93, 2, 'new', 'n', Effect.succeed({ ok: true, recordingId: 'r' })))
        .ok
    );
  })
);
