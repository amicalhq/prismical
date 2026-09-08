import { testRemoteConfigLayer } from '../helpers/remote-config';
import { testTelemetryLayer } from '../helpers/telemetry';
import { makeWire } from '@desktop/logging';
import { assert, describe, it } from '@effect/vitest';
import {
  CHANNELS,
  DEFAULT_DEVICE_SETTINGS,
  parseSessionView,
  collabPortChannel,
  streamPortChannel,
  parseModelsStateView,
  type DeviceSettings,
  type ModelsStateView,
  type RecordingStateView,
  type TransportResponse,
  type TelemetryState,
} from '@prismical/desktop-contracts';
import { Context, Effect, Exit, Layer, Option, Queue, Scope, SubscriptionRef } from 'effect';
import { vi } from 'vitest';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import type { FakeElectron } from '../helpers/fake-electron';
import { makeFakeNativeOs, type FakeNativeOs } from '../helpers/fake-native-os';
import { makeFakeOperationalDb, type FakeOperationalDb } from '../helpers/fake-operational-db';
import {
  makeFakeSystemPermissions,
  type FakeSystemPermissions,
} from '../helpers/fake-system-permissions';
import { makeTestLogger, recordingLaneStub, testConfigLayer } from '../helpers/test-layers';
import { fakeSecureStoreLayer } from '../helpers/fake-workspace-env';
import { makeAiProviderLive } from '../../src/main/domains/ai-provider/live';
import { SecureStore } from '../../src/main/infra/secure-store/service';
import { SecureStoreLive } from '../../src/main/infra/secure-store/live';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ElectronAppLive } from '../../src/main/infra/electron/live';
import { UpdaterServiceLive } from '../../src/main/domains/updater/live';
import type { RecoveryOutboxRow } from '../../src/main/infra/operational-db/service';
import { registerMainWindowHandlers } from '../../src/main/infra/ipc/main-window-handlers';
import { RecordingBridge, RecordingBridgeLive } from '../../src/main/domains/recording/bridge';
import { RemoteConfig } from '../../src/main/domains/remote-config/service';
import { EventKitBridge, EventKitBridgeLive } from '../../src/main/domains/eventkit/bridge';
import { SettingsService } from '../../src/main/domains/settings/service';
import { TelemetryService, type TelemetryServiceApi } from '../../src/main/domains/telemetry/service';
import { SettingsServiceLive } from '../../src/main/domains/settings/live';
import { DesktopI18nLive } from '../../src/main/domains/i18n/live';
import { DesktopI18n } from '../../src/main/domains/i18n/service';
import { PermissionError } from '../../src/main/domains/recording/permission/service';
import {
  RecordingBusyError,
  idleRecordingState,
  type RecordingServiceApi,
  type RecordingState,
  type StartRecordingInput,
} from '../../src/main/domains/recording/service';
import { encodeAccountIndex, initialAuthState, type AuthState } from '../../src/main/domains/auth/policy';
import { makeAuthLive } from '../../src/main/domains/auth/live';
import {
  AuthFlowError,
  AuthService,
  AuthStateError,
  type AuthApi,
} from '../../src/main/domains/auth/service';
import { OperationalDb, DbError } from '../../src/main/infra/operational-db/service';
import { CollabBrokerLive } from '../../src/main/domains/collab/live';
import { CollabBridgeLive } from '../../src/main/domains/collab/store-live';
import { CollabBridge, type NoteBodyStoreApi } from '../../src/main/domains/collab/store';
import { StreamBrokerLive } from '../../src/main/domains/streams/live';
import { WorkspaceTransportLive } from '../../src/main/domains/transport/live';
import { WorkspaceTransport } from '../../src/main/domains/transport/service';
import { WindowRegistry, type WindowRegistryService } from '../../src/main/domains/windows/service';
import { WindowRegistryLive } from '../../src/main/domains/windows/live';
import { FloatBridgeLive } from '../../src/main/domains/windows/float-bridge';
import { AppModeService, makeAppMode } from '../../src/main/domains/app-mode/service';
import { AppModeLive } from '../../src/main/domains/app-mode/live';
import {
  ModelError,
  ModelManager,
  type ModelManagerApi,
} from '../../src/main/domains/models/service';
import { SessionLifecycleProbeLive } from '../../src/main/runtime/workspace-lifecycle';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

/**
 * AuthService stub: a real SubscriptionRef (the push fiber subscribes to it)
 * with programmable signIn and recorded signOut calls. Everything else is
 * unreachable from the IPC handlers.
 */
const makeAuthStub = () => {
  const signOutCalls: Array<string | undefined> = [];
  const setActiveOrgCalls: Array<string | null> = [];
  const setActiveAccountCalls: string[] = [];
  const openWebSessionCalls: Array<{ returnPath: string; activeOrgId?: string }> = [];
  let signInEffect: Effect.Effect<void, AuthFlowError> = Effect.void;
  let setActiveOrgEffect: Effect.Effect<void, AuthStateError | DbError> = Effect.void;
  let setActiveAccountEffect: Effect.Effect<void, AuthStateError | DbError> = Effect.void;
  let pendingState: string | null = null;
  const layer = Layer.effect(
    AuthService,
    Effect.gen(function* () {
      const sessionState = yield* SubscriptionRef.make<AuthState>(initialAuthState);
      const api: AuthApi = {
        sessionState,
        signIn: () => Effect.suspend(() => signInEffect),
        signOut: sub =>
          Effect.sync(() => {
            signOutCalls.push(sub);
          }),
        setActiveAccount: sub =>
          Effect.suspend(() => {
            setActiveAccountCalls.push(sub);
            return setActiveAccountEffect;
          }),
        setActiveOrg: orgId =>
          Effect.suspend(() => {
            setActiveOrgCalls.push(orgId);
            return setActiveOrgEffect;
          }),
        getIdToken: () => Effect.die('unused in ipc tests'),
        openWebSession: (returnPath, activeOrgId) =>
          Effect.sync(() => {
            openWebSessionCalls.push({
              returnPath,
              ...(activeOrgId ? { activeOrgId } : {}),
            });
          }),
        consumePendingEntry: () => Effect.succeed('rejected' as const),
        pendingAttemptState: Effect.sync(() => pendingState),
        pendingAttemptAuthorizeUrl: Effect.sync(() =>
          pendingState === null ? null : `https://core.test/authorize?state=${pendingState}`
        ),
      };
      return api;
    })
  );
  return {
    layer,
    signOutCalls,
    setActiveOrgCalls,
    setActiveAccountCalls,
    openWebSessionCalls,
    setSignIn: (effect: Effect.Effect<void, AuthFlowError>) => {
      signInEffect = effect;
    },
    setSetActiveOrg: (effect: Effect.Effect<void, AuthStateError | DbError>) => {
      setActiveOrgEffect = effect;
    },
    setSetActiveAccount: (effect: Effect.Effect<void, AuthStateError | DbError>) => {
      setActiveAccountEffect = effect;
    },
    setPendingState: (state: string | null) => {
      pendingState = state;
    },
  };
};

/** One catalogue row, nothing installed — the models:* snapshot fixture. */
const MODELS_STATE: ModelsStateView = {
  models: [
    {
      id: 'whisper-base-en',
      name: 'Whisper Base (English)',
      filename: 'ggml-base.en.bin',
      sizeBytes: 147_964_211,
      kind: 'whisper',
      recommended: true,
      installed: false,
      installedAt: null,
      download: null,
    },
  ],
  modelsDir: '/fake/models',
};

/**
 * ModelManager stub: a real SubscriptionRef snapshot (the push fiber
 * subscribes to it) plus recorded verb calls with a programmable download
 * outcome. reconcile/installedPath are unreachable from the IPC handlers.
 */
const makeModelsStub = () => {
  const calls: Array<{ verb: 'download' | 'cancel' | 'delete'; modelId: string }> = [];
  let downloadEffect: Effect.Effect<void, ModelError> = Effect.void;
  const layer = Layer.effect(
    ModelManager,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<ModelsStateView>(MODELS_STATE);
      const api: ModelManagerApi = {
        state,
        list: SubscriptionRef.get(state),
        download: modelId =>
          Effect.suspend(() => {
            calls.push({ verb: 'download', modelId });
            return downloadEffect;
          }),
        cancel: modelId =>
          Effect.sync(() => {
            calls.push({ verb: 'cancel', modelId });
          }),
        delete: modelId =>
          Effect.sync(() => {
            calls.push({ verb: 'delete', modelId });
          }),
        reconcile: Effect.succeed({ removed: 0, adopted: 0, partsDeleted: 0 }),
        installedPath: () => Effect.succeed(Option.none()),
      };
      return api;
    })
  );
  return {
    layer,
    calls,
    setDownload: (effect: Effect.Effect<void, ModelError>) => {
      downloadEffect = effect;
    },
  };
};

const makeTelemetryStub = () => {
  const captures: Array<Parameters<TelemetryServiceApi['capture']>> = [];
  const exceptions: Array<Parameters<TelemetryServiceApi['captureException']>> = [];
  const layer = Layer.effect(TelemetryService, Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<TelemetryState>({
      revision: 0, available: true, enabled: false, signedIn: false, preference: false, canChangePreference: true,
    });
    return {
      state,
      getState: SubscriptionRef.get(state),
      getDeviceId: Effect.succeed('test-device-id'),
      capture: (...args: Parameters<TelemetryServiceApi['capture']>) => Effect.sync(() => { captures.push(args); }),
      captureException: (...args: Parameters<TelemetryServiceApi['captureException']>) => Effect.sync(() => { exceptions.push(args); }),
    };
  }));
  return { layer, captures, exceptions };
};

const build = (
  overrides: Parameters<typeof testConfigLayer>[0] = {},
  extras: {
    dbOptions?: Parameters<typeof makeFakeOperationalDb>[1];
    sysPermissions?: FakeSystemPermissions;
    appMode?: 'local' | 'cloud';
    appModeChosen?: boolean;
  } = {}
) => {
  const logger = makeTestLogger();
  const config = testConfigLayer(overrides);
  const electronApp = ElectronAppLive.pipe(Layer.provide(logger.layer));
  const auth = makeAuthStub();
  const telemetry = makeTelemetryStub();
  const appMode = Layer.effect(AppModeService, makeAppMode(extras.appMode ?? 'cloud', extras.appModeChosen ?? true));
  const db: FakeOperationalDb = makeFakeOperationalDb({}, extras.dbOptions);
  // One SettingsService instance, shared (by reference — Effect memoizes) between
  // the IPC handler environment and the window registry that depends on it.
  const settings = SettingsServiceLive.pipe(Layer.provide(db.layer), Layer.provide(logger.layer));
  const i18n = DesktopI18nLive.pipe(Layer.provide(electronApp), Layer.provide(settings));
  // Native OS and permission edges: fakes that record calls and
  // serve a settable status. UpdaterService is the real skeleton (disabled).
  const nativeOs: FakeNativeOs = makeFakeNativeOs();
  const sysPermissions: FakeSystemPermissions =
    extras.sysPermissions ?? makeFakeSystemPermissions();
  const models = makeModelsStub();
  const secureStore = SecureStoreLive.pipe(
    Layer.provide(config),
    Layer.provide(electronApp),
    Layer.provide(db.layer),
    Layer.provide(logger.layer)
  );
  const windowRegistry = WindowRegistryLive.pipe(
    Layer.provide(appMode),
    Layer.provide(config),
    Layer.provide(electronApp),
    Layer.provide(settings),
    Layer.provide(logger.layer)
  );
  const layer = Layer.mergeAll(
    testRemoteConfigLayer,
    telemetry.layer,
    config,
    logger.layer,
    windowRegistry,
    // The relaunch arm quits plainly under isE2E; Playwright observes it.
    electronApp,
    // The float coordinator: the float:* handlers reach it.
    FloatBridgeLive.pipe(
      Layer.provide(WorkspaceTransportLive),
      Layer.provide(windowRegistry),
      Layer.provide(RecordingBridgeLive),
      Layer.provide(auth.layer),
      Layer.provide(appMode),
      Layer.provide(logger.layer)
    ),
    StreamBrokerLive.pipe(Layer.provide(logger.layer), Layer.provide(WorkspaceTransportLive)),
    WorkspaceTransportLive,
    CollabBrokerLive.pipe(Layer.provide(logger.layer), Layer.provide(CollabBridgeLive)),
    CollabBridgeLive,
    RecordingBridgeLive,
    EventKitBridgeLive,
    settings,
    i18n,
    db.layer,
    sysPermissions.layer,
    nativeOs.layer,
    UpdaterServiceLive.pipe(
      Layer.provide(testTelemetryLayer),
      Layer.provide(config),
      Layer.provide(settings),
      Layer.provide(logger.layer)
    ),
    auth.layer,
    // env:get forwards the boot-resolved mode.
    appMode,
    // The models:* handlers and push fiber reach the model manager.
    models.layer,
    // The BYOK key capability handlers reach the secure store.
    secureStore,
    // The AI provider key/catalogue handlers reach the provider over
    // the SAME secure store (a catalogue fetch is a network fault in tests).
    makeAiProviderLive({ fetchFn: () => Promise.reject(new Error('offline')) }).pipe(
      Layer.provide(config),
      Layer.provide(settings),
      Layer.provide(secureStore),
      Layer.provide(logger.layer)
    ),
    SessionLifecycleProbeLive
  );
  return { logger, layer, auth, db, nativeOs, sysPermissions, models, telemetry };
};

const UUID = '33333333-3333-4333-8333-333333333333';

const ALL_HANDLER_CHANNELS = [
  CHANNELS.envGet,
  CHANNELS.transportRequest,
  CHANNELS.transportOpenStream,
  CHANNELS.collabOpen,
  CHANNELS.authGetSession,
  CHANNELS.authSignIn,
  CHANNELS.authOpenWebSession,
  CHANNELS.authSignOut,
  CHANNELS.authSwitchOrg,
  CHANNELS.authSwitchAccount,
  CHANNELS.authGetCollabToken,
  CHANNELS.recordingStart,
  CHANNELS.recordingStop,
  CHANNELS.recordingClaimCompletion,
  CHANNELS.recordingPause,
  CHANNELS.recordingResume,
  CHANNELS.loggingGetConfig,
  CHANNELS.loggingWrite,
  CHANNELS.telemetryGetState,
  CHANNELS.telemetryCapture,
  CHANNELS.telemetryCaptureException,
  CHANNELS.settingsGet,
  CHANNELS.settingsSet,
  CHANNELS.capabilityCheckUpdates,
  CHANNELS.updaterGetAccess,
  CHANNELS.updaterOpenDownload,
  CHANNELS.updaterQuit,
  CHANNELS.updaterGetState,
  CHANNELS.updaterQuitInstall,
  CHANNELS.updaterDismissPrompt,
  CHANNELS.capabilityExportLogs,
  CHANNELS.capabilityRestartApp,
  CHANNELS.capabilityResetApp,
  CHANNELS.capabilityGetAppModeState,
  CHANNELS.capabilityChooseAppMode,
  CHANNELS.capabilityGetPermissions,
  CHANNELS.capabilityRequestPermission,
  CHANNELS.capabilityOpenSystemSettings,
  CHANNELS.capabilityGetAppleCalendarStatus,
  CHANNELS.capabilityEnableAppleCalendar,
  CHANNELS.capabilityRefreshAppleCalendar,
  CHANNELS.capabilitySetTranscriptionByokKey,
  CHANNELS.capabilityClearTranscriptionByokKey,
  CHANNELS.capabilityHasTranscriptionByokKey,
  CHANNELS.capabilitySetAiProviderKey,
  CHANNELS.capabilityClearAiProviderKey,
  CHANNELS.capabilityHasAiProviderKey,
  CHANNELS.capabilityListAiModels,
  CHANNELS.themeSetSource,
  CHANNELS.floatOpen,
  CHANNELS.floatCollapse,
  CHANNELS.floatDockBack,
  CHANNELS.modelsGetState,
  CHANNELS.modelsDownload,
  CHANNELS.modelsCancelDownload,
  CHANNELS.modelsDelete,
];

/**
 * A fake session RecordingService for the recording IPC tests: a real
 * SubscriptionRef state the push fiber subscribes to, a programmable `start`
 * outcome, and recorded start/stop calls. Registered into the REAL bridge so the
 * boot↔session round-trip (handler → bridge → service) is exercised end to end.
 */
const makeFakeRecordingService = () =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<RecordingState>(idleRecordingState);
    const level = yield* SubscriptionRef.make(0);
    const startCalls: StartRecordingInput[] = [];
    const stopCalls: string[] = [];
    const pauseCalls: string[] = [];
    const resumeCalls: string[] = [];
    const claimCalls: string[] = [];
    let claimResult = false;
    let startResult: Effect.Effect<string, RecordingBusyError | PermissionError> =
      Effect.succeed('rec_fake');
    const api: RecordingServiceApi = {
      resolveCompletion: () => Effect.void,
      claimCompletion: id => Effect.sync(() => {
        claimCalls.push(id);
        return claimResult;
      }),
      keepRecording: () => Effect.succeed(true),
      pauseFromPrompt: () => Effect.succeed(true),
      start: input =>
        Effect.suspend(() => {
          startCalls.push(input);
          return startResult;
        }),
      stop: id =>
        Effect.sync(() => {
          stopCalls.push(id);
        }),
      pause: id =>
        Effect.sync(() => {
          pauseCalls.push(id);
          return true;
        }),
      resume: id =>
        Effect.sync(() => {
          resumeCalls.push(id);
          return true;
        }),
      state,
      level,
    };
    return {
      api,
      state,
      startCalls,
      stopCalls,
      pauseCalls,
      resumeCalls,
      claimCalls,
      setClaim: (accepted: boolean) => { claimResult = accepted; },
      setStart: (effect: Effect.Effect<string, RecordingBusyError | PermissionError>) => {
        startResult = effect;
      },
    };
  });

/** Cooperative wait for the forked push fiber (no clock involved). */
const drainUntil = (predicate: () => boolean) =>
  Effect.iterate(0, {
    while: n => n < 200 && !predicate(),
    body: n => Effect.yieldNow().pipe(Effect.as(n + 1)),
  });

const SIGNED_IN_STATE: AuthState = {
  gate: 'signed-in',
  accounts: {
    user_1: {
      sub: 'user_1',
      email: 'u1@example.com',
      name: 'User One',
      activeOrgId: 'org_1',
      orgs: [{ id: 'ou_1', orgId: 'org_1', userId: 'user_1' }],
    },
  },
  activeSub: 'user_1',
};

/**
 * An AuthState an implementation bug might produce: token-shaped fields
 * smuggled in past the type system. toSessionView must project them away and
 * the strict push schema must never let them cross.
 */
const POISONED_STATE = {
  gate: 'signed-in',
  accounts: {
    user_1: {
      sub: 'user_1',
      email: 'poisoned@example.com',
      name: 'User One',
      activeOrgId: 'org_1',
      orgs: [{ id: 'ou_1', orgId: 'org_1', userId: 'user_1' }],
      refreshToken: 'SENTINEL-REFRESH-TOKEN',
      idToken: 'SENTINEL-ID-TOKEN',
    },
  },
  activeSub: 'user_1',
  accessToken: 'SENTINEL-ACCESS-TOKEN',
} as unknown as AuthState;

describe('registerMainWindowHandlers', () => {
  it.effect('accepts only registered renderer log ingress and binds origin in main', () =>
    Effect.gen(function* () {
      const { layer, logger } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const widget = yield* Context.get(ctx, WindowRegistry).openWidgetWindow.pipe(Scope.extend(scope));
      const sender = widget.webContents;
      const wire = makeWire('warn', 'widget-ui', 'Widget diagnostic', {
        context: { apiKey: 'private-key' }, error: Object.assign(new Error('failure'), { code: 'EPIPE' }),
      });
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.loggingWrite, { sender }, {
        ...wire, runtime: 'main', pid: 999, surface: 'spoof', appRunId: 'spoof',
      }));
      assert.strictEqual(logger.entries.at(-1)?.runtime, 'renderer');
      assert.strictEqual(logger.entries.at(-1)?.pid, sender.getOSProcessId());
      assert.isFalse(JSON.stringify(logger.entries.at(-1)).includes('private-key'));
      const count = logger.entries.length;
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.loggingWrite, { sender }, { ...wire, level: 'fatal' }));
      assert.strictEqual(logger.entries.length, count);
      const rejected = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(
        CHANNELS.loggingWrite, { sender: { id: 9999 } }, wire,
      )));
      assert.isTrue(Exit.isFailure(rejected));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('telemetry validates senders and bounded DTOs and assigns renderer origin', () =>
    Effect.gen(function* () {
      const { layer, telemetry } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      yield* Context.get(ctx, WindowRegistry).openMainWindow.pipe(Scope.extend(scope));
      const sender = fake.__windowInstances().at(-1)?.webContents;
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.telemetryCapture, { sender }, {
        revision: 0, event: 'recording_completed', properties: { recording_id: 'rec_1' },
      }));
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.telemetryCaptureException, { sender }, {
        revision: 0, error: { name: 'Error', message: 'renderer failed', stack: 'safe-stack' },
      }));
      assert.deepStrictEqual(telemetry.captures, [['recording_completed', { recording_id: 'rec_1' }, 'renderer', 0]]);
      assert.deepStrictEqual(telemetry.exceptions, [[{ name: 'Error', message: 'renderer failed', stack: 'safe-stack' }, { window_type: 'main' }, 'renderer', 0]]);
      const foreign = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(
        CHANNELS.telemetryCapture, { sender: { id: 9999 } }, { event: 'foreign', revision: 0 },
      )));
      const oversized = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(
        CHANNELS.telemetryCaptureException, { sender }, { revision: 0, error: { name: 'Error', message: 'x'.repeat(2049) } },
      )));
      const originOverride = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(
        CHANNELS.telemetryCapture, { sender }, { revision: 0, event: 'fake', source: 'main' },
      )));
      assert.isTrue(Exit.isFailure(foreign));
      assert.isTrue(Exit.isFailure(oversized));
      assert.isTrue(Exit.isFailure(originOverride));
      assert.strictEqual(telemetry.captures.length, 1);
      assert.strictEqual(telemetry.exceptions.length, 1);
      const widget = yield* Context.get(ctx, WindowRegistry).openWidgetWindow.pipe(Scope.extend(scope));
      const notify = yield* Context.get(ctx, WindowRegistry).openNotifyWindow.pipe(Scope.extend(scope));
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.telemetryCaptureException, { sender: widget.webContents }, {
        revision: 0, error: { name: 'Error', message: 'widget failed' }, properties: { window_type: 'main' },
      }));
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.telemetryCaptureException, { sender: notify.webContents }, {
        revision: 0, error: { name: 'Error', message: 'notify failed' },
      }));
      assert.deepStrictEqual(telemetry.exceptions.slice(1).map(call => call[1]), [
        { window_type: 'widget' }, { window_type: 'notify' },
      ]);
      const widgetEvent = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(
        CHANNELS.telemetryCapture, { sender: widget.webContents }, { revision: 0, event: 'widget_spoof' },
      )));
      assert.isTrue(Exit.isFailure(widgetEvent));
      assert.strictEqual(telemetry.captures.length, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('telemetry preference mutation is refused when main disallows changing it', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      yield* Context.get(ctx, WindowRegistry).openMainWindow.pipe(Scope.extend(scope));
      const sender = fake.__windowInstances().at(-1)?.webContents;
      const telemetry = Context.get(ctx, TelemetryService);
      yield* SubscriptionRef.set(telemetry.state, {
        revision: 1, available: true, enabled: true, signedIn: true, preference: false, canChangePreference: false,
      });
      const result = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(
        CHANNELS.settingsSet, { sender }, { telemetryOptOut: false },
      )));
      assert.isTrue(Exit.isFailure(result));
      assert.isTrue((yield* Context.get(ctx, SettingsService).get).telemetryOptOut);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('registers handlers scoped — removeHandler runs on scope close', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));

      assert.deepStrictEqual(
        [...fake.ipcMain.handlers.keys()].sort(),
        [...ALL_HANDLER_CHANNELS].sort()
      );
      // Production runs expose NO e2e channels (the exact-set assert above
      // already implies it; keep the names explicit for this gate).
      assert.isFalse(fake.ipcMain.handlers.has(CHANNELS.e2eStreamStats));
      assert.isFalse(fake.ipcMain.handlers.has(CHANNELS.e2eAuthPendingState));
      assert.isFalse(fake.ipcMain.handlers.has(CHANNELS.e2eAuthAuthorizeUrl));
      assert.isFalse(fake.ipcMain.handlers.has(CHANNELS.e2eSessionProbe));
      assert.isFalse(fake.ipcMain.handlers.has(CHANNELS.e2eRecording));
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(fake.ipcMain.handlers.size, 0);
    })
  );

  it.effect(
    'recording:pause/resume validate the id and return whether the command was accepted',
    () =>
      Effect.gen(function* () {
        const { layer } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        const bridge = Context.get(ctx, RecordingBridge);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        assert.isFalse(
          yield* Effect.promise(() =>
            fake.ipcMain.invoke(
              CHANNELS.recordingPause,
              { sender: wc },
              { recordingId: 'rec_none' }
            )
          )
        );

        const rec = yield* makeFakeRecordingService();
        yield* bridge.register(rec.api).pipe(Scope.extend(scope));
        assert.isTrue(
          yield* Effect.promise(() =>
            fake.ipcMain.invoke(CHANNELS.recordingPause, { sender: wc }, { recordingId: 'rec_1' })
          )
        );
        assert.isTrue(
          yield* Effect.promise(() =>
            fake.ipcMain.invoke(CHANNELS.recordingResume, { sender: wc }, { recordingId: 'rec_1' })
          )
        );
        assert.deepStrictEqual(rec.pauseCalls, ['rec_1']);
        assert.deepStrictEqual(rec.resumeCalls, ['rec_1']);

        const bad = yield* Effect.exit(
          Effect.tryPromise(() => fake.ipcMain.invoke(CHANNELS.recordingPause, { sender: wc }, {}))
        );
        assert.isTrue(Exit.isFailure(bad));
        assert.deepStrictEqual(rec.pauseCalls, ['rec_1']);

        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('the e2e auth/stream/session probes are registered only under PRISMICAL_E2E', () =>
    Effect.gen(function* () {
      const { layer, auth } = build({ isE2E: true });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      assert.isTrue(fake.ipcMain.handlers.has(CHANNELS.e2eStreamStats));
      assert.isTrue(fake.ipcMain.handlers.has(CHANNELS.e2eAuthPendingState));
      assert.isTrue(fake.ipcMain.handlers.has(CHANNELS.e2eAuthAuthorizeUrl));
      assert.isTrue(fake.ipcMain.handlers.has(CHANNELS.e2eSessionProbe));
      assert.isTrue(fake.ipcMain.handlers.has(CHANNELS.e2eRecording));

      // Round-trip: the channel serves the auth seam's value to the main
      // window (and refuses foreign senders like every other handler).
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;
      assert.isNull(
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.e2eAuthPendingState, { sender: wc })
        )
      );
      auth.setPendingState('state-e2e-1');
      assert.strictEqual(
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.e2eAuthPendingState, { sender: wc })
        ),
        'state-e2e-1'
      );
      assert.strictEqual(
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.e2eAuthAuthorizeUrl, { sender: wc })
        ),
        'https://core.test/authorize?state=state-e2e-1'
      );
      // The session probe serves the lifecycle counters (fresh layer: zeros,
      // nothing pinned) to the main window only.
      assert.deepStrictEqual(
        yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.e2eSessionProbe, { sender: wc })),
        { acquires: 0, releases: 0, acquireFailures: 0, pinned: null }
      );
      const foreign = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.e2eAuthPendingState, { sender: { id: 9999 } })
        )
      );
      assert.isTrue(Exit.isFailure(foreign));
      const foreignProbe = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.e2eSessionProbe, { sender: { id: 9999 } })
        )
      );
      assert.isTrue(Exit.isFailure(foreignProbe));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('env:get forwards the boot-resolved appMode — not a hardcoded cloud', () =>
    Effect.gen(function* () {
      // The descriptor reads AppModeService.mode. A discriminating mode
      // must come through, so a re-hardcoded 'cloud' cannot pass this suite.
      const { layer } = build({ gleap: { key: 'test-key', cspNonce: 'test-nonce' } }, { appMode: 'local' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;
      assert.isDefined(wc);
      const env = yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.envGet, { sender: wc }));
      assert.strictEqual((env as { appMode: string }).appMode, 'local');
      assert.isNull((env as { gleap: unknown }).gleap);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('env:get serves the renderer-safe descriptor to the main window only', () =>
    Effect.gen(function* () {
      const { layer, logger } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;
      assert.isDefined(wc);

      const env = yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.envGet, { sender: wc }));
      assert.deepStrictEqual(env, {
        gleap: null,
        noteWsUrl: 'wss://note.test/collaboration',
        webAppOrigin: 'https://app.test',
        analyticsKey: null,
        analyticsHost: null,
        appMode: 'cloud',
        platform: process.platform,
        appVersion: '0.0.0-test',
        applicationLocale: 'en',
        systemLocale: 'en',
      });
      // No server URL crosses the membrane, and none of the
      // auth config (client id, redirect, oauth endpoints) leaks either — the
      // deepStrictEqual above is the exact renderer-safe surface.
      assert.notInclude(JSON.stringify(env), 'core');
      assert.notInclude(JSON.stringify(env), 'oauth');
      assert.notInclude(JSON.stringify(env), 'client');

      // Unknown sender → typed rejection + warn log.
      const rejected = yield* Effect.exit(
        Effect.tryPromise(() => fake.ipcMain.invoke(CHANNELS.envGet, { sender: { id: 9999 } }))
      );
      assert.isTrue(Exit.isFailure(rejected));
      assert.isDefined(
        logger.find(e => e.level === 'warn' && e.message === 'ipc rejected: unknown sender')
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('transport:request validates today: payload schema + /apps/v1/me allowlist', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      const invoke = (payload: unknown) =>
        Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.transportRequest, { sender: wc }, payload)
        );

      assert.deepStrictEqual(yield* invoke({ nonsense: true }), {
        error: { code: 'INVALID_REQUEST' },
      });
      assert.deepStrictEqual(yield* invoke({ method: 'GET', path: '/v1/anything' }), {
        error: { code: 'PATH_NOT_ALLOWED' },
      });
      assert.deepStrictEqual(yield* invoke({ method: 'GET', path: '/apps/v1/meow' }), {
        error: { code: 'PATH_NOT_ALLOWED' },
      });
      // Dot-segment traversal escapes the prefix once normalized — rejected here.
      assert.deepStrictEqual(yield* invoke({ method: 'GET', path: '/apps/v1/me/../admin' }), {
        error: { code: 'PATH_NOT_ALLOWED' },
      });
      // An allowlisted request dispatches into the WorkspaceBackend. With
      // no session registered (this harness runs no lifecycle) the accessor
      // reads None and settles the reserved INTERNAL envelope — never a fetch,
      // never a throw.
      assert.deepStrictEqual(yield* invoke({ method: 'GET', path: '/apps/v1/me/notes' }), {
        error: { code: 'INTERNAL' },
      });
      // Unknown sender gets an error envelope, not data.
      const foreign = yield* Effect.promise(() =>
        fake.ipcMain.invoke(
          CHANNELS.transportRequest,
          { sender: { id: 4242 } },
          { method: 'GET', path: '/apps/v1/me' }
        )
      );
      assert.deepStrictEqual(foreign, { error: { code: 'UNKNOWN_SENDER' } });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('transport:openStream validates, opens through the broker, posts the port', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      // Register a session client whose Ask stream never ends, so the opened
      // stream stays ACTIVE and the duplicate-id check below fires (the real
      // no-session producer would complete instantly, freeing the id first).
      yield* Context.get(ctx, WorkspaceTransport)
        .register({
          request: () => Effect.succeed<TransportResponse>({ error: { code: 'INTERNAL' } }),
          openAskStream: () =>
            Effect.succeed(new Response(new ReadableStream<Uint8Array>({ start() {} }))),
          collabToken: Effect.succeed('STUB-ID-TOKEN'),
          ...recordingLaneStub,
        })
        .pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const window = fake.__windowInstances().at(-1);
      const wc = window?.webContents;

      const invoke = (payload: unknown) =>
        Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.transportOpenStream, { sender: wc }, payload)
        );

      assert.deepStrictEqual(
        yield* invoke({ streamId: 'not-a-uuid', method: 'POST', path: '/apps/v1/me/ask' }),
        {
          error: { code: 'INVALID_REQUEST' },
        }
      );
      assert.deepStrictEqual(
        yield* invoke({ streamId: UUID, method: 'POST', path: '/elsewhere' }),
        {
          error: { code: 'PATH_NOT_ALLOWED' },
        }
      );

      const opened = yield* invoke({ streamId: UUID, method: 'POST', path: '/apps/v1/me/ask' });
      assert.deepStrictEqual(opened, { ok: true, streamId: UUID });
      const posted = wc?.posted.find(p => p.channel === streamPortChannel(UUID));
      assert.isDefined(posted, 'MessagePort posted to the requesting sender');
      assert.strictEqual(posted?.transfer.length, 1);

      const duplicate = yield* invoke({ streamId: UUID, method: 'POST', path: '/apps/v1/me/ask' });
      assert.deepStrictEqual(duplicate, { error: { code: 'DUPLICATE_STREAM' } });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('collab:open validates (schema + note id), maps NO_WORKSPACE, posts the port', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      const invoke = (payload: unknown) =>
        Effect.promise(() => fake.ipcMain.invoke(CHANNELS.collabOpen, { sender: wc }, payload));

      // Malformed payload / non-note id never reach the broker.
      assert.deepStrictEqual(yield* invoke({ openId: 'not-a-uuid', noteId: 'nt_1' }), {
        error: { code: 'INVALID_REQUEST' },
      });
      assert.deepStrictEqual(yield* invoke({ openId: UUID, noteId: 'folder_1' }), {
        error: { code: 'INVALID_REQUEST' },
      });
      // No workspace mounted (bridge holds None) → typed NO_WORKSPACE.
      assert.deepStrictEqual(yield* invoke({ openId: UUID, noteId: 'nt_1' }), {
        error: { code: 'NO_WORKSPACE' },
      });

      // With a store registered the open succeeds and the port is posted on
      // the per-open channel to the requesting sender.
      const store: NoteBodyStoreApi = {
        listUpdates: () => Effect.succeed([]),
        appendUpdate: () => Effect.succeed(1),
        compact: () => Effect.void,
        applyFlush: () => Effect.void,
      };
      yield* Context.get(ctx, CollabBridge).register(store).pipe(Scope.extend(scope));
      assert.deepStrictEqual(yield* invoke({ openId: UUID, noteId: 'nt_1' }), { ok: true });
      const posted = wc?.posted.find(p => p.channel === collabPortChannel(UUID));
      assert.isDefined(posted, 'MessagePort posted to the requesting sender');
      assert.strictEqual(posted?.transfer.length, 1);

      // The openId is now live — a duplicate open fails typed.
      assert.deepStrictEqual(yield* invoke({ openId: UUID, noteId: 'nt_1' }), {
        error: { code: 'DUPLICATE' },
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('auth:getSession serves the sanitized view — never token-shaped fields', () =>
    Effect.gen(function* () {
      const { layer, logger } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      const auth = Context.get(ctx, AuthService);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      const invoke = () =>
        Effect.promise(() => fake.ipcMain.invoke(CHANNELS.authGetSession, { sender: wc }));

      assert.deepStrictEqual(yield* invoke(), { state: 'signed-out', accounts: [] });

      // Even a state a bug poisoned with token-shaped fields serves clean:
      // toSessionView projects, and the strict schema accepts the projection.
      yield* SubscriptionRef.set(auth.sessionState, POISONED_STATE);
      const view = yield* invoke();
      assert.deepStrictEqual(view, {
        state: 'signed-in',
        accounts: [
          { sub: 'user_1', email: 'poisoned@example.com', name: 'User One', activeOrgId: 'org_1' },
        ],
        activeSub: 'user_1',
      });
      assert.notInclude(JSON.stringify(view), 'SENTINEL');
      assert.isTrue(parseSessionView(view).success);

      // Unknown sender → typed rejection, no data.
      const rejected = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.authGetSession, { sender: { id: 9999 } })
        )
      );
      assert.isTrue(Exit.isFailure(rejected));
      assert.isDefined(
        logger.find(e => e.level === 'warn' && e.message === 'ipc rejected: unknown sender')
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('auth:signIn maps every flow outcome onto a typed SignInResult', () =>
    Effect.gen(function* () {
      const { layer, auth } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      const invoke = () =>
        Effect.promise(() => fake.ipcMain.invoke(CHANNELS.authSignIn, { sender: wc }));

      assert.deepStrictEqual(yield* invoke(), { ok: true });

      const reasons = [
        ['not-configured', 'NOT_CONFIGURED'],
        ['flow-already-pending', 'FLOW_ALREADY_PENDING'],
        ['browser-launch-failed', 'BROWSER_LAUNCH_FAILED'],
      ] as const;
      for (const [reason, code] of reasons) {
        auth.setSignIn(Effect.fail(new AuthFlowError({ reason })));
        assert.deepStrictEqual(yield* invoke(), { ok: false, code });
      }

      // A defect resolves as INTERNAL — the renderer never sees a rejection.
      auth.setSignIn(Effect.die('boom'));
      assert.deepStrictEqual(yield* invoke(), { ok: false, code: 'INTERNAL' });

      // Unknown sender gets the typed envelope too (schema code UNKNOWN_SENDER).
      const foreign = yield* Effect.promise(() =>
        fake.ipcMain.invoke(CHANNELS.authSignIn, { sender: { id: 4242 } })
      );
      assert.deepStrictEqual(foreign, { ok: false, code: 'UNKNOWN_SENDER' });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('auth:openWebSession validates and forwards the return path', () =>
    Effect.gen(function* () {
      const { layer, auth } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      yield* Effect.promise(() =>
        fake.ipcMain.invoke(
          CHANNELS.authOpenWebSession,
          { sender: wc },
          { returnPath: '/settings/account', activeOrgId: 'org_1' }
        )
      );
      assert.deepStrictEqual(auth.openWebSessionCalls, [
        { returnPath: '/settings/account', activeOrgId: 'org_1' },
      ]);

      const rejected = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(
            CHANNELS.authOpenWebSession,
            { sender: wc },
            { returnPath: '//evil.example' }
          )
        )
      );
      assert.isTrue(Exit.isFailure(rejected));
      assert.deepStrictEqual(auth.openWebSessionCalls, [
        { returnPath: '/settings/account', activeOrgId: 'org_1' },
      ]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('auth:signOut validates the strict payload and passes sub through', () =>
    Effect.gen(function* () {
      const { layer, logger, auth } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      // {} and a bare invoke both mean "the active account".
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.authSignOut, { sender: wc }, {}));
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.authSignOut, { sender: wc }));
      yield* Effect.promise(() =>
        fake.ipcMain.invoke(CHANNELS.authSignOut, { sender: wc }, { sub: 'user_2' })
      );
      assert.deepStrictEqual(auth.signOutCalls, [undefined, undefined, 'user_2']);

      // Schema rejections (wrong type / unknown key) reject WITHOUT a signOut.
      const badType = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.authSignOut, { sender: wc }, { sub: 123 })
        )
      );
      assert.isTrue(Exit.isFailure(badType));
      const extraKey = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.authSignOut, { sender: wc }, { sub: 'user_2', extra: true })
        )
      );
      assert.isTrue(Exit.isFailure(extraKey));
      assert.isDefined(
        logger.find(
          e => e.level === 'warn' && e.message === 'auth:signOut rejected: invalid payload'
        )
      );

      // Unknown sender → rejection, no signOut.
      const foreign = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.authSignOut, { sender: { id: 4242 } }, {})
        )
      );
      assert.isTrue(Exit.isFailure(foreign));
      assert.deepStrictEqual(auth.signOutCalls, [undefined, undefined, 'user_2']);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'auth:switchOrg validates payload + sender, passes orgId to setActiveOrg, folds a rejection to void',
    () =>
      Effect.gen(function* () {
        const { layer, logger, auth } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        // Happy path: the orgId reaches setActiveOrg (which validates it against
        // the verified org_users claim and mutates the session — the switch proof
        // lives in workspace-layer.test.ts) and the invoke resolves void.
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.authSwitchOrg, { sender: wc }, { orgId: 'org_2' })
        );
        assert.deepStrictEqual(auth.setActiveOrgCalls, ['org_2']);

        // An org that isn't a membership fails typed inside setActiveOrg — the
        // handler logs and folds to void (fire-and-forget: the renderer reacts to
        // the session push, never a return value), so the invoke still RESOLVES.
        auth.setSetActiveOrg(Effect.fail(new AuthStateError({ reason: 'invalid-org' })));
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.authSwitchOrg, { sender: wc }, { orgId: 'org_ghost' })
        );
        assert.deepStrictEqual(auth.setActiveOrgCalls, ['org_2', 'org_ghost']);
        assert.isDefined(
          logger.find(
            e => e.level === 'warn' && e.message === 'auth:switchOrg ignored — org not a membership'
          )
        );

        // Schema rejections (missing/empty/null orgId, extra key) reject WITHOUT a
        // switch — no null crosses the wire (the renderer only picks a real org).
        for (const bad of [{}, { orgId: '' }, { orgId: null }, { orgId: 'org_2', extra: true }]) {
          const rejected = yield* Effect.exit(
            Effect.tryPromise(() =>
              fake.ipcMain.invoke(CHANNELS.authSwitchOrg, { sender: wc }, bad)
            )
          );
          assert.isTrue(Exit.isFailure(rejected));
        }
        assert.deepStrictEqual(auth.setActiveOrgCalls, ['org_2', 'org_ghost']);
        assert.isDefined(
          logger.find(
            e => e.level === 'warn' && e.message === 'auth:switchOrg rejected: invalid payload'
          )
        );

        // Unknown sender → typed rejection, no switch.
        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(
              CHANNELS.authSwitchOrg,
              { sender: { id: 4242 } },
              { orgId: 'org_2' }
            )
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        assert.deepStrictEqual(auth.setActiveOrgCalls, ['org_2', 'org_ghost']);
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'auth:switchAccount validates payload + sender, passes sub to setActiveAccount, folds a rejection to void',
    () =>
      Effect.gen(function* () {
        const { layer, logger, auth } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        // Happy path: the sub reaches setActiveAccount and the invoke resolves.
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.authSwitchAccount, { sender: wc }, { sub: 'user_2' })
        );
        assert.deepStrictEqual(auth.setActiveAccountCalls, ['user_2']);

        // Unknown sub fails typed inside setActiveAccount — logged, folded to void.
        auth.setSetActiveAccount(Effect.fail(new AuthStateError({ reason: 'unknown-account' })));
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.authSwitchAccount, { sender: wc }, { sub: 'ghost' })
        );
        assert.deepStrictEqual(auth.setActiveAccountCalls, ['user_2', 'ghost']);
        assert.isDefined(
          logger.find(
            e => e.level === 'warn' && e.message === 'auth:switchAccount ignored — unknown account'
          )
        );

        // Schema rejections reject WITHOUT a switch.
        for (const bad of [{}, { sub: '' }, { sub: 'user_2', extra: true }]) {
          const rejected = yield* Effect.exit(
            Effect.tryPromise(() =>
              fake.ipcMain.invoke(CHANNELS.authSwitchAccount, { sender: wc }, bad)
            )
          );
          assert.isTrue(Exit.isFailure(rejected));
        }
        assert.deepStrictEqual(auth.setActiveAccountCalls, ['user_2', 'ghost']);

        // Unknown sender → typed rejection, no switch.
        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(
              CHANNELS.authSwitchAccount,
              { sender: { id: 4242 } },
              { sub: 'user_2' }
            )
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        assert.deepStrictEqual(auth.setActiveAccountCalls, ['user_2', 'ghost']);
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'auth:getCollabToken serves the guarded id_token — null with no session, sender-validated',
    () =>
      Effect.gen(function* () {
        const { layer } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        const coreTransport = Context.get(ctx, WorkspaceTransport);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        const invoke = () =>
          Effect.promise(() => fake.ipcMain.invoke(CHANNELS.authGetCollabToken, { sender: wc }));

        // No live session ⇒ null — the collab provider connects tokenless (never
        // a throw): this harness runs no lifecycle, so the accessor reads None.
        assert.isNull(yield* invoke());

        // A registered session client publishes its guarded id_token — the ONE
        // sanctioned full-token crossing, served verbatim to the window.
        yield* coreTransport
          .register({
            request: () => Effect.succeed<TransportResponse>({ error: { code: 'INTERNAL' } }),
            openAskStream: () => Effect.succeed(new Response(null)),
            collabToken: Effect.succeed('FRESH-ID-TOKEN'),
            ...recordingLaneStub,
          })
          .pipe(Scope.extend(scope));
        assert.strictEqual(yield* invoke(), 'FRESH-ID-TOKEN');

        // Unknown sender → typed rejection, never a token.
        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(CHANNELS.authGetCollabToken, { sender: { id: 9999 } })
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('auth:sessionChanged pushes sanitized views and dies with the scope', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      const auth = Context.get(ctx, AuthService);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;
      assert.isDefined(wc);
      const pushes = () =>
        (wc?.sent ?? []).filter(entry => entry.channel === CHANNELS.authSessionChanged);

      yield* SubscriptionRef.set(auth.sessionState, SIGNED_IN_STATE);
      yield* drainUntil(() =>
        pushes().some(entry => JSON.stringify(entry.payload).includes('u1@example.com'))
      );
      const signedIn = pushes().find(entry =>
        JSON.stringify(entry.payload).includes('u1@example.com')
      );
      assert.deepStrictEqual(signedIn?.payload, {
        state: 'signed-in',
        accounts: [
          { sub: 'user_1', email: 'u1@example.com', name: 'User One', activeOrgId: 'org_1' },
        ],
        activeSub: 'user_1',
      });

      // Sentinel: a token-poisoned state change pushes a CLEAN view.
      yield* SubscriptionRef.set(auth.sessionState, POISONED_STATE);
      yield* drainUntil(() =>
        pushes().some(entry => JSON.stringify(entry.payload).includes('poisoned@example.com'))
      );
      for (const entry of pushes()) {
        assert.notInclude(JSON.stringify(entry.payload), 'SENTINEL');
        assert.isTrue(parseSessionView(entry.payload).success);
      }

      // Scope close releases the push fiber with the handlers: later state
      // changes reach no window.
      yield* Scope.close(scope, Exit.void);
      const settled = pushes().length;
      yield* SubscriptionRef.set(auth.sessionState, initialAuthState);
      yield* drainUntil(() => false);
      assert.strictEqual(pushes().length, settled);
    })
  );

  // webContents.send can throw when the window is destroyed between
  // the liveness check and the send (two separate Effect.sync steps in
  // WindowRegistryLive) — one throwing push must not kill the fan-out fiber
  // for the rest of the process.
  it.effect(
    'the sessionChanged push fiber survives a throwing send and keeps pushing',
    () =>
      Effect.gen(function* () {
        const logger = makeTestLogger();
        const config = testConfigLayer();
        const delivered: Array<{ channel: string; payload: unknown }> = [];
        let throwOnce = true;
        // Windows stub: the FIRST send throws exactly like a destroyed
        // webContents; every later send records.
        const windowsStub = Layer.effect(
          WindowRegistry,
          Effect.gen(function* () {
            const events = yield* Queue.sliding<never>(1);
            const service: WindowRegistryService = {
              openMainWindow: Effect.die('unused in stub'),
              setThemeSource: () => Effect.void,
              identityForWebContents: () => Effect.succeed(Option.none()),
              mainWindow: Effect.succeed(Option.none()),
              focusMainWindow: Effect.void,
              // The auth push fans out via sendToAppWindows, where this test
              // exercises the throw/record semantics. sendToMainWindow only
              // carries targeted navigation.
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
              repositionDockWindow: Effect.void,
              repositionFloatNoteWindow: Effect.void,
              setDockContentProtection: () => Effect.void,
              sendToAppWindows: (channel, payload) =>
                Effect.sync(() => {
                  // Scope the throw/record to auth:sessionChanged — the settings push
                  // fiber also fans out on this stub at registration, and it
                  // must not consume the one-shot throw this test aims at the auth push.
                  if (channel !== CHANNELS.authSessionChanged) return;
                  if (throwOnce) {
                    throwOnce = false;
                    throw new Error('Object has been destroyed');
                  }
                  delivered.push({ channel, payload });
                }),
              mainWindowFocused: yield* SubscriptionRef.make(false),
            };
            return service;
          })
        );
        const auth = makeAuthStub();
        const db = makeFakeOperationalDb();
        const settings = SettingsServiceLive.pipe(
          Layer.provide(db.layer),
          Layer.provide(logger.layer)
        );
        const secureStore = fakeSecureStoreLayer();
        const layer = Layer.mergeAll(
    testRemoteConfigLayer,
          makeTelemetryStub().layer,
          config,
          logger.layer,
          windowsStub,
          ElectronAppLive.pipe(Layer.provide(logger.layer)),
          FloatBridgeLive.pipe(
            Layer.provide(WorkspaceTransportLive),
            Layer.provide(windowsStub),
            Layer.provide(RecordingBridgeLive),
            Layer.provide(auth.layer),
            Layer.provide(Layer.effect(AppModeService, makeAppMode('cloud', true))),
            Layer.provide(logger.layer)
          ),
          StreamBrokerLive.pipe(Layer.provide(logger.layer), Layer.provide(WorkspaceTransportLive)),
          WorkspaceTransportLive,
          CollabBrokerLive.pipe(Layer.provide(logger.layer), Layer.provide(CollabBridgeLive)),
          CollabBridgeLive,
          RecordingBridgeLive,
          EventKitBridgeLive,
          settings,
          Layer.succeed(DesktopI18n, {
            locale: 'en',
            systemLocale: 'en',
            t: createApplicationI18nSync('en').t,
          }),
          db.layer,
          makeFakeSystemPermissions().layer,
          makeFakeNativeOs().layer,
          UpdaterServiceLive.pipe(
            Layer.provide(testTelemetryLayer),
            Layer.provide(config),
            Layer.provide(settings),
            Layer.provide(logger.layer)
          ),
          auth.layer,
          Layer.effect(AppModeService, makeAppMode('cloud', true)),
          makeModelsStub().layer,
          secureStore,
          makeAiProviderLive({ fetchFn: () => Promise.reject(new Error('offline')) }).pipe(
            Layer.provide(config),
            Layer.provide(settings),
            Layer.provide(secureStore),
            Layer.provide(logger.layer)
          ),
          SessionLifecycleProbeLive
        );
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const authService = Context.get(ctx, AuthService);

        // First state change: the send THROWS — logged, fiber survives.
        yield* SubscriptionRef.set(authService.sessionState, SIGNED_IN_STATE);
        yield* drainUntil(
          () =>
            logger.find(e => e.message === 'auth:sessionChanged push failed — fiber continues') !==
            undefined
        );
        assert.isDefined(
          logger.find(e => e.message === 'auth:sessionChanged push failed — fiber continues')
        );
        assert.strictEqual(delivered.length, 0);

        // Second state change: the surviving fiber delivers it.
        yield* SubscriptionRef.set(authService.sessionState, initialAuthState);
        yield* drainUntil(() => delivered.length >= 1);
        assert.strictEqual(delivered.length, 1);
        assert.strictEqual(delivered[0].channel, CHANNELS.authSessionChanged);
        assert.deepStrictEqual(delivered[0].payload, { state: 'signed-out', accounts: [] });
        yield* Scope.close(scope, Exit.void);
      })
  );

  // -------------------------------------------------------------------------
  // recording:* — the record button and transcript over IPC
  // -------------------------------------------------------------------------

  it.effect(
    'recording:start folds every outcome to a typed result (no-session / ok / busy / permission-denied), sender+payload validated',
    () =>
      Effect.gen(function* () {
        const { layer } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        const bridge = Context.get(ctx, RecordingBridge);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        const start = (payload: unknown) =>
          Effect.promise(() =>
            fake.ipcMain.invoke(CHANNELS.recordingStart, { sender: wc }, payload)
          );

        // No live session ⇒ no-session (the button shouldn't reach here signed out,
        // but the bridge answers gracefully — never a throw).
        assert.deepStrictEqual(yield* start({ captureMode: 'dual', noteId: 'note_1' }), {
          ok: false,
          reason: 'no-session',
        });

        // Register a fake session service into the REAL bridge.
        const rec = yield* makeFakeRecordingService();
        yield* bridge.register(rec.api).pipe(Scope.extend(scope));

        // Happy path: the minted id comes back; the input reaches the service
        // (noteId defaulted, title threaded).
        assert.deepStrictEqual(
          yield* start({ captureMode: 'dual', noteId: 'note_1', title: 'Standup', quotaRemainingAtStartSeconds: 600 }),
          {
            ok: true,
            recordingId: 'rec_fake',
          }
        );
        assert.deepStrictEqual(rec.startCalls.at(-1), {
          captureMode: 'dual',
          noteId: 'note_1',
          title: 'Standup',
          quotaRemainingAtStartSeconds: 600,
        });

        // RecordingBusyError → busy.
        rec.setStart(Effect.fail(new RecordingBusyError({ activeRecordingId: 'rec_fake' })));
        assert.deepStrictEqual(yield* start({ captureMode: 'dual', noteId: null }), {
          ok: false,
          reason: 'busy',
        });
        assert.isNull(rec.startCalls.at(-1)?.quotaRemainingAtStartSeconds);

        // PermissionError → permission-denied (the renderer shows "mic denied").
        rec.setStart(
          Effect.fail(
            new PermissionError({
              requested: 'dual',
              effective: 'mic',
              reason: 'mic-denied',
              micStatus: 'denied',
            })
          )
        );
        assert.deepStrictEqual(yield* start({ captureMode: 'dual' }), {
          ok: false,
          reason: 'permission-denied',
        });

        // Malformed payload rejects the invoke WITHOUT reaching the service.
        const startCallsBefore = rec.startCalls.length;
        const badPayload = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(CHANNELS.recordingStart, { sender: wc }, { captureMode: 'bogus' })
          )
        );
        assert.isTrue(Exit.isFailure(badPayload));
        assert.strictEqual(rec.startCalls.length, startCallsBefore);

        // Unknown sender rejects too.
        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(
              CHANNELS.recordingStart,
              { sender: { id: 9999 } },
              { captureMode: 'dual' }
            )
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'recording:stop reaches the current session (no-op when signed out), sender+payload validated',
    () =>
      Effect.gen(function* () {
        const { layer } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        const bridge = Context.get(ctx, RecordingBridge);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        // No session ⇒ graceful no-op (resolves void).
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.recordingStop, { sender: wc }, { recordingId: 'rec_x' })
        );

        const rec = yield* makeFakeRecordingService();
        yield* bridge.register(rec.api).pipe(Scope.extend(scope));
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.recordingStop, { sender: wc }, { recordingId: 'rec_1' })
        );
        assert.deepStrictEqual(rec.stopCalls, ['rec_1']);

        // Malformed payload rejects WITHOUT a stop.
        const bad = yield* Effect.exit(
          Effect.tryPromise(() => fake.ipcMain.invoke(CHANNELS.recordingStop, { sender: wc }, {}))
        );
        assert.isTrue(Exit.isFailure(bad));

        // Unknown sender rejects.
        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(
              CHANNELS.recordingStop,
              { sender: { id: 9999 } },
              { recordingId: 'rec_1' }
            )
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        assert.deepStrictEqual(rec.stopCalls, ['rec_1']);
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('recording:claimCompletion preserves acceptance and rejects malformed or foreign requests', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      yield* Context.get(ctx, WindowRegistry).openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;
      const claim = (recordingId: string) => Effect.promise(() => fake.ipcMain.invoke(
        CHANNELS.recordingClaimCompletion, { sender: wc }, { recordingId }
      ));
      assert.isFalse(yield* claim('rec_1'), 'no workspace owns a completion');
      const rec = yield* makeFakeRecordingService();
      yield* Context.get(ctx, RecordingBridge).register(rec.api).pipe(Scope.extend(scope));
      assert.isFalse(yield* claim('rec_stale'));
      rec.setClaim(true);
      assert.isTrue(yield* claim('rec_1'));
      rec.setClaim(false);
      assert.isFalse(yield* claim('rec_1'));
      for (const [sender, payload] of [[wc, {}], [{ id: 9999 }, { recordingId: 'rec_1' }]]) {
        const rejected = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(
          CHANNELS.recordingClaimCompletion, { sender }, payload
        )));
        assert.isTrue(Exit.isFailure(rejected));
      }
      assert.deepStrictEqual(rec.claimCalls, ['rec_stale', 'rec_1', 'rec_1']);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'recording:stateChanged pushes the sanitized state (segments + mic-only) and dies with the scope',
    () =>
      Effect.gen(function* () {
        const { layer } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        const bridge = Context.get(ctx, RecordingBridge);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;
        const pushes = () =>
          (wc?.sent ?? []).filter(entry => entry.channel === CHANNELS.recordingStateChanged);

        const rec = yield* makeFakeRecordingService();
        yield* bridge.register(rec.api).pipe(Scope.extend(scope));

        // A recording state with a segment + a system/dual → mic degrade.
        const recordingState: RecordingState = {
          recordingId: 'rec_1',
          status: 'recording',
          captureMode: 'mic',
          requestedCaptureMode: 'dual',
          quotaRemainingAtStartSeconds: 600,
          noteId: 'note_1',
          segments: [
            {
              id: 'tsg_0',
              recordingId: 'rec_1',
              source: 'mic',
              speaker: 'you',
              text: 'hello from native',
              startTimeMs: 0,
              endTimeMs: 5000,
              segmentOrder: 1_000_000,
            },
          ],
          elapsedMs: 5000,
          elapsedAt: 1_700_000_005_000,
          startedAt: 1_700_000_000_000,
          pausedAccumMs: 0,
          micSource: 'system-default',
          autoPausePrompt: null,
          autoStopRequested: false,
        };
        yield* SubscriptionRef.set(rec.state, recordingState);
        yield* drainUntil(() =>
          pushes().some(entry => JSON.stringify(entry.payload).includes('hello from native'))
        );
        const pushed = pushes().find(entry =>
          JSON.stringify(entry.payload).includes('hello from native')
        );
        // Structurally the RecordingState — segments carried through, and the
        // requested !== effective capture mode (mic-only) the renderer surfaces.
        assert.deepStrictEqual(pushed?.payload, recordingState);
        const view = pushed?.payload as RecordingStateView;
        assert.strictEqual(view.captureMode, 'mic');
        assert.strictEqual(view.requestedCaptureMode, 'dual');
        assert.strictEqual(view.segments[0].text, 'hello from native');
        // No token-shaped field crosses (recording state is ids + text only).
        assert.notInclude(JSON.stringify(pushed?.payload), 'token');

        // Scope close releases the push fiber: later state changes reach no window.
        yield* Scope.close(scope, Exit.void);
        const settled = pushes().length;
        yield* SubscriptionRef.set(rec.state, idleRecordingState);
        yield* drainUntil(() => false);
        assert.strictEqual(pushes().length, settled);
      })
  );

  it.effect(
    'recording:stateChanged resets to idle on sign-out (bridge switches to the idle stream)',
    () =>
      Effect.gen(function* () {
        const { layer } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        const bridge = Context.get(ctx, RecordingBridge);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;
        const pushes = () =>
          (wc?.sent ?? []).filter(entry => entry.channel === CHANNELS.recordingStateChanged);

        // Register a session in a NESTED scope, drive it to 'recording', then close
        // that scope (sign-out) — the bridge must switch back to idle.
        const sessionScope = yield* Scope.make();
        const rec = yield* makeFakeRecordingService();
        yield* bridge.register(rec.api).pipe(Scope.extend(sessionScope));
        yield* SubscriptionRef.set(rec.state, {
          ...idleRecordingState,
          recordingId: 'rec_1',
          status: 'recording',
          captureMode: 'mic',
        });
        yield* drainUntil(() =>
          pushes().some(e => (e.payload as RecordingStateView).status === 'recording')
        );

        yield* Scope.close(sessionScope, Exit.void);
        yield* drainUntil(() =>
          pushes()
            .slice()
            .reverse()
            .some(e => (e.payload as RecordingStateView).status === 'idle')
        );
        const last = pushes().at(-1)?.payload as RecordingStateView;
        assert.strictEqual(last.status, 'idle');
        assert.isNull(last.recordingId);
        yield* Scope.close(scope, Exit.void);
      })
  );

  // -------------------------------------------------------------------------
  // settings:* — device-local preferences over IPC
  // -------------------------------------------------------------------------

  it.effect('onboarding persistence failure rejects without advancing progress', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      yield* Context.get(ctx, WindowRegistry).openMainWindow.pipe(Scope.extend(scope));
      const sender = fake.__windowInstances().at(-1)?.webContents;
      const operationalDb = Context.get(ctx, OperationalDb);
      const write = vi.spyOn(operationalDb, 'setSetting');
      write.mockReturnValueOnce(
        Effect.fail(new DbError({ op: 'setSetting', cause: 'disk unavailable' }))
      );
      const onboarding = { step: 'permissions', discoverySource: 'github', discoveryDetails: '' } as const;
      const failed = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(
        CHANNELS.settingsSet, { sender }, { onboarding }
      )));
      assert.isTrue(Exit.isFailure(failed));
      const current = yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.settingsGet, { sender }));
      assert.isNull((current as DeviceSettings).onboarding);
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.settingsSet, { sender }, { onboarding }));
      const saved = yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.settingsGet, { sender }));
      assert.deepStrictEqual((saved as DeviceSettings).onboarding, onboarding);
      write.mockRestore();
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'settings:get serves the current settings; settings:set merges + persists, both sender-validated',
    () =>
      Effect.gen(function* () {
        const { layer, logger, db } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        const get = () =>
          Effect.promise(() => fake.ipcMain.invoke(CHANNELS.settingsGet, { sender: wc }));

        // Boot defaults come back first.
        assert.deepStrictEqual(yield* get(), DEFAULT_DEVICE_SETTINGS);

        // A valid patch merges, persists one JSON row per changed field, and is
        // reflected by the next get.
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(
            CHANNELS.settingsSet,
            { sender: wc },
            { dockVisible: false, widgetVisibility: 'never' }
          )
        );
        const after = (yield* get()) as DeviceSettings;
        assert.strictEqual(after.dockVisible, false);
        assert.strictEqual(after.widgetVisibility, 'never');
        assert.strictEqual(db.store.get('pref:dockVisible'), 'false');
        assert.strictEqual(db.store.get('pref:widgetVisibility'), '"never"');

        // Invalid enum + an unknown key both reject WITHOUT mutating (warn + reject).
        const badEnum = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(CHANNELS.settingsSet, { sender: wc }, { widgetVisibility: 'bogus' })
          )
        );
        assert.isTrue(Exit.isFailure(badEnum));
        const extraKey = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(CHANNELS.settingsSet, { sender: wc }, { nope: 1 })
          )
        );
        assert.isTrue(Exit.isFailure(extraKey));
        assert.isDefined(
          logger.find(
            e => e.level === 'warn' && e.message === 'settings:set rejected: invalid payload'
          )
        );
        assert.strictEqual(((yield* get()) as DeviceSettings).widgetVisibility, 'never');

        // Unknown sender → typed rejection on both get and set (no data, no mutation).
        const foreignGet = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(CHANNELS.settingsGet, { sender: { id: 9999 } })
          )
        );
        assert.isTrue(Exit.isFailure(foreignGet));
        const foreignSet = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(
              CHANNELS.settingsSet,
              { sender: { id: 9999 } },
              { dockVisible: true }
            )
          )
        );
        assert.isTrue(Exit.isFailure(foreignSet));
        assert.strictEqual(db.store.get('pref:dockVisible'), 'false');
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'settings:changed replays the current settings and pushes each change; dies with the scope',
    () =>
      Effect.gen(function* () {
        const { layer } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        const settings = Context.get(ctx, SettingsService);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;
        const pushes = () => (wc?.sent ?? []).filter(e => e.channel === CHANNELS.settingsChanged);

        // The replayed current settings arrive with no mutation (the push fiber
        // subscribes to SubscriptionRef.changes, which replays the current value).
        yield* drainUntil(() => pushes().length >= 1);
        assert.deepStrictEqual(pushes().at(-1)?.payload, DEFAULT_DEVICE_SETTINGS);

        yield* settings.set({ widgetVisibility: 'never' });
        yield* drainUntil(() =>
          pushes().some(e => (e.payload as DeviceSettings).widgetVisibility === 'never')
        );
        assert.strictEqual((pushes().at(-1)?.payload as DeviceSettings).widgetVisibility, 'never');

        // Scope close releases the push fiber: a later change reaches no window.
        yield* Scope.close(scope, Exit.void);
        const settled = pushes().length;
        yield* settings.set({ dockVisible: false });
        yield* drainUntil(() => false);
        assert.strictEqual(pushes().length, settled);
      })
  );

  // -------------------------------------------------------------------------
  // capability:* — native action surface over IPC
  // -------------------------------------------------------------------------

  it.effect('capability:checkUpdates resolves the disabled-lane status, sender-validated', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      let refreshStarted = false;
      const handlerCtx = Context.add(ctx, RemoteConfig, {
        ...Context.get(ctx, RemoteConfig),
        refresh: Effect.sync(() => { refreshStarted = true; }).pipe(Effect.zipRight(Effect.never)),
      });
      yield* registerMainWindowHandlers.pipe(Effect.provide(handlerCtx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      // The IPC test config leaves the updater disabled (not packaged); the
      // enabled machine and cadence live in updater.test.ts.
      assert.deepStrictEqual(
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityCheckUpdates, { sender: wc })
        ),
        { status: 'disabled' }
      );
      // A stalled policy refresh must not delay the native updater action.
      yield* drainUntil(() => refreshStarted);
      assert.isTrue(refreshStarted);

      const foreign = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityCheckUpdates, { sender: { id: 9999 } })
        )
      );
      assert.isTrue(Exit.isFailure(foreign));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.scoped('update access follows policy and recording completion; native actions reject foreign senders', () =>
    Effect.gen(function* () {
      const { layer, nativeOs } = build();
      const ctx = yield* Layer.build(layer);
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx));
      yield* Context.get(ctx, WindowRegistry).openMainWindow;
      const wc = fake.__windowInstances().at(-1)!.webContents;
      const policy = Context.get(ctx, RemoteConfig).requirement;
      const rec = yield* makeFakeRecordingService();
      yield* Context.get(ctx, RecordingBridge).register(rec.api);
      const read = Effect.promise(() => fake.ipcMain.invoke(CHANNELS.updaterGetAccess, { sender: wc }));
      assert.deepEqual(yield* read, { requirement: null, recordingActive: false });
      const requirement = { required: true, evaluatedVersion: '0.0.0-test' };
      yield* SubscriptionRef.set(rec.state, { ...idleRecordingState, recordingId: 'rec_1', status: 'recording' });
      yield* SubscriptionRef.set(policy, requirement);
      assert.deepEqual(yield* read, { requirement, recordingActive: true });
      yield* SubscriptionRef.set(rec.state, { ...idleRecordingState, recordingId: 'rec_1', status: 'stopping' });
      assert.deepEqual(yield* read, { requirement, recordingActive: true });
      yield* SubscriptionRef.set(rec.state, idleRecordingState);
      assert.deepEqual(yield* read, { requirement, recordingActive: false });
      yield* drainUntil(() => wc.sent.some(e => e.channel === CHANNELS.updaterAccessChanged &&
        JSON.stringify(e.payload) === JSON.stringify({ requirement, recordingActive: false })));
      assert.deepEqual(wc.sent.filter(e => e.channel === CHANNELS.updaterAccessChanged).at(-1)?.payload,
        { requirement, recordingActive: false });
      for (const channel of [CHANNELS.updaterGetAccess, CHANNELS.updaterOpenDownload, CHANNELS.updaterQuit]) {
        const result = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(channel, { sender: { id: 9999 } })));
        assert.isTrue(Exit.isFailure(result));
      }
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.updaterOpenDownload, { sender: wc }));
      assert.deepEqual(nativeOs.calls.openExternal, ['https://prismical.ai/download']);
      const quits = fake.app.quitCount;
      yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.updaterQuit, { sender: wc }));
      assert.equal(fake.app.quitCount, quits + 1);
    })
  );

  it.effect(
    'updater:getState serves the sanitized view; quitInstall + dismissPrompt sender-validated',
    () =>
      Effect.gen(function* () {
        const { layer } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        // Disabled lane: the initial inert view (never staged, no prompt).
        assert.deepStrictEqual(
          yield* Effect.promise(() =>
            fake.ipcMain.invoke(CHANNELS.updaterGetState, { sender: wc })
          ),
          { status: 'disabled', staged: false, stagedVersion: null, prompt: null }
        );
        // quitInstall / dismissPrompt are no-ops here but must resolve (void).
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.updaterQuitInstall, { sender: wc })
        );
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.updaterDismissPrompt, { sender: wc })
        );

        // Foreign sender rejected on all three.
        for (const channel of [
          CHANNELS.updaterGetState,
          CHANNELS.updaterQuitInstall,
          CHANNELS.updaterDismissPrompt,
        ]) {
          const foreign = yield* Effect.exit(
            Effect.tryPromise(() => fake.ipcMain.invoke(channel, { sender: { id: 9999 } }))
          );
          assert.isTrue(Exit.isFailure(foreign), `foreign sender rejected on ${channel}`);
        }
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('capability:exportLogs requests a diagnostic bundle, sender-validated', () =>
    Effect.gen(function* () {
      const { layer, nativeOs } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      yield* Effect.promise(() =>
        fake.ipcMain.invoke(CHANNELS.capabilityExportLogs, { sender: wc })
      );
      assert.strictEqual(nativeOs.calls.reveal, 1);

      // Unknown sender → typed rejection, no reveal.
      const foreign = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityExportLogs, { sender: { id: 9999 } })
        )
      );
      assert.isTrue(Exit.isFailure(foreign));
      assert.strictEqual(nativeOs.calls.reveal, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  /** Two signed-in accounts, as the reset's sign-out-all lane sees them. */
  const twoAccountsState: AuthState = {
    gate: 'signed-in',
    accounts: {
      user_1: {
        sub: 'user_1',
        email: 'u1@example.com',
        name: 'User One',
        activeOrgId: 'org_1',
        orgs: [{ id: 'ou_1', orgId: 'org_1', userId: 'user_1' }],
      },
      user_2: {
        sub: 'user_2',
        email: 'u2@example.com',
        name: 'User Two',
        activeOrgId: 'org_2',
        orgs: [{ id: 'ou_2', orgId: 'org_2', userId: 'user_2' }],
      },
    },
    activeSub: 'user_1',
  };

  /** Boot the handler env with the main window open; seed the state a reset must sever. */
  const openForReset = (
    overrides: Parameters<typeof build>[0] = {},
    extras: Parameters<typeof build>[1] = {}
  ) =>
    Effect.gen(function* () {
      const built = build(overrides, {
        dbOptions: {
          recovery: [
            { recordingId: 'rec_1' } as RecoveryOutboxRow,
            { recordingId: 'rec_2' } as RecoveryOutboxRow,
          ],
        },
        ...extras,
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(built.layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;
      const secrets = Context.get(ctx, SecureStore);
      const { db } = built;
      // A preference row, the telemetry device id (which must be regenerated),
      // the EventKit device identity, and the secrets that reset sweeps.
      db.store.set('pref:launchAtLogin', 'true');
      db.store.set('pref:obsoleteSetting', 'true');
      db.store.set('app:mode', extras.appMode ?? 'cloud');
      db.store.set('telemetry:deviceId', 'old-device-id');
      db.store.set('eventkit:device-id', 'ek-device');
      db.store.set('eventkit:sequence:user_1:org_1', '7');
      db.store.set('auth.accounts', encodeAccountIndex(twoAccountsState));
      db.store.set('legacy.setting', 'stale-device-data');
      // An ORPHANED refresh secret (a sub no longer in the roster) as the real
      // secure store keeps it: a `secure:`-prefixed settings row.
      db.store.set('secure:auth.refreshToken.user_gone', 'ciphertext');
      yield* secrets.setSecret('transcription.byok.apiKey', 'byok-secret');
      yield* secrets.setSecret('ai.openai.apiKey', 'openai-secret');
      yield* secrets.setSecret('ai.ollama.apiKey', 'ollama-secret');
      yield* secrets.setSecret('auth.refreshToken.user_1', 'refresh-secret');
      yield* SubscriptionRef.set(Context.get(ctx, AuthService).sessionState, twoAccountsState);
      assert.strictEqual(db.recovery.size, 2);
      // The fake session accumulates across tests — assert on this test's tail.
      const storageCallsBefore = fake.session.defaultSession.clearDataCalls.length;
      const authCacheCallsBefore = fake.session.defaultSession.clearAuthCacheCalls;
      return { ...built, scope, ctx, wc, secrets, storageCallsBefore, authCacheCallsBefore };
    });

  const assertDeviceStateCleared = (
    h: Effect.Effect.Success<ReturnType<typeof openForReset>>
  ) =>
    Effect.gen(function* () {
      const { db, secrets } = h;
      // Every pref row deleted, recovery outbox emptied, EventKit identity gone.
      assert.isFalse([...db.store.keys()].some(key => key.startsWith('pref:')));
      assert.strictEqual(db.recovery.size, 0);
      assert.isFalse([...db.store.keys()].some(key => key.startsWith('eventkit:')));
      assert.isFalse([...db.store.keys()].some(key => key.startsWith('auth.')));
      assert.isFalse([...db.store.keys()].some(key => key.startsWith('secure:')));
      assert.isUndefined(db.store.get('legacy.setting'));
      // The known non-auth secrets are gone.
      assert.isNull(yield* secrets.getSecret('transcription.byok.apiKey'));
      assert.isNull(yield* secrets.getSecret('ai.openai.apiKey'));
      assert.isNull(yield* secrets.getSecret('ai.ollama.apiKey'));
      assert.isNull(yield* secrets.getSecret('auth.refreshToken.user_1'));
      // Identity severance: a FRESH device id was written (not merely cleared),
      // and EVERY renderer storage was wiped (no storages filter).
      const newDeviceId = db.store.get('telemetry:deviceId');
      assert.isString(newDeviceId);
      assert.notStrictEqual(newDeviceId, 'old-device-id');
      assert.deepStrictEqual(
        fake.session.defaultSession.clearDataCalls.slice(h.storageCallsBefore),
        [{}]
      );
      assert.strictEqual(fake.session.defaultSession.clearAuthCacheCalls, h.authCacheCallsBefore + 1);
      // The boot-time purge marker names the product stores, the models and the
      // recovery WAVs (from AppConfig) and asks for the local_model rows too.
      const marker = db.store.get('app:pendingPurge');
      assert.isString(marker);
      assert.deepStrictEqual(JSON.parse(marker!), {
        v: 1,
        paths: [
          ':memory:',
          path.join(tmpdir(), 'prismical-test-cloud-cache'),
          path.join(tmpdir(), 'prismical-test-models'),
          '/fake/user-data/recovery',
        ],
        localModels: true,
        settings: {
          'telemetry:deviceId': newDeviceId,
          ...(db.store.has('app:mode') ? { 'app:mode': db.store.get('app:mode') } : {}),
        },
        attempts: 0,
      });
    });

  it.effect(
    'capability:resetApp (plain) signs out every account, clears device state and mode, then relaunches',
    () =>
      Effect.gen(function* () {
        const h = yield* openForReset();
        const { db, nativeOs, auth, wc, scope } = h;

        // The legacy preload sent no payload — still the plain reset.
        yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.capabilityResetApp, { sender: wc }));

        yield* assertDeviceStateCleared(h);
        assert.deepStrictEqual(auth.signOutCalls, ['user_1', 'user_2']);
        assert.isUndefined(db.store.get('app:mode'));
        // A new boot sees an unchosen mode, rather than restoring the old
        // cloud roster through AppModeLive's upgrade inference.
        const next = yield* Layer.build(Layer.mergeAll(
          AppModeLive,
          makeAuthLive({ fetchFn: () => Promise.reject(new Error('reset must not restore a session')) })
        ).pipe(Layer.provide(Layer.succeedContext(h.ctx)))).pipe(Scope.extend(scope));
        assert.isFalse(yield* SubscriptionRef.get(Context.get(next, AppModeService).chosenState));
        assert.deepStrictEqual(yield* SubscriptionRef.get(Context.get(next, AuthService).sessionState), initialAuthState);
        assert.strictEqual(nativeOs.calls.relaunch, 1);

        // Unknown sender → typed rejection, no second relaunch.
        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(CHANNELS.capabilityResetApp, { sender: { id: 9999 } })
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        assert.strictEqual(nativeOs.calls.relaunch, 1);
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'capability:resetApp { mode } is the mode switch: signs out every account, writes app:mode, then relaunches',
    () =>
      Effect.gen(function* () {
        const h = yield* openForReset();
        const { db, nativeOs, auth, wc, scope } = h;

        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityResetApp, { sender: wc }, { mode: 'local' })
        );

        yield* assertDeviceStateCleared(h);
        // Both accounts signed out (each sign-out wipes its refresh secret +
        // rewrites the index in the real service); the next boot is local.
        assert.deepStrictEqual(auth.signOutCalls, ['user_1', 'user_2']);
        // And the whole `secure:` namespace is swept — a sign-out whose delete
        // failed, or an orphaned row, cannot ride into the accountless install.
        assert.isFalse([...db.store.keys()].some(key => key.startsWith('secure:')));
        assert.strictEqual(db.store.get('app:mode'), 'local');
        assert.strictEqual(nativeOs.calls.relaunch, 1);
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('capability:resetApp rejects a malformed payload without touching anything', () =>
    Effect.gen(function* () {
      const h = yield* openForReset();
      const { db, nativeOs, wc, scope } = h;

      for (const bad of [{ mode: 'hybrid' }, { mode: 'local', extra: 1 }, 'local']) {
        const rejected = yield* Effect.exit(
          Effect.tryPromise(() => fake.ipcMain.invoke(CHANNELS.capabilityResetApp, { sender: wc }, bad))
        );
        assert.isTrue(Exit.isFailure(rejected));
      }
      assert.strictEqual(db.store.get('pref:launchAtLogin'), 'true');
      assert.strictEqual(db.recovery.size, 2);
      assert.isUndefined(db.store.get('app:pendingPurge'));
      assert.strictEqual(nativeOs.calls.relaunch, 0);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('plain reset clears local mode and stale credentials even with an empty live roster', () =>
    Effect.gen(function* () {
      const h = yield* openForReset({}, { appMode: 'local' });
      yield* SubscriptionRef.set(Context.get(h.ctx, AuthService).sessionState, initialAuthState);

      yield* Effect.promise(() =>
        fake.ipcMain.invoke(CHANNELS.capabilityResetApp, { sender: h.wc }, {})
      );

      yield* assertDeviceStateCleared(h);
      assert.deepStrictEqual(h.auth.signOutCalls, []);
      assert.isUndefined(h.db.store.get('app:mode'));
      assert.strictEqual(h.nativeOs.calls.relaunch, 1);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('reset refuses to clear state or relaunch if the purge marker cannot be saved', () =>
    Effect.gen(function* () {
      const h = yield* openForReset();
      const db = Context.get(h.ctx, OperationalDb);
      const write = vi.spyOn(db, 'setSetting').mockReturnValueOnce(
        Effect.fail(new DbError({ op: 'setSetting', cause: 'disk unavailable' }))
      );
      try {
        const result = yield* Effect.exit(Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityResetApp, { sender: h.wc })
        ));
        assert.isTrue(Exit.isFailure(result));
        assert.deepStrictEqual(h.auth.signOutCalls, []);
        assert.strictEqual(h.db.store.get('app:mode'), 'cloud');
        assert.strictEqual(h.db.store.get('pref:launchAtLogin'), 'true');
        assert.strictEqual(yield* h.secrets.getSecret('auth.refreshToken.user_1'), 'refresh-secret');
        assert.strictEqual(h.db.recovery.size, 2);
        assert.strictEqual(fake.session.defaultSession.clearDataCalls.length, h.storageCallsBefore);
        assert.strictEqual(h.nativeOs.calls.relaunch, 0);
      } finally {
        write.mockRestore();
        yield* Scope.close(h.scope, Exit.void);
      }
    })
  );

  it.effect('under isE2E the reset quits instead of relaunching — Playwright observes the exit', () =>
    Effect.gen(function* () {
      const h = yield* openForReset({ isE2E: true });
      const { nativeOs, wc, scope } = h;
      const quitsBefore = fake.app.quitCount;

      yield* Effect.promise(() =>
        fake.ipcMain.invoke(CHANNELS.capabilityResetApp, { sender: wc }, { mode: 'cloud' })
      );

      yield* assertDeviceStateCleared(h);
      assert.strictEqual(nativeOs.calls.relaunch, 0);
      assert.strictEqual(fake.app.quitCount, quitsBefore + 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('same-mode choice becomes shared state only after successful persistence', () =>
    Effect.gen(function* () {
      const { layer, db, nativeOs } = build({}, { appModeChosen: false });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      yield* Context.get(ctx, WindowRegistry).openMainWindow.pipe(Scope.extend(scope));
      const sender = fake.__windowInstances().at(-1)?.webContents;
      const appMode = Context.get(ctx, AppModeService);
      const operationalDb = Context.get(ctx, OperationalDb);
      const write = vi.spyOn(operationalDb, 'setSetting');
      write.mockReturnValueOnce(Effect.fail(new DbError({ op: 'setSetting', cause: 'disk unavailable' })));
      const failed = yield* Effect.exit(Effect.tryPromise(() => fake.ipcMain.invoke(
        CHANNELS.capabilityChooseAppMode, { sender }, { mode: 'cloud' },
      )));
      assert.isTrue(Exit.isFailure(failed));
      assert.isFalse(yield* SubscriptionRef.get(appMode.chosenState));
      assert.isUndefined(db.store.get('app:mode'));
      const chosen = yield* Effect.promise(() => fake.ipcMain.invoke(
        CHANNELS.capabilityChooseAppMode, { sender }, { mode: 'cloud' },
      ));
      assert.deepStrictEqual(chosen, { relaunch: false });
      assert.isTrue(yield* SubscriptionRef.get(appMode.chosenState));
      assert.deepStrictEqual(yield* Effect.promise(() => fake.ipcMain.invoke(
        CHANNELS.capabilityGetAppModeState, { sender },
      )), { mode: 'cloud', chosen: true });
      assert.strictEqual(nativeOs.calls.relaunch, 0);
      write.mockRestore();
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('choosing local does not enable the old unchosen cloud process before relaunch', () =>
    Effect.gen(function* () {
      const { layer, nativeOs } = build({}, { appModeChosen: false });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      yield* Context.get(ctx, WindowRegistry).openMainWindow.pipe(Scope.extend(scope));
      const sender = fake.__windowInstances().at(-1)?.webContents;
      yield* Effect.promise(() => fake.ipcMain.invoke(
        CHANNELS.capabilityChooseAppMode, { sender }, { mode: 'local' },
      ));
      assert.isFalse(yield* SubscriptionRef.get(Context.get(ctx, AppModeService).chosenState));
      assert.strictEqual(nativeOs.calls.relaunch, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('capability:getAppModeState serves the boot mode and chosen flag, sender-validated', () =>
    Effect.gen(function* () {
      const { layer } = build({}, { appMode: 'local' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      const state = yield* Effect.promise(() =>
        fake.ipcMain.invoke(CHANNELS.capabilityGetAppModeState, { sender: wc })
      );
      assert.deepStrictEqual(state, { mode: 'local', chosen: true });

      const foreign = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityGetAppModeState, { sender: { id: 9999 } })
        )
      );
      assert.isTrue(Exit.isFailure(foreign));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'capability:chooseAppMode persists the raw mode; relaunches only when it differs from the boot mode',
    () =>
      Effect.gen(function* () {
        const { layer, db, nativeOs, auth } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;
        const storageCallsBefore = fake.session.defaultSession.clearDataCalls.length;

        // Booted 'cloud' (the fresh-install default): choosing cloud is a
        // persist-and-proceed, no relaunch.
        const same = yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityChooseAppMode, { sender: wc }, { mode: 'cloud' })
        );
        assert.deepStrictEqual(same, { relaunch: false });
        // The RAW string — AppModeLive matches it verbatim (a JSON-quoted value
        // is the pinned malformed case that silently boots cloud).
        assert.strictEqual(db.store.get('app:mode'), 'cloud');
        assert.strictEqual(nativeOs.calls.relaunch, 0);

        // Choosing local from a cloud boot: persisted, every account in the
        // roster signed out (a backstop — nothing should be signed in under the
        // chooser), then relaunch.
        yield* SubscriptionRef.set(Context.get(ctx, AuthService).sessionState, twoAccountsState);
        const other = yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityChooseAppMode, { sender: wc }, { mode: 'local' })
        );
        assert.deepStrictEqual(other, { relaunch: true });
        assert.strictEqual(db.store.get('app:mode'), 'local');
        assert.deepStrictEqual(auth.signOutCalls, ['user_1', 'user_2']);
        assert.strictEqual(nativeOs.calls.relaunch, 1);

        // Nothing else was touched — this is a choice, not a reset.
        assert.isUndefined(db.store.get('app:pendingPurge'));
        assert.strictEqual(
          fake.session.defaultSession.clearDataCalls.length,
          storageCallsBefore
        );

        // Malformed payload / unknown sender → typed rejections, no relaunch.
        for (const bad of [{ mode: 'hybrid' }, {}, undefined]) {
          const rejected = yield* Effect.exit(
            Effect.tryPromise(() =>
              fake.ipcMain.invoke(CHANNELS.capabilityChooseAppMode, { sender: wc }, bad)
            )
          );
          assert.isTrue(Exit.isFailure(rejected));
        }
        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(
              CHANNELS.capabilityChooseAppMode,
              { sender: { id: 9999 } },
              { mode: 'local' }
            )
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        assert.strictEqual(nativeOs.calls.relaunch, 1);
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'capability:restartApp relaunches without clearing device state, sender-validated',
    () =>
      Effect.gen(function* () {
        const { layer, db, nativeOs } = build(
          {},
          {
            dbOptions: {
              recovery: [{ recordingId: 'rec_1' } as RecoveryOutboxRow],
            },
          }
        );
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        db.store.set('pref:language', '"de"');
        assert.strictEqual(db.recovery.size, 1);

        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityRestartApp, { sender: wc })
        );

        assert.strictEqual(db.store.get('pref:language'), '"de"');
        assert.strictEqual(db.recovery.size, 1);
        assert.strictEqual(nativeOs.calls.relaunch, 1);

        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(CHANNELS.capabilityRestartApp, { sender: { id: 9999 } })
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        assert.strictEqual(nativeOs.calls.relaunch, 1);
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'capability:{set,has,clear}TranscriptionByokKey keep the key in the secure store and never log it',
    () =>
      Effect.gen(function* () {
        const { layer, logger } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;
        const store = Context.get(ctx, SecureStore);
        const KEY = 'transcription.byok.apiKey';
        const SENTINEL = 'sk-byok-sentinel-7f3a';
        const ENDPOINT = 'https://transcription.test/v1';
        const settings = Context.get(ctx, SettingsService);
        const transcription = (yield* settings.get).transcription;
        yield* settings.set({ transcription: { ...transcription, byokBaseUrl: ENDPOINT } });
        const has = () =>
          Effect.promise(() =>
            fake.ipcMain.invoke(CHANNELS.capabilityHasTranscriptionByokKey, { sender: wc })
          );

        assert.strictEqual(yield* has(), false);

        yield* Effect.promise(() =>
          fake.ipcMain.invoke(
            CHANNELS.capabilitySetTranscriptionByokKey,
            { sender: wc },
            { key: SENTINEL, baseUrl: ENDPOINT }
          )
        );
        assert.strictEqual(yield* has(), true);
        assert.deepStrictEqual(JSON.parse((yield* store.getSecret(KEY))!), {
          key: SENTINEL, baseUrl: ENDPOINT,
        });

        yield* settings.set({ transcription: { ...transcription, byokBaseUrl: 'https://other.test/v1' } });
        assert.strictEqual(yield* has(), false, 'a different endpoint must request its own key');
        yield* settings.set({ transcription: { ...transcription, byokBaseUrl: ENDPOINT } });
        assert.strictEqual(yield* has(), true);

        // Malformed payloads reject (typed) without touching the stored key.
        for (const payload of [{ key: '', baseUrl: ENDPOINT }, { key: SENTINEL, baseUrl: ENDPOINT, extra: 1 }, { key: SENTINEL }, { key: SENTINEL, baseUrl: '  ' }, {}, 'sk-raw']) {
          const bad = yield* Effect.exit(
            Effect.tryPromise(() =>
              fake.ipcMain.invoke(
                CHANNELS.capabilitySetTranscriptionByokKey,
                { sender: wc },
                payload
              )
            )
          );
          assert.isTrue(Exit.isFailure(bad));
        }
        assert.deepStrictEqual(JSON.parse((yield* store.getSecret(KEY))!), {
          key: SENTINEL, baseUrl: ENDPOINT,
        });

        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityClearTranscriptionByokKey, { sender: wc })
        );
        assert.strictEqual(yield* has(), false);
        assert.isNull(yield* store.getSecret(KEY));

        // Unknown sender → typed rejection on every verb; nothing stored.
        for (const channel of [
          CHANNELS.capabilitySetTranscriptionByokKey,
          CHANNELS.capabilityClearTranscriptionByokKey,
          CHANNELS.capabilityHasTranscriptionByokKey,
        ]) {
          const foreign = yield* Effect.exit(
            Effect.tryPromise(() =>
              fake.ipcMain.invoke(channel, { sender: { id: 9999 } }, { key: 'sk-foreign' })
            )
          );
          assert.isTrue(Exit.isFailure(foreign), `foreign sender rejected on ${channel}`);
        }
        assert.isNull(yield* store.getSecret(KEY));

        // The key never reached a log line — message or data, valid or rejected.
        const logged = JSON.stringify(logger.entries);
        assert.notInclude(logged, SENTINEL);
        assert.notInclude(logged, 'sk-foreign');
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('capability:getPermissions serves mic + system-audio status, sender-validated', () =>
    Effect.gen(function* () {
      const sysPermissions = makeFakeSystemPermissions({
        micStatus: 'granted',
        systemVersion: '14.4.0',
      });
      const { layer } = build({ platform: 'darwin' }, { sysPermissions });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      // darwin ≥14.2 → system audio usable; mic is Electron's status verbatim.
      assert.deepStrictEqual(
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityGetPermissions, { sender: wc })
        ),
        { microphone: 'granted', systemAudio: 'granted' }
      );

      const foreign = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(CHANNELS.capabilityGetPermissions, { sender: { id: 9999 } })
        )
      );
      assert.isTrue(Exit.isFailure(foreign));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'capability:requestPermission prompts the mic + returns refreshed statuses, payload+sender validated',
    () =>
      Effect.gen(function* () {
        const sysPermissions = makeFakeSystemPermissions({
          micStatus: 'not-determined',
          systemVersion: '14.4.0',
        });
        const { layer } = build({ platform: 'darwin' }, { sysPermissions });
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;

        // mic → the OS prompt runs once and the refreshed (granted) statuses return.
        assert.deepStrictEqual(
          yield* Effect.promise(() =>
            fake.ipcMain.invoke(
              CHANNELS.capabilityRequestPermission,
              { sender: wc },
              { kind: 'microphone' }
            )
          ),
          { microphone: 'granted', systemAudio: 'granted' }
        );
        assert.strictEqual(sysPermissions.requestCount(), 1);

        // system-audio → no prompt API here (re-read only), request count unchanged.
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(
            CHANNELS.capabilityRequestPermission,
            { sender: wc },
            { kind: 'system-audio' }
          )
        );
        assert.strictEqual(sysPermissions.requestCount(), 1);

        // Invalid kind + unknown key both reject WITHOUT prompting.
        for (const bad of [{ kind: 'bogus' }, { kind: 'microphone', extra: true }, {}]) {
          const rejected = yield* Effect.exit(
            Effect.tryPromise(() =>
              fake.ipcMain.invoke(CHANNELS.capabilityRequestPermission, { sender: wc }, bad)
            )
          );
          assert.isTrue(Exit.isFailure(rejected));
        }
        assert.strictEqual(sysPermissions.requestCount(), 1);

        // Unknown sender → typed rejection.
        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(
              CHANNELS.capabilityRequestPermission,
              { sender: { id: 9999 } },
              { kind: 'microphone' }
            )
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'Apple Calendar capability calls stay behind the signed-in bridge and sender gate',
    () =>
      Effect.gen(function* () {
        const { layer } = build({ platform: 'darwin' });
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;
        const bridge = Context.get(ctx, EventKitBridge);
        const serviceScope = yield* Scope.make();
        const ready = {
          permission: 'granted' as const,
          state: 'ready' as const,
          lastRefreshedAt: '2026-07-28T10:00:00.000Z',
          error: null,
        };
        const syncing = { ...ready, state: 'syncing' as const };
        yield* bridge
          .register({
            getStatus: Effect.succeed(ready),
            enable: Effect.succeed(ready),
            refresh: Effect.succeed(syncing),
          })
          .pipe(Scope.extend(serviceScope));

        assert.deepStrictEqual(
          yield* Effect.promise(() =>
            fake.ipcMain.invoke(CHANNELS.capabilityGetAppleCalendarStatus, { sender: wc })
          ),
          ready
        );
        assert.deepStrictEqual(
          yield* Effect.promise(() =>
            fake.ipcMain.invoke(CHANNELS.capabilityEnableAppleCalendar, { sender: wc })
          ),
          ready
        );
        assert.deepStrictEqual(
          yield* Effect.promise(() =>
            fake.ipcMain.invoke(CHANNELS.capabilityRefreshAppleCalendar, { sender: wc })
          ),
          syncing
        );

        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(CHANNELS.capabilityEnableAppleCalendar, {
              sender: { id: 9999 },
            })
          )
        );
        assert.isTrue(Exit.isFailure(foreign));

        yield* Scope.close(serviceScope, Exit.void);
        assert.deepStrictEqual(
          yield* Effect.promise(() =>
            fake.ipcMain.invoke(CHANNELS.capabilityGetAppleCalendarStatus, { sender: wc })
          ),
          {
            permission: 'unavailable',
            state: 'disabled',
            lastRefreshedAt: null,
            error: null,
          }
        );
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('capability:openSystemSettings deep-links the OS pane, payload+sender validated', () =>
    Effect.gen(function* () {
      const { layer, nativeOs } = build({ platform: 'darwin' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      yield* Effect.promise(() =>
        fake.ipcMain.invoke(
          CHANNELS.capabilityOpenSystemSettings,
          { sender: wc },
          { kind: 'microphone' }
        )
      );
      yield* Effect.promise(() =>
        fake.ipcMain.invoke(
          CHANNELS.capabilityOpenSystemSettings,
          { sender: wc },
          { kind: 'system-audio' }
        )
      );
      assert.deepStrictEqual(nativeOs.calls.openExternal, [
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
      ]);

      // Invalid payload rejects WITHOUT opening anything.
      const bad = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(
            CHANNELS.capabilityOpenSystemSettings,
            { sender: wc },
            { kind: 'bogus' }
          )
        )
      );
      assert.isTrue(Exit.isFailure(bad));

      // Unknown sender rejects too.
      const foreign = yield* Effect.exit(
        Effect.tryPromise(() =>
          fake.ipcMain.invoke(
            CHANNELS.capabilityOpenSystemSettings,
            { sender: { id: 9999 } },
            { kind: 'microphone' }
          )
        )
      );
      assert.isTrue(Exit.isFailure(foreign));
      assert.strictEqual(nativeOs.calls.openExternal.length, 2);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // -------------------------------------------------------------------------
  // models:* — the local whisper model manager over IPC
  // -------------------------------------------------------------------------

  it.effect('models:getState serves the parsed snapshot to app senders only', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;

      const view = yield* Effect.promise(() =>
        fake.ipcMain.invoke(CHANNELS.modelsGetState, { sender: wc })
      );
      assert.deepStrictEqual(view, MODELS_STATE);
      assert.isTrue(parseModelsStateView(view).success);
      // No download URL crosses (the renderer never needs it).
      assert.notInclude(JSON.stringify(view), 'http');

      const foreign = yield* Effect.exit(
        Effect.tryPromise(() => fake.ipcMain.invoke(CHANNELS.modelsGetState, { sender: { id: 9999 } }))
      );
      assert.isTrue(Exit.isFailure(foreign));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'models:download/cancelDownload/delete validate the strict payload, forward the id, fold a refusal to void',
    () =>
      Effect.gen(function* () {
        const { layer, logger, models } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
        const registry = Context.get(ctx, WindowRegistry);
        yield* registry.openMainWindow.pipe(Scope.extend(scope));
        const wc = fake.__windowInstances().at(-1)?.webContents;
        const request = { modelId: 'whisper-base-en' };

        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.modelsDownload, { sender: wc }, request)
        );
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.modelsCancelDownload, { sender: wc }, request)
        );
        yield* Effect.promise(() => fake.ipcMain.invoke(CHANNELS.modelsDelete, { sender: wc }, request));
        assert.deepStrictEqual(models.calls, [
          { verb: 'download', modelId: 'whisper-base-en' },
          { verb: 'cancel', modelId: 'whisper-base-en' },
          { verb: 'delete', modelId: 'whisper-base-en' },
        ]);

        // A typed refusal (already installed) is logged and folded — the verb is
        // fire-and-forget; the state push carries the truth. The invoke RESOLVES.
        models.setDownload(
          Effect.fail(new ModelError({ reason: 'already-installed', modelId: 'whisper-base-en' }))
        );
        yield* Effect.promise(() =>
          fake.ipcMain.invoke(CHANNELS.modelsDownload, { sender: wc }, request)
        );
        assert.isDefined(
          logger.find(e => e.level === 'warn' && e.message === 'models:download refused')
        );

        // Schema rejections (missing/empty id, extra key) reject WITHOUT a call.
        const before = models.calls.length;
        for (const channel of [
          CHANNELS.modelsDownload,
          CHANNELS.modelsCancelDownload,
          CHANNELS.modelsDelete,
        ]) {
          for (const bad of [{}, { modelId: '' }, { modelId: 'x', extra: true }, 'whisper-base-en']) {
            const rejected = yield* Effect.exit(
              Effect.tryPromise(() => fake.ipcMain.invoke(channel, { sender: wc }, bad))
            );
            assert.isTrue(Exit.isFailure(rejected));
          }
        }
        assert.strictEqual(models.calls.length, before);

        // Unknown sender → typed rejection, no call.
        const foreign = yield* Effect.exit(
          Effect.tryPromise(() =>
            fake.ipcMain.invoke(CHANNELS.modelsDownload, { sender: { id: 4242 } }, request)
          )
        );
        assert.isTrue(Exit.isFailure(foreign));
        assert.strictEqual(models.calls.length, before);
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('models:stateChanged pushes every snapshot change and dies with the scope', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* registerMainWindowHandlers.pipe(Effect.provide(ctx), Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      const manager = Context.get(ctx, ModelManager);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;
      assert.isDefined(wc);
      const pushes = () =>
        (wc?.sent ?? []).filter(entry => entry.channel === CHANNELS.modelsStateChanged);

      const installed: ModelsStateView = {
        ...MODELS_STATE,
        models: [
          {
            ...MODELS_STATE.models[0],
            installed: true,
            installedAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      };
      yield* SubscriptionRef.set(manager.state, installed);
      yield* drainUntil(() =>
        pushes().some(entry => (entry.payload as ModelsStateView).models[0]?.installed === true)
      );
      const push = pushes().find(
        entry => (entry.payload as ModelsStateView).models[0]?.installed === true
      );
      assert.deepStrictEqual(push?.payload, installed);
      for (const entry of pushes()) assert.isTrue(parseModelsStateView(entry.payload).success);

      // Scope close releases the push fiber with the handlers.
      yield* Scope.close(scope, Exit.void);
      const settled = pushes().length;
      yield* SubscriptionRef.set(manager.state, MODELS_STATE);
      yield* drainUntil(() => false);
      assert.strictEqual(pushes().length, settled);
    })
  );
});
