/**
 * Notify-window IPC handler tests.
 *
 * Headless membrane coverage against the REAL WindowRegistry (fake-electron) +
 * real Detection/Recording bridges with fake session services:
 *  - a foreign sender is rejected (the security boundary) + logged;
 *  - a detection produces the call-detected card push; clearing/disabling
 *    removes it; the TestClock-driven sweeper expires it;
 *  - notify:action 'take-notes' starts a dual recording and removes the card;
 *    'dismiss' removes the card AND applies the detection cooldown;
 *  - setInteractive maps onto the notify window's click-through.
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope, SubscriptionRef, TestClock } from 'effect';
import { vi } from 'vitest';
import { NOTIFY_CHANNELS, type NotifyStateView } from '@prismical/desktop-contracts';
import type { FakeElectron, FakeBrowserWindow } from '../helpers/fake-electron';
import {
  makeTestLogger,
  testConfigLayer,
  testI18nLayer,
  type TestLogger,
} from '../helpers/test-layers';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { ElectronAppLive } from '../../src/main/infra/electron/live';
import { WindowRegistry, type WindowRegistryService } from '../../src/main/domains/windows/service';
import { WindowRegistryLive } from '../../src/main/domains/windows/live';
import { SettingsService, type SettingsServiceApi } from '../../src/main/domains/settings/service';
import { SettingsServiceLive } from '../../src/main/domains/settings/live';
import {
  RecordingBridge,
  RecordingBridgeLive,
  type RecordingBridgeApi,
} from '../../src/main/domains/recording/bridge';
import {
  DetectionBridge,
  DetectionBridgeLive,
  type DetectionBridgeApi,
} from '../../src/main/domains/detection/bridge';
import { AppModeService, makeAppMode } from '../../src/main/domains/app-mode/service';
import { FloatBridgeLive } from '../../src/main/domains/windows/float-bridge';
import { AuthService, type AuthApi } from '../../src/main/domains/auth/service';
import { initialAuthState, type AuthState } from '../../src/main/domains/auth/policy';
import { registerNotifyWindowHandlers } from '../../src/main/infra/ipc/notify-window-handlers';
import {
  idleRecordingState,
  type RecordingServiceApi,
  type RecordingState,
} from '../../src/main/domains/recording/service';
import { idleDetectionState, type DetectionState } from '../../src/main/domains/detection/policy';
import type { DetectionServiceApi } from '../../src/main/domains/detection/service';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

/** Let the forked fibers settle without advancing any clock. */
const flush: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 8; i += 1) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
  }
});

const detectedState = (detectedAt = 4_000): DetectionState => ({
  status: 'detected',
  detection: {
    bundleId: 'us.zoom.xos',
    displayName: 'Zoom',
    category: 'native',
    weight: 100,
    confidence: 1,
    since: 0,
    detectedAt,
  },
});

interface Harness {
  readonly logger: TestLogger;
  readonly windows: WindowRegistryService;
  readonly recordingBridge: RecordingBridgeApi;
  readonly detectionBridge: DetectionBridgeApi;
  readonly settings: SettingsServiceApi;
  readonly notifyWin: FakeBrowserWindow;
  readonly scope: Scope.CloseableScope;
}

const setup = (): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const scope = yield* Scope.make();
    const settingsLayer = SettingsServiceLive.pipe(
      Layer.provide(makeFakeOperationalDb().layer),
      Layer.provide(logger.layer)
    );
    const windowRegistryLayer = WindowRegistryLive.pipe(
      Layer.provide(testConfigLayer()),
      Layer.provide(ElectronAppLive.pipe(Layer.provide(logger.layer))),
      Layer.provide(settingsLayer),
      Layer.provide(logger.layer)
    );
    // Signed in as far as the float-open guard cares (accounts + activeSub).
    const authStub = {
      sessionState: yield* SubscriptionRef.make<AuthState>({
        ...initialAuthState,
        accounts: { sub_1: { sub: 'sub_1', email: 'user@example.com', orgs: [] } },
        activeSub: 'sub_1',
      }),
    } as unknown as AuthApi;
    const env = Layer.mergeAll(
      testConfigLayer(),
      logger.layer,
      testI18nLayer('ja'),
      settingsLayer,
      windowRegistryLayer,
      FloatBridgeLive.pipe(
        Layer.provide(windowRegistryLayer),
        Layer.provide(RecordingBridgeLive),
        Layer.provide(Layer.succeed(AuthService, authStub)),
        Layer.provide(Layer.effect(AppModeService, makeAppMode('cloud', true))),
        Layer.provide(logger.layer)
      ),
      RecordingBridgeLive,
      DetectionBridgeLive
    );
    const ctx = yield* Layer.build(env).pipe(Scope.extend(scope));
    const windows = Context.get(ctx, WindowRegistry);
    const recordingBridge = Context.get(ctx, RecordingBridge);
    const detectionBridge = Context.get(ctx, DetectionBridge);
    const settings = Context.get(ctx, SettingsService);

    yield* windows.openNotifyWindow.pipe(Scope.extend(scope));
    const notifyWin = fake.__windowInstances().at(-1) as FakeBrowserWindow;

    yield* registerNotifyWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));

    return {
      logger,
      windows,
      recordingBridge,
      detectionBridge,
      settings,
      notifyWin,
      scope,
    } satisfies Harness;
  }).pipe(Effect.orDie);

const invoke = (
  channel: string,
  senderId: number,
  payload?: unknown
): Effect.Effect<'ok' | 'rejected'> =>
  Effect.promise(() =>
    fake.ipcMain.invoke(channel, { sender: { id: senderId } }, payload).then(
      () => 'ok' as const,
      () => 'rejected' as const
    )
  );

const invokeValue = <T>(channel: string, senderId: number): Effect.Effect<T> =>
  Effect.promise(() => fake.ipcMain.invoke(channel, { sender: { id: senderId } }) as Promise<T>);

const lastStack = (win: FakeBrowserWindow): NotifyStateView | undefined =>
  win.webContents.sent.filter(m => m.channel === NOTIFY_CHANNELS.stateStream).at(-1)?.payload as
    | NotifyStateView
    | undefined;

/** Register a detected session; returns the session scope + dismiss counter. */
const registerDetection = (h: Harness, detectedAt = 4_000) =>
  Effect.gen(function* () {
    const detState = yield* SubscriptionRef.make<DetectionState>(detectedState(detectedAt));
    let dismissCount = 0;
    const detApi: DetectionServiceApi = {
      state: detState,
      dismiss: Effect.sync(() => {
        dismissCount += 1;
      }),
    };
    const sessionScope = yield* Scope.make();
    yield* h.detectionBridge.register(detApi).pipe(Scope.extend(sessionScope));
    yield* flush;
    return { detState, sessionScope, dismissCount: () => dismissCount };
  });

describe('notify-window IPC handlers', () => {
  it.effect('a foreign sender is rejected and logged', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.strictEqual(yield* invoke(NOTIFY_CHANNELS.stateGet, 987_654), 'rejected');
      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.setInteractive, 987_654, { interactive: true }),
        'rejected'
      );
      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.action, 987_654, { cardId: 'x', actionId: 'dismiss' }),
        'rejected'
      );
      assert.isDefined(h.logger.find(e => e.message === 'notify ipc rejected: unknown sender'));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('state:get returns a localized empty snapshot after the renderer attaches', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const state = yield* invokeValue<NotifyStateView>(
        NOTIFY_CHANNELS.stateGet,
        h.notifyWin.webContents.id
      );

      assert.deepStrictEqual(state, { locale: 'ja', cards: [] } satisfies NotifyStateView);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('setInteractive grants interactivity ONLY while cards exist (zero-card guard)', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const senderId = h.notifyWin.webContents.id;
      h.notifyWin.ignoreMouseCalls.length = 0;

      // Zero cards: interactive:true is NOT honored — a crashed-while-hovered
      // renderer must never leave an invisible click-eating corner.
      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.setInteractive, senderId, { interactive: true }),
        'ok'
      );
      assert.strictEqual(h.notifyWin.ignoreMouseCalls.length, 0);

      // With a live card the hover toggle works both ways.
      const det = yield* registerDetection(h);
      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.setInteractive, senderId, { interactive: true }),
        'ok'
      );
      assert.deepStrictEqual(h.notifyWin.ignoreMouseCalls.at(-1), {
        ignore: false,
        options: { forward: true },
      });
      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.setInteractive, senderId, { interactive: false }),
        'ok'
      );
      assert.deepStrictEqual(h.notifyWin.ignoreMouseCalls.at(-1), {
        ignore: true,
        options: { forward: true },
      });
      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.setInteractive, senderId, { nope: 1 }),
        'rejected'
      );
      yield* Scope.close(det.sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a detection produces the call-detected card; clearing removes it', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const det = yield* registerDetection(h);

      const stack = lastStack(h.notifyWin);
      assert.strictEqual(stack?.locale, 'ja');
      assert.strictEqual(stack?.cards.length, 1);
      assert.strictEqual(stack?.cards[0].kind, 'call-detected');
      assert.strictEqual(stack?.cards[0].id, 'call:us.zoom.xos:4000');
      assert.strictEqual(stack?.cards[0].title, '会議を検出しました');
      assert.strictEqual(stack?.cards[0].subtitle, 'Zoom がマイクを使用しています');
      assert.strictEqual(stack?.cards[0].actions[0]?.label, 'ノートを取る');

      // Detection clears (meeting ended) → the card leaves the stack.
      yield* SubscriptionRef.set(det.detState, idleDetectionState);
      yield* flush;
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 0);

      yield* Scope.close(det.sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('meetingNotifications OFF suppresses the card (and clears a live one)', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const det = yield* registerDetection(h);
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 1);

      yield* h.settings.set({ meetingNotifications: false });
      yield* flush;
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 0);

      // Re-enabling re-cards the still-live detection.
      yield* h.settings.set({ meetingNotifications: true });
      yield* flush;
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 1);

      yield* Scope.close(det.sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('the sweeper auto-dismisses an expired card (TestClock)', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const det = yield* registerDetection(h);
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 1);

      // Past the 12s TTL + a sweep tick.
      yield* TestClock.adjust('13 seconds');
      yield* flush;
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 0);

      // Auto-dismiss is NOT the cooldown dismiss — detection untouched.
      assert.strictEqual(det.dismissCount(), 0);

      // An unrelated re-emission of the SAME detection must NOT resurrect the
      // expired card (the invariant is the handlers' own, not the detection
      // domain's dedupe).
      yield* SubscriptionRef.set(det.detState, detectedState(4_000));
      yield* flush;
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 0, 'expired card stays gone');

      // A NEW detection (fresh detectedAt) cards normally again.
      yield* SubscriptionRef.set(det.detState, detectedState(99_000));
      yield* flush;
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 1);
      assert.strictEqual(lastStack(h.notifyWin)?.cards[0].id, 'call:us.zoom.xos:99000');

      yield* Scope.close(det.sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect("action 'take-notes' expands the float (fresh + autostart) and removes the card", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const det = yield* registerDetection(h);

      const starts: unknown[] = [];
      const recApi: RecordingServiceApi = {
        claimCompletion: () => Effect.succeed(false),
        resolveCompletion: () => Effect.void,
        state: yield* SubscriptionRef.make<RecordingState>(idleRecordingState),
        level: yield* SubscriptionRef.make(0),
        start: input =>
          Effect.sync(() => {
            starts.push(input);
            return 'rec_new';
          }),
        stop: () => Effect.void,
        pause: () => Effect.succeed(false),
        resume: () => Effect.succeed(false),
        keepRecording: () => Effect.succeed(true),
        pauseFromPrompt: () => Effect.succeed(true),
      };
      const recScope = yield* Scope.make();
      yield* h.recordingBridge.register(recApi).pipe(Scope.extend(recScope));

      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.action, h.notifyWin.webContents.id, {
          cardId: 'call:us.zoom.xos:4000',
          actionId: 'take-notes',
        }),
        'ok'
      );
      yield* flush;
      // Expansion rule: no main-side start — the float opens on a fresh
      // note with autostart and ITS view starts the recording note-associated.
      assert.deepStrictEqual(starts, []);
      const floatWin = fake.__windowInstances().at(-1) as FakeBrowserWindow;
      assert.notStrictEqual(floatWin, h.notifyWin);
      assert.match(floatWin.loadedUrls.at(-1) ?? '', /#\/float\?fresh=1&autostart=1$/);
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 0);
      // Take-notes is not a dismiss — no cooldown.
      assert.strictEqual(det.dismissCount(), 0);

      yield* Scope.close(recScope, Exit.void);
      yield* Scope.close(det.sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect("action 'dismiss' removes the card AND applies the detection cooldown", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const det = yield* registerDetection(h);

      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.action, h.notifyWin.webContents.id, {
          cardId: 'call:us.zoom.xos:4000',
          actionId: 'dismiss',
        }),
        'ok'
      );
      yield* flush;
      assert.strictEqual(lastStack(h.notifyWin)?.cards.length, 0);
      assert.strictEqual(det.dismissCount(), 1);

      // An unknown/expired card id is a graceful no-op, never a throw.
      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.action, h.notifyWin.webContents.id, {
          cardId: 'call:gone:1',
          actionId: 'dismiss',
        }),
        'ok'
      );
      // A malformed payload rejects.
      assert.strictEqual(
        yield* invoke(NOTIFY_CHANNELS.action, h.notifyWin.webContents.id, { cardId: 1 }),
        'rejected'
      );

      yield* Scope.close(det.sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  // ---- Auto-pause on silence — the second card producer -------------------------------------

  it.effect(
    "main's auto-pause prompt becomes an amber card, and clearing it removes the card",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const recState = yield* SubscriptionRef.make<RecordingState>(idleRecordingState);
        const recApi: RecordingServiceApi = {
          claimCompletion: () => Effect.succeed(false),
        resolveCompletion: () => Effect.void,
          state: recState,
          level: yield* SubscriptionRef.make(0),
          start: () => Effect.succeed('rec_1'),
          stop: () => Effect.void,
          pause: () => Effect.succeed(true),
          resume: () => Effect.succeed(true),
          keepRecording: () => Effect.succeed(true),
          pauseFromPrompt: () => Effect.succeed(true),
        };
        const recScope = yield* Scope.make();
        yield* h.recordingBridge.register(recApi).pipe(Scope.extend(recScope));

        yield* SubscriptionRef.set(recState, {
          ...idleRecordingState,
          recordingId: 'rec_1',
          status: 'recording',
          autoPausePrompt: { graceMs: 20_000, deadlineMs: 1_020_000 },
        });
        yield* flush;
        const shown = lastStack(h.notifyWin);
        assert.strictEqual(shown?.cards[0]?.kind, 'auto-pause');
        assert.strictEqual(shown?.cards[0]?.accent, 'amber');
        assert.strictEqual(shown?.cards[0]?.title, 'まだいますか？');

        // The pause commits ⇒ main clears the prompt ⇒ the card goes with it. Nothing else can
        // retract it: the sweeper deliberately exempts this kind.
        yield* SubscriptionRef.set(recState, {
          ...idleRecordingState,
          recordingId: 'rec_1',
          status: 'paused',
          autoPausePrompt: null,
        });
        yield* flush;
        assert.deepStrictEqual(lastStack(h.notifyWin)?.cards, []);

        yield* Scope.close(recScope, Exit.void);
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('a card-body dismiss on the auto-pause card means KEEP RECORDING, not pause', () =>
    Effect.gen(function* () {
      // The inverse of the detection card's dismiss semantics, and the one interaction
      // A body click is ambiguous for this kind. Touching the card proves a human
      // is present, so the gesture must resolve toward NOT pausing.
      const h = yield* setup();
      const calls: string[] = [];
      const recState = yield* SubscriptionRef.make<RecordingState>({
        ...idleRecordingState,
        recordingId: 'rec_1',
        status: 'recording',
        autoPausePrompt: { graceMs: 20_000, deadlineMs: 1_020_000 },
      });
      const recApi: RecordingServiceApi = {
        claimCompletion: () => Effect.succeed(false),
        resolveCompletion: () => Effect.void,
        state: recState,
        level: yield* SubscriptionRef.make(0),
        start: () => Effect.succeed('rec_1'),
        stop: () => Effect.void,
        pause: () =>
          Effect.sync(() => {
            calls.push('pause');
            return true;
          }),
        resume: () => Effect.succeed(true),
        keepRecording: () =>
          Effect.sync(() => {
            calls.push('keep');
            return true;
          }),
        pauseFromPrompt: () =>
          Effect.sync(() => {
            calls.push('prompt-pause');
            return true;
          }),
      };
      const recScope = yield* Scope.make();
      yield* h.recordingBridge.register(recApi).pipe(Scope.extend(recScope));
      yield* flush;

      yield* invoke(NOTIFY_CHANNELS.action, h.notifyWin.webContents.id, {
        cardId: 'auto-pause:1020000',
        actionId: 'dismiss',
      });
      assert.deepStrictEqual(calls, ['keep']);

      yield* invoke(NOTIFY_CHANNELS.action, h.notifyWin.webContents.id, {
        cardId: 'auto-pause:1020000',
        actionId: 'pause',
      });
      // Routed through the machine, so the pause is attributed to the user who chose it.
      assert.deepStrictEqual(calls, ['keep', 'prompt-pause']);

      yield* Scope.close(recScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});
