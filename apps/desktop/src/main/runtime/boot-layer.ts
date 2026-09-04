/**
 * The boot layer lives for the process. The whole dependency graph is readable
 * in one place:
 *
 *   BootLayer
 *   ├─ AppConfig            (leaf: env + PRISMICAL_E2E flags + endpoint descriptor)
 *   ├─ MainLogger           (leaf: electron-log bridge + redaction)
 *   ├─ ElectronApp          ← MainLogger
 *   ├─ OperationalDb        ← AppConfig, MainLogger
 *   ├─ AppModeService       ← OperationalDb, MainLogger (boot-resolved mode)
 *   ├─ AiProvider           ← SettingsService, SecureStore, MainLogger (LLM provider)
 *   ├─ SecureStore          ← AppConfig, ElectronApp, OperationalDb, MainLogger
 *   ├─ SettingsService      ← OperationalDb, MainLogger (device-local prefs)
 *   ├─ DesktopI18n          ← ElectronApp, SettingsService
 *   ├─ WindowRegistry       ← AppConfig, ElectronApp, SettingsService, MainLogger
 *   ├─ DeepLinks            ← ElectronApp, MainLogger
 *   ├─ AuthService          ← AppConfig, SecureStore, OperationalDb, ElectronApp, WindowRegistry, MainLogger
 *   ├─ TrayService          ← AppConfig, DesktopI18n, ElectronApp, MainLogger
 *   ├─ UpdaterService       ← AppConfig, MainLogger
 *   ├─ ModelManager         ← AppConfig, OperationalDb, MainLogger (local whisper weights)
 *   ├─ WhisperEngine        ← AppConfig, MainLogger (the whisper.cpp worker host)
 *   ├─ StreamBroker         ← MainLogger
 *   ├─ CollabBridge         (leaf: boot-scoped note-body-store accessor)
 *   ├─ CollabBroker         ← MainLogger, CollabBridge (note-body log relay)
 *   ├─ ShutdownCoordinator  ← AppConfig, ElectronApp, MainLogger
 *   ├─ SystemPermissions    (leaf: mic TCC + OS version electron edge)
 *   ├─ NativeOs             (leaf: login-item/dock/shell/relaunch electron edge)
 *   ├─ WorkspaceTransport   (leaf: boot-scoped workspace-current backend accessor)
 *   └─ SessionLifecycleProbe (leaf: workspace lifecycle counters — e2e probe)
 *
 * makeBootLayer exists so tests can substitute the AppConfig leaf (fake paths,
 * updater gates, failure injection) while building the real graph.
 */
import { Layer } from 'effect';
import { AppModeLive } from '../domains/app-mode/live';
import type { AppModeService } from '../domains/app-mode/service';
import { AiProviderLive } from '../domains/ai-provider/live';
import type { AiProvider } from '../domains/ai-provider/service';
import { AuthServiceLive } from '../domains/auth/live';
import type { AuthService } from '../domains/auth/service';
import { CollabBrokerLive } from '../domains/collab/live';
import type { CollabBroker } from '../domains/collab/service';
import { CollabBridgeLive } from '../domains/collab/store-live';
import type { CollabBridge } from '../domains/collab/store';
import { RecordingBridgeLive, type RecordingBridge } from '../domains/recording/bridge';
import { DetectionBridgeLive, type DetectionBridge } from '../domains/detection/bridge';
import { EventKitBridgeLive, type EventKitBridge } from '../domains/eventkit/bridge';
import { DesktopI18nLive } from '../domains/i18n/live';
import type { DesktopI18n } from '../domains/i18n/service';
import { ModelManagerLive } from '../domains/models/live';
import type { ModelManager } from '../domains/models/service';
import { DeepLinksLive } from '../domains/deep-link/live';
import type { DeepLinks } from '../domains/deep-link/service';
import { ShutdownCoordinatorLive } from '../domains/shutdown/live';
import type { ShutdownCoordinator } from '../domains/shutdown/service';
import { SettingsServiceLive } from '../domains/settings/live';
import { FloatBridgeLive, type FloatBridge } from '../domains/windows/float-bridge';
import type { SettingsService } from '../domains/settings/service';
import { makeTelemetryServiceLive } from '../domains/telemetry/live';
import { makePostHogNodeSink } from '../domains/telemetry/posthog-sink';
import type { TelemetryService } from '../domains/telemetry/service';
import { StreamBrokerLive } from '../domains/streams/live';
import type { StreamBroker } from '../domains/streams/service';
import { WorkspaceTransportLive } from '../domains/transport/live';
import type { WorkspaceTransport } from '../domains/transport/service';
import { TrayServiceLive } from '../domains/tray/live';
import type { TrayService } from '../domains/tray/service';
import { UpdaterServiceLive } from '../domains/updater/live';
import type { UpdaterService } from '../domains/updater/service';
import { WindowRegistryLive } from '../domains/windows/live';
import type { WindowError, WindowRegistry } from '../domains/windows/service';
import { AppConfigLive } from '../infra/config/live';
import type { AppConfig } from '../infra/config/service';
import { ElectronAppLive } from '../infra/electron/live';
import type { ElectronApp } from '../infra/electron/service';
import { MainLoggerLive } from '../infra/logging/live';
import type { MainLogger } from '../infra/logging/service';
import { NativeOsLive } from '../infra/native-os/live';
import type { NativeOs } from '../infra/native-os/service';
import { OperationalDbLive } from '../infra/operational-db/live';
import type { OperationalDb } from '../infra/operational-db/service';
import { PendingResetLive } from '../infra/pending-reset/live';
import type { PendingReset } from '../infra/pending-reset/service';
import { SecureStoreLive } from '../infra/secure-store/live';
import type { SecureStore } from '../infra/secure-store/service';
import { SystemPermissionsLive } from '../infra/system-permissions/live';
import type { SystemPermissions } from '../infra/system-permissions/service';
import { WhisperEngineLive } from '../infra/whisper/engine';
import type { WhisperEngine } from '../infra/whisper/service';
import type { BootError } from './boot-error';
import { SessionLifecycleProbeLive, type SessionLifecycleProbe } from './workspace-lifecycle';

export type BootServices =
  | AppConfig
  | MainLogger
  | ElectronApp
  | OperationalDb
  | SecureStore
  | WindowRegistry
  | DeepLinks
  | AuthService
  | TrayService
  | UpdaterService
  | ModelManager
  | WhisperEngine
  | StreamBroker
  | ShutdownCoordinator
  | SettingsService
  | DesktopI18n
  | TelemetryService
  | SystemPermissions
  | NativeOs
  | WorkspaceTransport
  | RecordingBridge
  | DetectionBridge
  | FloatBridge
  | EventKitBridge
  | CollabBridge
  | CollabBroker
  | AppModeService
  | AiProvider
  | PendingReset
  | SessionLifecycleProbe;

export const makeBootLayer = (
  appConfigLayer: Layer.Layer<AppConfig>
): Layer.Layer<BootServices, BootError | WindowError> => {
  const logging = MainLoggerLive;
  const electronApp = ElectronAppLive.pipe(Layer.provide(logging));
  const operationalDb = OperationalDbLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(logging)
  );
  const secureStore = SecureStoreLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(electronApp),
    Layer.provide(operationalDb),
    Layer.provide(logging)
  );
  // The app's operating mode is resolved once from the operational `app:mode`
  // row (default 'cloud'; nothing writes it until the
  // first-run chooser) and immutable for the process. The workspace lifecycle
  // keys (mode, identity) reconciliation on it; env:get forwards it to the
  // renderer's telemetry gate.
  const appMode = AppModeLive.pipe(Layer.provide(operationalDb), Layer.provide(logging));
  // The boot-time purge applies a pending destructive reset before any
  // product store / model / recovery handle exists (ModelManager depends on it
  // explicitly; the workspace lifecycle only starts once the boot layer is up).
  const pendingReset = PendingResetLive.pipe(Layer.provide(operationalDb), Layer.provide(logging));
  // Device-local preferences are global (not session-scoped), backed by
  // the operational KV table under the `pref:` prefix. Defined before the window
  // registry so the dock can seed its per-display anchor from `dockAnchors`
  // (legacy `widgetNormalizedY` fallback) at open, and before
  // DesktopI18n because the persisted preference wins over the system locale.
  const settings = SettingsServiceLive.pipe(Layer.provide(operationalDb), Layer.provide(logging));
  const i18n = DesktopI18nLive.pipe(Layer.provide(electronApp), Layer.provide(settings));
  const windowRegistry = WindowRegistryLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(electronApp),
    Layer.provide(settings),
    Layer.provide(logging)
  );
  const deepLinks = DeepLinksLive.pipe(Layer.provide(electronApp), Layer.provide(logging));
  const auth = AuthServiceLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(secureStore),
    Layer.provide(operationalDb),
    Layer.provide(electronApp),
    Layer.provide(windowRegistry),
    Layer.provide(logging)
  );
  // The floating-note coordinator owns the float slot; the
  // main-window float:* verbs + the widget's expandNote reach it. AuthService
  // feeds the signed-out open guard — cloud only: local mode is
  // accountless and renders the float unconditionally, so the
  // guard reads the boot-resolved mode.
  const floatBridge = FloatBridgeLive.pipe(
    Layer.provide(windowRegistry),
    Layer.provide(RecordingBridgeLive),
    Layer.provide(auth),
    Layer.provide(appMode),
    Layer.provide(logging)
  );
  // Product analytics: the main posthog-node client for
  // MAIN-ORIGIN events (launch, updater, native crashes, exceptions). Mirrors
  // AuthService identity so its events share the renderer's person; disabled
  // (no key / E2E) ⇒ an inert no-op. The renderer captures product events +
  // session replay through its own posthog-js — main never double-counts.
  const telemetry = makeTelemetryServiceLive(makePostHogNodeSink).pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(operationalDb),
    Layer.provide(auth),
    Layer.provide(appMode),
    Layer.provide(logging)
  );
  const tray = TrayServiceLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(i18n),
    Layer.provide(electronApp),
    Layer.provide(logging)
  );
  const updater = UpdaterServiceLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(settings),
    Layer.provide(logging)
  );
  // The local whisper model manager is boot-scoped because the
  // weights are device state shared by both modes and a multi-GB download must
  // survive a workspace rebuild. Rows live in operational.db (`local_model`);
  // reconcile is forked (never blocks boot) and nothing mkdirs at build.
  const models = ModelManagerLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(operationalDb),
    Layer.provide(pendingReset),
    Layer.provide(logging)
  );
  // The language-model provider is boot-scoped
  // device state shared by both modes — the provider setting + per-provider
  // keys are read on every resolve, and the tool-support memo must outlive a
  // workspace rebuild. Nothing is fetched at build.
  const aiProvider = AiProviderLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(settings),
    Layer.provide(secureStore),
    Layer.provide(logging)
  );
  // The whisper.cpp worker host is boot-scoped so a loaded
  // model survives a workspace rebuild and both modes share the one worker.
  // Nothing is forked at build — the sidecar starts on the first local chunk.
  const whisperEngine = WhisperEngineLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(logging)
  );
  // ONE WorkspaceTransport reference (the boot-scoped workspace-current backend
  // accessor): shared here with the StreamBroker Ask lane and merged as a
  // top-level service for the unary IPC handler, so both read the SAME registered
  // backend (Effect memoizes the layer by reference — a second instance would
  // never see the workspace's self-published backend).
  const coreTransport = WorkspaceTransportLive;
  const streamBroker = StreamBrokerLive.pipe(Layer.provide(logging), Layer.provide(coreTransport));
  // One CollabBridge reference (the boot-scoped note-body-store accessor):
  // shared here with the CollabBroker AND merged as a top-level service so the
  // workspace-scoped NoteBodyStore registers into the SAME instance the broker
  // reads (Effect memoizes the layer by reference, like coreTransport above).
  const collabBridge = CollabBridgeLive;
  const collabBroker = CollabBrokerLive.pipe(Layer.provide(logging), Layer.provide(collabBridge));
  const shutdown = ShutdownCoordinatorLive.pipe(
    Layer.provide(appConfigLayer),
    Layer.provide(electronApp),
    Layer.provide(logging)
  );

  return Layer.mergeAll(
    appConfigLayer,
    logging,
    electronApp,
    operationalDb,
    secureStore,
    windowRegistry,
    floatBridge,
    deepLinks,
    auth,
    tray,
    updater,
    models,
    whisperEngine,
    aiProvider,
    streamBroker,
    shutdown,
    // Device-local preferences: a SubscriptionRef over the KV table read
    // by the settings IPC surface and the widget-visibility policy.
    settings,
    i18n,
    // Product analytics: main-origin events + auth-mirrored identity.
    telemetry,
    // Leaves: the Electron edges that the capability IPC handlers and the OS-sync
    // consumer reach. SystemPermissions is also mounted in-session
    // for the recording permission gate; both instances are stateless so a second
    // boot-scoped one is harmless. NativeOs wraps login-item/dock/shell/relaunch.
    SystemPermissionsLive,
    NativeOsLive,
    // Leaf: the boot-scoped workspace-current backend accessor. The
    // workspace-scoped WorkspaceBackend self-publishes here on acquire; the unary
    // IPC handler and the StreamBroker Ask lane reach the live workspace
    // through this SAME reference.
    coreTransport,
    // The note-body log lane: the boot-scoped store accessor + the
    // MessagePort relay broker the collab:open handler dispatches into.
    collabBridge,
    collabBroker,
    // Leaf: the boot-scoped record-button bridge. The workspace-scoped
    // RecordingService self-publishes here; the recording:* IPC handlers + state
    // push fiber reach the live workspace through it.
    RecordingBridgeLive,
    // Leaf: the boot-scoped meeting-detection bridge. The workspace-scoped
    // DetectionService self-publishes here; the widget:dismiss handler + widget
    // state push fiber reach the live workspace through it.
    DetectionBridgeLive,
    EventKitBridgeLive,
    // The boot-resolved operating mode — read by the workspace
    // lifecycle and the env:get descriptor.
    appMode,
    // The boot-time purge report (ModelManager already forced its ordering).
    pendingReset,
    // Leaf: workspace lifecycle counters (written by the lifecycle loop,
    // read by the e2e:sessionProbe channel).
    SessionLifecycleProbeLive
  );
};

export const BootLayer = makeBootLayer(AppConfigLive);
