/**
 * Widget-window IPC handler tests.
 *
 * Headless membrane coverage against the REAL WindowRegistry (fake-electron) +
 * the real RecordingBridge with fake session services registered:
 *  - a foreign sender is rejected (the security boundary) + logged;
 *  - setInteractive maps interactive→ignoreMouse(!interactive) on the widget window;
 *  - start/stop/pause/resume route through the bridge; 2-axis drags persist
 *    per-display anchors on release only;
 *  - the push fibers project the combined sources through toWidgetState and fan
 *    the sanitized WidgetStateView / throttled widget:level out.
 * Detection uses the notification-window membrane instead; see notify-window-handlers.test.ts.
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope, SubscriptionRef, TestClock } from 'effect';
import { vi } from 'vitest';
import { WIDGET_CHANNELS, type WidgetStateView } from '@prismical/desktop-contracts';
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
import { AppModeService } from '../../src/main/domains/app-mode/service';
import { FloatBridgeLive } from '../../src/main/domains/windows/float-bridge';
import { AuthService, type AuthApi } from '../../src/main/domains/auth/service';
import { initialAuthState, type AuthState } from '../../src/main/domains/auth/policy';
import { registerWidgetWindowHandlers } from '../../src/main/infra/ipc/widget-window-handlers';
import {
  idleRecordingState,
  type RecordingServiceApi,
  type RecordingState,
} from '../../src/main/domains/recording/service';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

/** Let the forked push fiber settle without advancing any clock. */
const flush: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 8; i += 1) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
  }
});

interface Harness {
  readonly logger: TestLogger;
  readonly windows: WindowRegistryService;
  readonly recordingBridge: RecordingBridgeApi;
  readonly settings: SettingsServiceApi;
  readonly widgetWin: FakeBrowserWindow;
  readonly scope: Scope.CloseableScope;
}

// Signed in as far as the float-open guard cares (accounts + activeSub).
const signedInAuthState: AuthState = {
  ...initialAuthState,
  accounts: { sub_1: { sub: 'sub_1', email: 'user@example.com', orgs: [] } },
  activeSub: 'sub_1',
};

const setup = (): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const scope = yield* Scope.make();
    // Real SettingsService over a fake KV — feeds the visibility policy, receives
    // drag-persist writes, and seeds the widget open anchor.
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
    const authStub = {
      sessionState: yield* SubscriptionRef.make<AuthState>(signedInAuthState),
    } as unknown as AuthApi;
    const env = Layer.mergeAll(
      testConfigLayer(),
      logger.layer,
      testI18nLayer('de'),
      settingsLayer,
      windowRegistryLayer,
      FloatBridgeLive.pipe(
        Layer.provide(windowRegistryLayer),
        Layer.provide(RecordingBridgeLive),
        Layer.provide(Layer.succeed(AuthService, authStub)),
        Layer.provide(Layer.succeed(AppModeService, { mode: 'cloud', chosen: true })),
        Layer.provide(logger.layer)
      ),
      RecordingBridgeLive
    );
    const ctx = yield* Layer.build(env).pipe(Scope.extend(scope));
    const windows = Context.get(ctx, WindowRegistry);
    const recordingBridge = Context.get(ctx, RecordingBridge);
    const settings = Context.get(ctx, SettingsService);

    // The widget window is the send target AND the only valid sender identity.
    yield* windows.openWidgetWindow.pipe(Scope.extend(scope));
    const widgetWin = fake.__windowInstances().at(-1) as FakeBrowserWindow;

    yield* registerWidgetWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));

    return {
      logger,
      windows,
      recordingBridge,
      settings,
      widgetWin,
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

describe('widget-window IPC handlers', () => {
  it.effect('a foreign sender is rejected and logged', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.strictEqual(yield* invoke(WIDGET_CHANNELS.stateGet, 987_654), 'rejected');
      const result = yield* invoke(WIDGET_CHANNELS.setInteractive, 987_654, { interactive: true });
      assert.strictEqual(result, 'rejected');
      assert.isDefined(h.logger.find(e => e.message === 'widget ipc rejected: unknown sender'));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('state:get returns a localized initial snapshot after the renderer attaches', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const state = yield* invokeValue<WidgetStateView>(
        WIDGET_CHANNELS.stateGet,
        h.widgetWin.webContents.id
      );

      assert.deepStrictEqual(state, {
        locale: 'de',
        visible: true,
        mode: 'idle',
        recording: null,
      } satisfies WidgetStateView);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    'setInteractive maps interactive → ignoreMouse(!interactive) on the widget window',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const senderId = h.widgetWin.webContents.id;
        // Drop the create-time click-through call.
        h.widgetWin.ignoreMouseCalls.length = 0;

        assert.strictEqual(
          yield* invoke(WIDGET_CHANNELS.setInteractive, senderId, { interactive: true }),
          'ok'
        );
        assert.deepStrictEqual(h.widgetWin.ignoreMouseCalls.at(-1), {
          ignore: false,
          options: { forward: true },
        });
        assert.strictEqual(
          yield* invoke(WIDGET_CHANNELS.setInteractive, senderId, { interactive: false }),
          'ok'
        );
        assert.deepStrictEqual(h.widgetWin.ignoreMouseCalls.at(-1), {
          ignore: true,
          options: { forward: true },
        });

        // Invalid payload rejects (warn + reject).
        assert.strictEqual(
          yield* invoke(WIDGET_CHANNELS.setInteractive, senderId, { nope: 1 }),
          'rejected'
        );
        assert.isDefined(
          h.logger.find(e => e.message === 'widget:setInteractive rejected: invalid payload')
        );
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('stopRecording routes to the live recording via stopActive', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recState = yield* SubscriptionRef.make<RecordingState>({
        ...idleRecordingState,
        recordingId: 'rec_9',
        status: 'recording',
        captureMode: 'dual',
        requestedCaptureMode: 'dual',
      });
      const stops: string[] = [];
      const recApi: RecordingServiceApi = {
        state: recState,
        level: yield* SubscriptionRef.make(0),
        start: () => Effect.succeed('rec_new'),
        stop: id =>
          Effect.sync(() => {
            stops.push(id);
          }),
        pause: () => Effect.succeed(false),
        resume: () => Effect.succeed(false),
        keepRecording: () => Effect.succeed(true),
        pauseFromPrompt: () => Effect.succeed(true),
      };
      const sessionScope = yield* Scope.make();
      yield* h.recordingBridge.register(recApi).pipe(Scope.extend(sessionScope));

      assert.strictEqual(
        yield* invoke(WIDGET_CHANNELS.stopRecording, h.widgetWin.webContents.id),
        'ok'
      );
      assert.deepStrictEqual(stops, ['rec_9']);

      yield* Scope.close(sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    'startRecording expands the float on a fresh note with autostart',
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const recState = yield* SubscriptionRef.make<RecordingState>(idleRecordingState);
        const starts: unknown[] = [];
        const recApi: RecordingServiceApi = {
          state: recState,
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
        const sessionScope = yield* Scope.make();
        yield* h.recordingBridge.register(recApi).pipe(Scope.extend(sessionScope));

        assert.strictEqual(
          yield* invoke(WIDGET_CHANNELS.startRecording, h.widgetWin.webContents.id),
          'ok'
        );
        // NO main-side start: the float view creates the fresh note and starts
        // the recording against it (note-associated from the first frame).
        assert.deepStrictEqual(starts, []);
        const floatWin = fake.__windowInstances().at(-1) as FakeBrowserWindow;
        assert.notStrictEqual(floatWin, h.widgetWin);
        assert.match(floatWin.loadedUrls.at(-1) ?? '', /#\/float\?fresh=1&autostart=1$/);

        yield* Scope.close(sessionScope, Exit.void);
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('the push fiber fans a sanitized WidgetStateView out on widget:state', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* flush;

      // Startup: main window unfocused + no session ⇒ a visible idle projection.
      const first = h.widgetWin.webContents.sent.filter(
        m => m.channel === WIDGET_CHANNELS.stateStream
      );
      assert.isAtLeast(first.length, 1, 'an initial widget:state push');
      assert.deepStrictEqual(first.at(-1)?.payload, {
        locale: 'de',
        visible: true,
        mode: 'idle',
        recording: null,
      } satisfies WidgetStateView);

      // Register a recording session ⇒ the projection swaps to the recording pill.
      const recState = yield* SubscriptionRef.make<RecordingState>({
        ...idleRecordingState,
        recordingId: 'rec_push',
        status: 'recording',
        captureMode: 'dual',
        requestedCaptureMode: 'dual',
        startedAt: 1_700_000_000_000,
      });
      const recApi: RecordingServiceApi = {
        state: recState,
        level: yield* SubscriptionRef.make(0),
        start: () => Effect.succeed('rec_new'),
        stop: () => Effect.void,
        pause: () => Effect.succeed(false),
        resume: () => Effect.succeed(false),
        keepRecording: () => Effect.succeed(true),
        pauseFromPrompt: () => Effect.succeed(true),
      };
      const sessionScope = yield* Scope.make();
      yield* h.recordingBridge.register(recApi).pipe(Scope.extend(sessionScope));
      yield* flush;

      const latest = h.widgetWin.webContents.sent
        .filter(m => m.channel === WIDGET_CHANNELS.stateStream)
        .at(-1)?.payload as WidgetStateView;
      assert.strictEqual(latest.mode, 'recording');
      assert.strictEqual(latest.visible, true);
      assert.deepStrictEqual(latest.recording, {
        status: 'recording',
        micOnly: false,
        canPause: true,
        startedAt: 1_700_000_000_000,
        pausedAccumMs: 0,
        elapsedMs: 0,
        elapsedAt: null,
      });

      yield* Scope.close(sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  // --- Two-axis drag verbs ---------------------------------------------------
  // The 1440x900 fake display (id 1): x band 12..1048, y band 24..636. A drag to
  // (530, 24) with no grab offset lands mid-band horizontally, top vertically.

  it.effect('dragEnd repositions the dock AND persists dockAnchors + dockDisplayId', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const before = yield* h.settings.get;
      assert.deepStrictEqual(before.dockAnchors, {});
      assert.strictEqual(before.dockDisplayId, null);

      assert.strictEqual(
        yield* invoke(WIDGET_CHANNELS.dragEnd, h.widgetWin.webContents.id, {
          screenX: 530,
          screenY: 24,
          pointerOffsetX: 0,
          pointerOffsetY: 0,
        }),
        'ok'
      );
      assert.deepStrictEqual(h.widgetWin.setBoundsCalls.at(-1), {
        x: 530,
        y: 24,
        width: 380,
        height: 240,
      });
      const after = yield* h.settings.get;
      assert.deepStrictEqual(after.dockAnchors, { '1': { nx: 0.5, ny: 0 } });
      assert.strictEqual(after.dockDisplayId, '1');
      // The legacy anchor row is read-only now — a drag never writes it.
      assert.strictEqual(after.widgetNormalizedY, 0.5);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('dragEnd merges into dockAnchors (other displays keep their entry)', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.settings.set({ dockAnchors: { '7': { nx: 0.25, ny: 0.75 } } });

      assert.strictEqual(
        yield* invoke(WIDGET_CHANNELS.dragEnd, h.widgetWin.webContents.id, {
          screenX: 530,
          screenY: 330,
          pointerOffsetX: 0,
          pointerOffsetY: 0,
        }),
        'ok'
      );
      assert.deepStrictEqual((yield* h.settings.get).dockAnchors, {
        '7': { nx: 0.25, ny: 0.75 },
        '1': { nx: 0.5, ny: 0.5 },
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('dragMove repositions live but does NOT persist (high-frequency)', () =>
    Effect.gen(function* () {
      const h = yield* setup();

      assert.strictEqual(
        yield* invoke(WIDGET_CHANNELS.dragMove, h.widgetWin.webContents.id, {
          screenX: 20,
          screenY: 24,
          pointerOffsetX: 0,
          pointerOffsetY: 0,
        }),
        'ok'
      );
      // x=20 is within the 16px magnetic zone of the left band edge → snaps to 12.
      assert.deepStrictEqual(h.widgetWin.setBoundsCalls.at(-1), {
        x: 12,
        y: 24,
        width: 380,
        height: 240,
      });
      // Nothing persisted — only the release writes.
      const settings = yield* h.settings.get;
      assert.deepStrictEqual(settings.dockAnchors, {});
      assert.strictEqual(settings.dockDisplayId, null);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a malformed drag payload is rejected + logged (missing X axis)', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.strictEqual(
        yield* invoke(WIDGET_CHANNELS.dragMove, h.widgetWin.webContents.id, {
          screenY: 24,
          pointerOffsetY: 0,
        }),
        'rejected'
      );
      assert.isDefined(h.logger.find(e => e.message === 'widget:drag rejected: invalid payload'));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  // --- Pause/resume verbs and the widget:level lane -------------------------

  it.effect('pauseRecording/resumeRecording settle safely with no signed-in session', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const senderId = h.widgetWin.webContents.id;
      // No session is a graceful no-op, never a rejected invoke.
      assert.strictEqual(yield* invoke(WIDGET_CHANNELS.pauseRecording, senderId), 'ok');
      assert.strictEqual(yield* invoke(WIDGET_CHANNELS.resumeRecording, senderId), 'ok');
      // A foreign sender is still rejected.
      assert.strictEqual(yield* invoke(WIDGET_CHANNELS.pauseRecording, 987_654), 'rejected');
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('pauseRecording/resumeRecording route to the active recording service', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const recState = yield* SubscriptionRef.make<RecordingState>({
        ...idleRecordingState,
        recordingId: 'rec_pause',
        status: 'recording',
        captureMode: 'dual',
        requestedCaptureMode: 'dual',
      });
      const calls: string[] = [];
      const recApi: RecordingServiceApi = {
        state: recState,
        level: yield* SubscriptionRef.make(0),
        keepRecording: () => Effect.succeed(true),
        pauseFromPrompt: () => Effect.succeed(true),
        start: () => Effect.succeed('rec_new'),
        stop: () => Effect.void,
        pause: id =>
          Effect.sync(() => {
            calls.push(`pause:${id}`);
          }).pipe(
            Effect.zipRight(
              SubscriptionRef.update(recState, state => ({ ...state, status: 'paused' as const }))
            ),
            Effect.as(true)
          ),
        resume: id =>
          Effect.sync(() => {
            calls.push(`resume:${id}`);
          }).pipe(
            Effect.zipRight(
              SubscriptionRef.update(recState, state => ({
                ...state,
                status: 'recording' as const,
              }))
            ),
            Effect.as(true)
          ),
      };
      const sessionScope = yield* Scope.make();
      yield* h.recordingBridge.register(recApi).pipe(Scope.extend(sessionScope));
      const senderId = h.widgetWin.webContents.id;

      assert.strictEqual(yield* invoke(WIDGET_CHANNELS.pauseRecording, senderId), 'ok');
      assert.strictEqual(yield* invoke(WIDGET_CHANNELS.resumeRecording, senderId), 'ok');
      assert.deepStrictEqual(calls, ['pause:rec_pause', 'resume:rec_pause']);

      yield* Scope.close(sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('widget:level fans the session level out ONLY while a visible recording pill', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const levelRef = yield* SubscriptionRef.make(0);
      const recState = yield* SubscriptionRef.make<RecordingState>(idleRecordingState);
      const recApi: RecordingServiceApi = {
        state: recState,
        level: levelRef,
        start: () => Effect.succeed('rec_new'),
        stop: () => Effect.void,
        pause: () => Effect.succeed(false),
        resume: () => Effect.succeed(false),
        keepRecording: () => Effect.succeed(true),
        pauseFromPrompt: () => Effect.succeed(true),
      };
      const sessionScope = yield* Scope.make();
      yield* h.recordingBridge.register(recApi).pipe(Scope.extend(sessionScope));
      yield* flush;

      // The throttle rides the TestClock: refill its 80ms token bucket before
      // each emission we want to observe (the fiber consumed the first token on
      // the pre-registration idle 0).
      yield* TestClock.adjust('200 millis');
      yield* flush;

      // Idle (gate closed): a level emission must NOT cross.
      yield* SubscriptionRef.set(levelRef, 0.8);
      yield* flush;
      assert.strictEqual(
        h.widgetWin.webContents.sent.filter(m => m.channel === WIDGET_CHANNELS.levelStream).length,
        0,
        'no level push while idle'
      );

      // Recording + unfocused ⇒ visible recording pill ⇒ the gate opens.
      yield* SubscriptionRef.set(recState, {
        ...idleRecordingState,
        recordingId: 'rec_1',
        status: 'recording',
        captureMode: 'dual',
        requestedCaptureMode: 'dual',
        startedAt: 1_000,
      });
      yield* flush;
      yield* TestClock.adjust('200 millis');
      yield* flush;
      yield* SubscriptionRef.set(levelRef, 0.5);
      yield* flush;
      const sent = h.widgetWin.webContents.sent.filter(
        m => m.channel === WIDGET_CHANNELS.levelStream
      );
      assert.isAtLeast(sent.length, 1, 'a level push while recording+visible');
      assert.deepStrictEqual(sent.at(-1)?.payload, { level: 0.5 });

      // The gate RE-CLOSES: focusing the main window hides the pill, so a
      // further level emission must not cross even mid-recording.
      yield* SubscriptionRef.set(h.windows.mainWindowFocused, true);
      yield* flush;
      yield* TestClock.adjust('200 millis');
      yield* SubscriptionRef.set(levelRef, 0.9);
      yield* flush;
      const after = h.widgetWin.webContents.sent.filter(
        m => m.channel === WIDGET_CHANNELS.levelStream
      );
      assert.strictEqual(after.length, sent.length, 'no level push once the pill hid');

      yield* Scope.close(sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  // --- Visibility policy ----------------------------------------------------

  it.effect("visibility 'never' suppresses the widget even mid-recording", () =>
    Effect.gen(function* () {
      const h = yield* setup();

      const recState = yield* SubscriptionRef.make<RecordingState>({
        ...idleRecordingState,
        recordingId: 'rec_vis',
        status: 'recording',
        captureMode: 'dual',
        requestedCaptureMode: 'dual',
        startedAt: 1_000,
      });
      const recApi: RecordingServiceApi = {
        state: recState,
        level: yield* SubscriptionRef.make(0),
        start: () => Effect.succeed('rec_new'),
        stop: () => Effect.void,
        pause: () => Effect.succeed(false),
        resume: () => Effect.succeed(false),
        keepRecording: () => Effect.succeed(true),
        pauseFromPrompt: () => Effect.succeed(true),
      };
      const sessionScope = yield* Scope.make();
      yield* h.recordingBridge.register(recApi).pipe(Scope.extend(sessionScope));
      // A recording is normally visible (unfocused)... but 'never' hides it outright.
      yield* h.settings.set({ widgetVisibility: 'never' });
      yield* flush;

      const latest = h.widgetWin.webContents.sent
        .filter(m => m.channel === WIDGET_CHANNELS.stateStream)
        .at(-1)?.payload as WidgetStateView;
      assert.strictEqual(latest.visible, false);
      assert.strictEqual(latest.mode, 'recording');

      yield* Scope.close(sessionScope, Exit.void);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  // --- Settings-reactive dock plumbing fibers -------------------------------

  it.effect('flipping dockContentProtection applies to the live dock windows', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* flush;
      // Create-time self-apply: the widget window opened with the persisted
      // value (false by default).
      assert.deepStrictEqual(h.widgetWin.contentProtectionCalls, [false]);

      yield* h.settings.set({ dockContentProtection: true });
      yield* flush;
      assert.strictEqual(h.widgetWin.contentProtectionCalls.at(-1), true);

      yield* h.settings.set({ dockContentProtection: false });
      yield* flush;
      assert.strictEqual(h.widgetWin.contentProtectionCalls.at(-1), false);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('clearing dockAnchors (reset dock position) re-seeds the pill bounds', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      // Drag the pill somewhere non-default and persist.
      assert.strictEqual(
        yield* invoke(WIDGET_CHANNELS.dragEnd, h.widgetWin.webContents.id, {
          screenX: 530,
          screenY: 330,
          pointerOffsetX: 0,
          pointerOffsetY: 0,
        }),
        'ok'
      );
      yield* flush;
      assert.deepStrictEqual(h.widgetWin.setBoundsCalls.at(-1), {
        x: 530,
        y: 330,
        width: 380,
        height: 240,
      });

      // The settings-UI reset clears the anchors — the fiber re-seeds the pill
      // from the (now default) settings: right-edge anchor, legacy mid-band y.
      const before = h.widgetWin.setBoundsCalls.length;
      yield* h.settings.set({ dockAnchors: {}, dockDisplayId: null });
      yield* flush;
      assert.isAbove(h.widgetWin.setBoundsCalls.length, before);
      const seeded = h.widgetWin.setBoundsCalls.at(-1);
      assert.isDefined(seeded);
      // The default anchor is the RIGHT edge (nx=1): x = workArea right - margin - width
      // (the fake primary display is 1440×900).
      assert.strictEqual(seeded?.x, 1440 - 12 - 380);
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});
