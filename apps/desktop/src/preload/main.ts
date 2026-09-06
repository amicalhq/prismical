/**
 * Main-window preload — the typed capability bridge.
 *
 * Exposes EXACTLY the @prismical/desktop-contracts main-window surface: no
 * generic on()/off(), no channel passthrough, no any-typed escape hatch. The
 * e2e contract-enumeration spec asserts Object.keys(window.desktop) equals
 * this file's surface and nothing else.
 *
 * MessagePort note: ports cannot cross contextBridge, so openStream forwards
 * the received port into the main world via window.postMessage (the
 * Electron-documented pattern); the renderer's stream helper picks it up by
 * streamId (STREAM_PORT_WINDOW_MESSAGE marker).
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNELS,
  COLLAB_PORT_WINDOW_MESSAGE,
  STREAM_PORT_WINDOW_MESSAGE,
  type CollabOpenResponse,
  type DeviceSettings,
  type DeviceSettingsPatch,
  type ThemeSource,
  type MainWindowDesktopApi,
  type FloatStateView,
  type ModelRequest,
  type ModelsStateView,
  type NavPush,
  type OpenStreamResponse,
  type OpenWebSessionRequest,
  type PermissionRequest,
  type RecordingStateView,
  type RecordingControlRequest,
  type SessionView,
  type SignOutRequest,
  type StartRecordingRequest,
  type StopRecordingRequest,
  type SwitchAccountRequest,
  type SwitchOrgRequest,
  type AiModelListRequest,
  type AiProviderKeyRequest,
  type AiProviderRequest,
  type ChooseAppModeRequest,
  type ResetAppRequest,
  type TranscriptionByokKeyRequest,
  type TransportRequest,
  type UpdateStateView,
} from '@prismical/desktop-contracts';
import { makeE2ESurface } from './e2e-surface';
import { makeNavBuffer } from './nav-buffer';
import { makeOpenCollab } from './open-collab';
import { makeOpenStream } from './open-stream';
import { makeRecordingBuffer } from './recording-buffer';
import { makeSessionBuffer } from './session-buffer';
import { makeSettingsBuffer } from './settings-buffer';
import { makeUpdaterBuffer } from './updater-buffer';
import { makeReplayBuffer } from './widget-buffer';

// Attach the nav-push source at preload EVAL time (not lazily on first onPush)
// so cold-start deep-link navigation dispatched before the SPA subscribes is
// buffered and replayed, not dropped.
const navBuffer = makeNavBuffer({
  on: listener =>
    ipcRenderer.on(CHANNELS.navPush, (_event: Electron.IpcRendererEvent, payload: NavPush) =>
      listener(payload)
    ),
});

// Same eval-time attachment for auth:sessionChanged: a push that fires before
// the renderer subscribes (fast sign-in completion, restore-refresh resolving
// during load) is buffered and replayed, not dropped.
const sessionBuffer = makeSessionBuffer({
  on: listener =>
    ipcRenderer.on(
      CHANNELS.authSessionChanged,
      (_event: Electron.IpcRendererEvent, view: SessionView) => listener(view)
    ),
});

// Same eval-time attachment for recording:stateChanged: a state push that
// fires before useRecording subscribes (a recording already running when the note
// view mounts) is buffered and replayed, not dropped.
const recordingBuffer = makeRecordingBuffer({
  on: listener =>
    ipcRenderer.on(
      CHANNELS.recordingStateChanged,
      (_event: Electron.IpcRendererEvent, state: RecordingStateView) => listener(state)
    ),
});

// Same eval-time attachment for settings:changed: the initial replay
// push (SubscriptionRef.changes fires on handler registration) lands before any
// settings screen subscribes, so it is buffered and replayed, not dropped.
const settingsBuffer = makeSettingsBuffer({
  on: listener =>
    ipcRenderer.on(
      CHANNELS.settingsChanged,
      (_event: Electron.IpcRendererEvent, settings: DeviceSettings) => listener(settings)
    ),
});

// Same eval-time attachment for updater:stateChanged: the initial replay
// push (SubscriptionRef.changes fires on handler registration) lands before any
// settings screen subscribes, so it is buffered and replayed, not dropped.
const updaterBuffer = makeUpdaterBuffer({
  on: listener =>
    ipcRenderer.on(
      CHANNELS.updaterStateChanged,
      (_event: Electron.IpcRendererEvent, state: UpdateStateView) => listener(state)
    ),
});

// Same eval-time attachment for float:state: the slot-state
// replay (SubscriptionRef.changes fires on handler registration) lands before
// the pop-out button subscribes, so it is buffered and replayed, not dropped.
const floatBuffer = makeReplayBuffer<FloatStateView>({
  on: listener =>
    ipcRenderer.on(
      CHANNELS.floatStateChanged,
      (_event: Electron.IpcRendererEvent, state: FloatStateView) => listener(state)
    ),
});

// Same eval-time attachment for models:stateChanged: the
// initial replay push (SubscriptionRef.changes fires on handler registration)
// lands before the local-models screen subscribes, so it is buffered and
// replayed, not dropped — and a download's progress keeps flowing while no
// screen is mounted.
const modelsBuffer = makeReplayBuffer<ModelsStateView>({
  on: listener =>
    ipcRenderer.on(
      CHANNELS.modelsStateChanged,
      (_event: Electron.IpcRendererEvent, state: ModelsStateView) => listener(state)
    ),
});

const openStream = makeOpenStream(
  {
    // Pass the SAME listener reference to once + removeListener: an
    // IpcRendererEvent is structurally a StreamPortEvent (it carries `.ports`),
    // and Node's EventEmitter matches a once-wrapped listener by its original
    // reference, so removeListener actually detaches it.
    once: (channel, portListener) =>
      ipcRenderer.once(channel, portListener as (event: Electron.IpcRendererEvent) => void),
    removeListener: (channel, portListener) =>
      ipcRenderer.removeListener(
        channel,
        portListener as (event: Electron.IpcRendererEvent) => void
      ),
    invoke: (channel, payload) =>
      ipcRenderer.invoke(channel, payload) as Promise<OpenStreamResponse>,
  },
  {
    randomUUID: () => crypto.randomUUID(),
    forwardPort: (streamId, ports) =>
      window.postMessage(
        { type: STREAM_PORT_WINDOW_MESSAGE, streamId },
        '*',
        ports as MessagePort[]
      ),
  }
);

// Same discipline for the collab log lane: the same listener reference
// goes to once + removeListener so a stranded per-open listener detaches, and
// the received port is forwarded into the main world with the collab marker.
const openCollab = makeOpenCollab(
  {
    once: (channel, portListener) =>
      ipcRenderer.once(channel, portListener as (event: Electron.IpcRendererEvent) => void),
    removeListener: (channel, portListener) =>
      ipcRenderer.removeListener(
        channel,
        portListener as (event: Electron.IpcRendererEvent) => void
      ),
    invoke: (channel, payload) =>
      ipcRenderer.invoke(channel, payload) as Promise<CollabOpenResponse>,
  },
  {
    randomUUID: () => crypto.randomUUID(),
    forwardPort: (openId, ports) =>
      window.postMessage({ type: COLLAB_PORT_WINDOW_MESSAGE, openId }, '*', ports as MessagePort[]),
  }
);

const api: MainWindowDesktopApi = {
  platform: process.platform,

  env: {
    get: () => ipcRenderer.invoke(CHANNELS.envGet),
  },

  transport: {
    request: (request: TransportRequest) => ipcRenderer.invoke(CHANNELS.transportRequest, request),
    openStream,
  },

  // The note-body log lane: one MessagePort per open, forwarded into
  // the main world by openCollab's port marker (like openStream's).
  collab: {
    open: openCollab,
  },

  nav: {
    onPush: navBuffer.onPush,
  },

  auth: {
    getSession: () => ipcRenderer.invoke(CHANNELS.authGetSession),
    signIn: () => ipcRenderer.invoke(CHANNELS.authSignIn),
    openWebSession: (request: OpenWebSessionRequest) =>
      ipcRenderer.invoke(CHANNELS.authOpenWebSession, request),
    // Always an object on the wire — the handler-side schema is strict.
    signOut: (request?: SignOutRequest) => ipcRenderer.invoke(CHANNELS.authSignOut, request ?? {}),
    // Fire-and-forget switches: main validates the id and re-broadcasts
    // the session; the renderer reacts to auth:sessionChanged, not the result.
    switchOrg: (request: SwitchOrgRequest) => ipcRenderer.invoke(CHANNELS.authSwitchOrg, request),
    switchAccount: (request: SwitchAccountRequest) =>
      ipcRenderer.invoke(CHANNELS.authSwitchAccount, request),
    // The collab WSS bearer is the one sanctioned full-token crossing:
    // fetched per (re)connect by use-note-collab's token callback, never persisted.
    getCollabToken: () => ipcRenderer.invoke(CHANNELS.authGetCollabToken),
    onSessionChanged: sessionBuffer.onSessionChanged,
  },

  // Native record button + live transcript: start/stop invoke main's
  // RecordingService; onStateChanged replays main's pushed RecordingState (the
  // renderer never uploads WAV chunks — main owns the capture/transcribe lane).
  recording: {
    start: (request: StartRecordingRequest) => ipcRenderer.invoke(CHANNELS.recordingStart, request),
    stop: (request: StopRecordingRequest) => ipcRenderer.invoke(CHANNELS.recordingStop, request),
    claimCompletion: (request: RecordingControlRequest) => ipcRenderer.invoke(CHANNELS.recordingClaimCompletion, request),
    pause: (request: RecordingControlRequest) =>
      ipcRenderer.invoke(CHANNELS.recordingPause, request),
    resume: (request: RecordingControlRequest) =>
      ipcRenderer.invoke(CHANNELS.recordingResume, request),
    onStateChanged: recordingBuffer.onStateChanged,
  },

  // Device-local preferences: get/set invoke main; onChanged replays
  // main's pushed DeviceSettings (the latest snapshot to a late subscriber).
  settings: {
    get: () => ipcRenderer.invoke(CHANNELS.settingsGet),
    set: (patch: DeviceSettingsPatch) => ipcRenderer.invoke(CHANNELS.settingsSet, patch),
    onChanged: settingsBuffer.onChanged,
  },

  // Local whisper model manager: getState pulls the snapshot
  // (a renderer reload recreates this buffer empty, so the screen seeds from the
  // pull); download/cancel/delete invoke main; onStateChanged replays the latest
  // snapshot to a late subscriber.
  models: {
    getState: () => ipcRenderer.invoke(CHANNELS.modelsGetState),
    download: (request: ModelRequest) => ipcRenderer.invoke(CHANNELS.modelsDownload, request),
    cancelDownload: (request: ModelRequest) =>
      ipcRenderer.invoke(CHANNELS.modelsCancelDownload, request),
    delete: (request: ModelRequest) => ipcRenderer.invoke(CHANNELS.modelsDelete, request),
    onStateChanged: modelsBuffer.onState,
  },

  // The floating note: open/collapse/dock-back are
  // fire-and-forget verbs (the float:state push is the feedback); onState
  // replays the latest slot state to a late subscriber.
  float: {
    open: (noteId: string | null) => void ipcRenderer.invoke(CHANNELS.floatOpen, { noteId }),
    collapse: () => void ipcRenderer.invoke(CHANNELS.floatCollapse),
    dockBack: () => void ipcRenderer.invoke(CHANNELS.floatDockBack),
    onState: floatBuffer.onState,
  },

  // Mirrors the in-app theme onto nativeTheme.themeSource so native chrome (the
  // macOS vibrancy material, the Windows titleBarOverlay) matches the app rather
  // than the OS. The renderer keeps ownership of the preference.
  theme: {
    setSource: (source: ThemeSource) => ipcRenderer.invoke(CHANNELS.themeSetSource, source),
  },

  // Native action surface: update check, logs export, app reset, and
  // the permission read/prompt/deep-link. resetApp relaunches main, so its invoke
  // never resolves — the adapter treats it as fire-and-forget.
  capabilities: {
    checkForUpdates: () => ipcRenderer.invoke(CHANNELS.capabilityCheckUpdates),
    getUpdateState: () => ipcRenderer.invoke(CHANNELS.updaterGetState),
    onUpdateState: updaterBuffer.onChanged,
    restartToUpdate: () => ipcRenderer.invoke(CHANNELS.updaterQuitInstall),
    dismissUpdatePrompt: () => ipcRenderer.invoke(CHANNELS.updaterDismissPrompt),
    exportLogs: () => ipcRenderer.invoke(CHANNELS.capabilityExportLogs),
    restartApp: () => ipcRenderer.invoke(CHANNELS.capabilityRestartApp),
    // The device reset; `{ mode }` makes it the mode switch.
    resetApp: (request?: ResetAppRequest) =>
      ipcRenderer.invoke(CHANNELS.capabilityResetApp, request ?? {}),
    // The app mode: boot mode + chosen flag, and the first-run choice.
    getAppModeState: () => ipcRenderer.invoke(CHANNELS.capabilityGetAppModeState),
    chooseAppMode: (request: ChooseAppModeRequest) =>
      ipcRenderer.invoke(CHANNELS.capabilityChooseAppMode, request),
    getPermissionStatus: () => ipcRenderer.invoke(CHANNELS.capabilityGetPermissions),
    requestPermission: (request: PermissionRequest) =>
      ipcRenderer.invoke(CHANNELS.capabilityRequestPermission, request),
    openSystemSettings: (request: PermissionRequest) =>
      ipcRenderer.invoke(CHANNELS.capabilityOpenSystemSettings, request),
    getAppleCalendarStatus: () => ipcRenderer.invoke(CHANNELS.capabilityGetAppleCalendarStatus),
    enableAppleCalendar: () => ipcRenderer.invoke(CHANNELS.capabilityEnableAppleCalendar),
    refreshAppleCalendar: () => ipcRenderer.invoke(CHANNELS.capabilityRefreshAppleCalendar),
    // The BYOK transcription key: set crosses the key once
    // (renderer → main's secure store); has answers a boolean, never the key.
    setTranscriptionByokKey: (request: TranscriptionByokKeyRequest) =>
      ipcRenderer.invoke(CHANNELS.capabilitySetTranscriptionByokKey, request),
    clearTranscriptionByokKey: () =>
      ipcRenderer.invoke(CHANNELS.capabilityClearTranscriptionByokKey),
    hasTranscriptionByokKey: () => ipcRenderer.invoke(CHANNELS.capabilityHasTranscriptionByokKey),
    // The AI provider keys: same custody as the BYOK key, one
    // slot per provider; listAiModels is the provider's live catalogue.
    setAiProviderKey: (request: AiProviderKeyRequest) =>
      ipcRenderer.invoke(CHANNELS.capabilitySetAiProviderKey, request),
    clearAiProviderKey: (request: AiProviderRequest) =>
      ipcRenderer.invoke(CHANNELS.capabilityClearAiProviderKey, request),
    hasAiProviderKey: (request: AiProviderRequest) =>
      ipcRenderer.invoke(CHANNELS.capabilityHasAiProviderKey, request),
    listAiModels: (request: AiModelListRequest) =>
      ipcRenderer.invoke(CHANNELS.capabilityListAiModels, request),
  },

  // Test-only surface, gated on the --prismical-e2e argv switch (sandboxed
  // preloads don't see process.env; WindowRegistry forwards config.isE2E via
  // webPreferences.additionalArguments). Absent entirely outside E2E — the
  // gate itself is unit-tested (tests/preload/e2e-surface.test.ts).
  ...makeE2ESurface(process.argv, (channel, payload) => ipcRenderer.invoke(channel, payload)),
};

contextBridge.exposeInMainWorld('desktop', api);
