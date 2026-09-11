import { testTelemetryLayer } from '../helpers/telemetry';
/**
 * Shared MicActivity supervisor + DetectionService consumer tests.
 *
 * Fully headless: a FAKE mic-detector child (real NDJSON snapshot lines pushed to
 * its stdout), a FAKE RecordingService (a controllable state SubscriptionRef to
 * drive active-recording suppression), a capturing logger, and TestClock for the
 * sustained-activity delay, the cooldown, and the restart backoff. NO binary, NO
 * device. The exhaustive policy matrix lives in detection-policy.test.ts; this
 * suite proves the supervision + the end-to-end wiring on the real clock model.
 */
import { assert, describe, it } from '@effect/vitest';
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Scope,
  SubscriptionRef,
  TestClock,
} from 'effect';
import { beforeEach, vi } from 'vitest';
import { makeTestLogger } from '../helpers/test-layers';
import { installFakeSpawn, type FakeSpawnControl } from '../helpers/fake-child-process';
import { DetectionServiceLive } from '../../src/main/domains/detection/live';
import { DetectionBridgeLive } from '../../src/main/domains/detection/bridge';
import {
  DetectionService,
  type DetectionServiceApi,
} from '../../src/main/domains/detection/service';
import { COOLDOWN_MS, DETECTION_DELAY_MS } from '../../src/main/domains/detection/policy';
import { MicActivityLive } from '../../src/main/infra/mic-detector/live';
import { MicActivity, type MicActivityApi } from '../../src/main/infra/mic-detector/service';
import {
  RecordingService,
  idleRecordingState,
  type RecordingServiceApi,
  type RecordingState,
  type RecordingStatus,
} from '../../src/main/domains/recording/service';

vi.mock('node:child_process', async () => {
  const { fakeSpawn } = await import('../helpers/fake-child-process');
  return { spawn: fakeSpawn };
});
vi.mock('../../src/main/infra/mic-detector/mic-detector-binary', async () => {
  const { fakeBinaryPath } = await import('../helpers/fake-child-process');
  return {
    assertMicDetectorBinaryExists: fakeBinaryPath,
    resolveMicDetectorBinaryPath: fakeBinaryPath,
  };
});

let control: FakeSpawnControl;
beforeEach(() => {
  control = installFakeSpawn();
});

/** Let the forked consumer / supervisor fibers settle WITHOUT advancing the clock. */
const settle: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 12; i += 1) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
  }
});

const poll = (cond: Effect.Effect<boolean, unknown>, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const check = Effect.orDie(cond);
    for (let i = 0; i < 200; i += 1) {
      if (yield* check) return;
      yield* Effect.yieldNow();
      yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
    }
    assert.isTrue(yield* check, `poll timed out: ${label}`);
  });

const ZOOM = 'us.zoom.xos';
const UNKNOWN = 'com.apple.Music';

/** One NDJSON snapshot line — the exact 1 Hz mic-detector wire contract. */
const snapLine = (bundleIds: string[], now: number): string =>
  `${JSON.stringify({
    type: 'snapshot',
    timestampMs: now,
    apps: bundleIds.map(bundleId => ({ bundleId, pid: 1, detectedAtMs: now })),
  })}\n`;

interface Harness {
  readonly detection: DetectionServiceApi;
  readonly micActivity: MicActivityApi;
  readonly recState: SubscriptionRef.SubscriptionRef<RecordingState>;
  readonly scope: Scope.CloseableScope;
}

const setup = (): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const recState = yield* SubscriptionRef.make<RecordingState>(idleRecordingState);
    const recApi: RecordingServiceApi = {
      setLanguage: () => Effect.succeed(false),
      claimCompletion: () => Effect.succeed(false),
      resolveCompletion: () => Effect.void,
      state: recState,
      level: yield* SubscriptionRef.make(0),
      start: () => Effect.succeed('rec_fake'),
      stop: () => Effect.void,
      pause: () => Effect.succeed(false),
      resume: () => Effect.succeed(false),
      keepRecording: () => Effect.succeed(true),
      pauseFromPrompt: () => Effect.succeed(true),
    };
    const recLayer = Layer.succeed(RecordingService, recApi);

    const micActivityLayer = MicActivityLive.pipe(
      Layer.provide(logger.layer),
      Layer.provide(testTelemetryLayer)
    );
    const detectionLayer = DetectionServiceLive.pipe(
      Layer.provide(recLayer),
      Layer.provide(DetectionBridgeLive),
      Layer.provide(micActivityLayer)
    );
    const scope = yield* Scope.make();
    const ctx = yield* Layer.build(Layer.merge(micActivityLayer, detectionLayer)).pipe(
      Scope.extend(scope)
    );

    return {
      detection: Context.get(ctx, DetectionService),
      micActivity: Context.get(ctx, MicActivity),
      recState,
      scope,
    } satisfies Harness;
  });

const status = (h: Harness): Effect.Effect<string> =>
  SubscriptionRef.get(h.detection.state).pipe(Effect.map(s => s.status));

const setRecStatus = (h: Harness, next: RecordingStatus): Effect.Effect<void> =>
  SubscriptionRef.update(h.recState, s => ({ ...s, status: next }));

describe('MicActivity → DetectionService', () => {
  it.effect('spawns the mic-detector child (no args) on acquire', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* poll(
        Effect.sync(() => control.children.length === 1),
        'child spawned'
      );
      const child = control.last();
      assert.deepStrictEqual(child.args, [], 'mic-detector takes no CLI args');
      assert.isTrue(child.running);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('publishes the latest snapshot with its receive time', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* poll(
        Effect.sync(() => control.children.length === 1),
        'child spawned'
      );
      control.last().stdout.pushData(
        `${JSON.stringify({
          type: 'snapshot',
          timestampMs: 123,
          apps: [
            {
              bundleId: ZOOM,
              pid: 1,
              detectedAtMs: 123,
              inputDevices: [{ uid: 'mic-1', name: 'Studio Mic' }],
            },
          ],
        })}\n`
      );
      yield* settle;

      const latest = yield* SubscriptionRef.get(h.micActivity.latest);
      assert.isTrue(Option.isSome(latest));
      if (Option.isSome(latest)) {
        assert.strictEqual(latest.value.receivedAtMs, 0);
        assert.deepStrictEqual(latest.value.snapshot.apps[0]?.inputDevices, [
          { uid: 'mic-1', name: 'Studio Mic' },
        ]);
      }

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('sustained Zoom → detected only AFTER the ~4 s delay, not before', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* poll(
        Effect.sync(() => control.children.length === 1),
        'child spawned'
      );
      const child = control.last();

      // t0: Zoom takes the mic. Not enough sustained activity yet.
      child.stdout.pushData(snapLine([ZOOM], 0));
      yield* settle;
      assert.strictEqual(yield* status(h), 'idle');

      // Just before the delay → still idle.
      yield* TestClock.adjust(Duration.millis(DETECTION_DELAY_MS - 1));
      child.stdout.pushData(snapLine([ZOOM], DETECTION_DELAY_MS - 1));
      yield* settle;
      assert.strictEqual(yield* status(h), 'idle', 'no pill before the delay elapses');

      // Cross the delay → detected.
      yield* TestClock.adjust(Duration.millis(2));
      child.stdout.pushData(snapLine([ZOOM], DETECTION_DELAY_MS + 1));
      yield* settle;
      const st = yield* SubscriptionRef.get(h.detection.state);
      assert.strictEqual(st.status, 'detected');
      assert.strictEqual(st.detection?.bundleId, ZOOM);
      assert.strictEqual(st.detection?.displayName, 'Zoom');
      assert.strictEqual(st.detection?.confidence, 1);

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a blip shorter than the delay never fires', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* poll(
        Effect.sync(() => control.children.length === 1),
        'child spawned'
      );
      const child = control.last();

      child.stdout.pushData(snapLine([ZOOM], 0));
      yield* settle;
      // Zoom vanishes a second later — its run resets.
      yield* TestClock.adjust(Duration.seconds(1));
      child.stdout.pushData(snapLine([], 1_000));
      yield* settle;
      // Even long past the original delay, the reset run has not re-accumulated.
      yield* TestClock.adjust(Duration.seconds(10));
      child.stdout.pushData(snapLine([ZOOM], 11_000));
      yield* settle;
      assert.strictEqual(yield* status(h), 'idle');

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('an unknown app stays below the confidence floor', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* poll(
        Effect.sync(() => control.children.length === 1),
        'child spawned'
      );
      const child = control.last();

      child.stdout.pushData(snapLine([UNKNOWN], 0));
      yield* settle;
      yield* TestClock.adjust(Duration.seconds(30));
      child.stdout.pushData(snapLine([UNKNOWN], 30_000));
      yield* settle;
      assert.strictEqual(yield* status(h), 'idle');

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('dismiss cools the app down for ~5 min, then it may fire again', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* poll(
        Effect.sync(() => control.children.length === 1),
        'child spawned'
      );
      const child = control.last();

      // Reach detected.
      child.stdout.pushData(snapLine([ZOOM], 0));
      yield* settle;
      yield* TestClock.adjust(Duration.millis(DETECTION_DELAY_MS + 1));
      child.stdout.pushData(snapLine([ZOOM], DETECTION_DELAY_MS + 1));
      yield* settle;
      assert.strictEqual(yield* status(h), 'detected');

      // Dismiss the pill → cooldown starts.
      yield* h.detection.dismiss;
      yield* settle;
      assert.strictEqual(yield* status(h), 'idle');

      // Still in the window (Zoom keeps holding the mic) → stays idle.
      yield* TestClock.adjust(Duration.seconds(1));
      child.stdout.pushData(snapLine([ZOOM], 0));
      yield* settle;
      assert.strictEqual(yield* status(h), 'idle', 'suppressed during the cooldown');

      // Past the cooldown → detected again.
      yield* TestClock.adjust(Duration.millis(COOLDOWN_MS));
      child.stdout.pushData(snapLine([ZOOM], 0));
      yield* settle;
      assert.strictEqual(yield* status(h), 'detected', 'cooldown lifted');

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('an active recording suppresses detection', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* poll(
        Effect.sync(() => control.children.length === 1),
        'child spawned'
      );
      const child = control.last();

      // Reach detected first.
      child.stdout.pushData(snapLine([ZOOM], 0));
      yield* settle;
      yield* TestClock.adjust(Duration.millis(DETECTION_DELAY_MS + 1));
      child.stdout.pushData(snapLine([ZOOM], 0));
      yield* settle;
      assert.strictEqual(yield* status(h), 'detected');

      // A recording begins → the pill is suppressed even while Zoom keeps going.
      yield* setRecStatus(h, 'recording');
      yield* settle;
      assert.strictEqual(yield* status(h), 'idle', 'no detection while recording');
      child.stdout.pushData(snapLine([ZOOM], 0));
      yield* settle;
      assert.strictEqual(yield* status(h), 'idle');

      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    'restarts the mic-detector on unexpected exit with backoff (bounded, not fixed-3 s)',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* poll(
          Effect.sync(() => control.children.length === 1),
          'first child spawned'
        );
        const first = control.last();

        first.stdout.pushData(snapLine([ZOOM], 0));
        yield* settle;
        assert.isTrue(Option.isSome(yield* SubscriptionRef.get(h.micActivity.latest)));

        // The detector dies on its own.
        first.simulateExit(1, null);
        yield* settle;
        assert.isFalse(first.running, 'crashed child is gone');
        assert.isTrue(
          Option.isNone(yield* SubscriptionRef.get(h.micActivity.latest)),
          'latest snapshot is cleared as soon as the child exits'
        );
        // No restart before the backoff elapses.
        assert.strictEqual(control.children.length, 1, 'no immediate respawn (not a hot loop)');

        // Advance past the first exponential step → it respawns.
        yield* TestClock.adjust(Duration.seconds(1));
        yield* poll(
          Effect.sync(() => control.children.length === 2),
          'respawned after backoff'
        );
        assert.isTrue(control.last().running, 'a fresh detector is running');

        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('scope close (sign-out / quit) reaps the child — no orphan, no leaked listeners', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* poll(
        Effect.sync(() => control.children.length === 1),
        'child spawned'
      );
      const child = control.last();
      assert.strictEqual(child.stdout.listenerCount('data'), 1);
      assert.strictEqual(child.listenerCount('exit'), 1);

      yield* Scope.close(h.scope, Exit.void);

      assert.deepStrictEqual(child.killSignals, ['SIGTERM']);
      assert.isFalse(child.running, 'no orphaned detector process');
      assert.strictEqual(child.stdout.listenerCount('data'), 0);
      assert.strictEqual(child.stderr.listenerCount('data'), 0);
      assert.strictEqual(child.listenerCount('error'), 0);
      assert.strictEqual(child.listenerCount('exit'), 0);
    })
  );
});
