// DesktopCapabilityPort — optional native capabilities exposed to shared renderers.
//
// The settings surfaces ship desktop-shaped controls (launch-at-login, meeting
// widget, mic devices, shortcuts, updates, logs/reset) that are DEAD on web —
// and stay exactly as inert there (web adapter answers false for everything).
// Capability presence is queried per named capability, never via a raw
// isDesktop/isElectron boolean — the anti-drift rule bans environment-check
// layout branches in shared code. Real per-capability handler
// surfaces (toggle launch-at-login, enumerate devices, capture shortcuts, …)
// are additive extensions that land with the desktop implementations.

export type DesktopCapability =
  | 'launch-at-login'
  | 'meeting-widget'
  | 'mic-devices'
  | 'global-shortcuts'
  | 'app-updates'
  | 'log-export'
  | 'app-reset'
  | 'apple-calendar'
  // Frameless-window chrome: per-OS, not a raw
  // isDesktop — mac keys the sidebar's traffic-light drag spacer, windows keys
  // the titleBarOverlay clearances in the shared header. Web answers false.
  | 'window-chrome-mac'
  | 'window-chrome-windows'
  // The floating note: gates the note header's pop-out button.
  | 'floating-note'
  // Local whisper model manager: gates the Local models
  // settings entry + screen. Web answers false; the screen is desktop-owned.
  | 'local-models'
  // Transcription engine choice: gates the engine card the
  // desktop router slots into the shared TranscriptionScreen.
  | 'transcription-engine'
  // AI provider choice + key custody: gates the provider card
  // the desktop router slots into the shared AI models screen.
  | 'ai-provider'
  // The app-mode switch card: desktop answers true in BOTH
  // modes (the card shows the current mode and offers the other one); web has
  // no modes and answers false. The card itself is desktop-owned.
  | 'app-mode';

// ---------------------------------------------------------------------------
// Device settings — the first per-capability handler
// surface (the file header's "additive extensions"). Device-local, global (not
// account-scoped) preferences the native settings screens read/write. This is
// the canonical renderer-facing shape (plain TS — app-contracts stays
// dependency-light); the desktop main/preload side mirrors it field-for-field
// as a zod schema in @prismical/desktop-contracts (same pattern as the
// TransportPort envelope), and the web adapter answers it inertly (defaults +
// no-op set + a never-emitting subscribe).
// ---------------------------------------------------------------------------

/** When the floating meeting widget is shown. */
export type WidgetVisibility = 'always' | 'while-recording' | 'never';

/** Auto-update track, wired to the updater by the desktop adapter. */
export type UpdateChannel = 'stable' | 'beta';

/** A complete Prismical interface locale exposed by the launch catalog. */
export type InterfaceLanguage = 'en' | 'de' | 'es' | 'ja' | 'zh-TW';

/** Desktop persistence uses the empty string as the explicit "follow the OS" value. */
export type InterfaceLanguagePreference = '' | InterfaceLanguage;

/**
 * Which engine transcribes desktop recordings —
 * orthogonal to the app mode: cloud mode may run local whisper.
 */
export type TranscriptionEngine = 'cloud' | 'local' | 'byok';

/**
 * The transcription-engine preference. ONE record so the
 * knobs move together. `modelId` is a local-model catalogue id (null = the
 * recommended default); `byokBaseUrl`/`byokModel` describe an OpenAI-compatible
 * endpoint. The BYOK API key NEVER rides device settings (it crosses to the
 * renderer on every push) — it lives in main's secure store.
 */
export interface TranscriptionSetting {
  readonly engine: TranscriptionEngine;
  readonly modelId: string | null;
  readonly byokBaseUrl: string | null;
  readonly byokModel: string | null;
}

/**
 * The language-model provider the local Ask/Skills lanes run on: a BYO key
 * (OpenAI, Anthropic, any OpenAI-compatible
 * endpoint) or a local Ollama runtime.
 */
export type AiProviderKind = 'openai' | 'anthropic' | 'openai-compatible' | 'ollama';

/**
 * The AI-provider preference. ONE record so the knobs move
 * together. `model` is the provider's model id (null = the provider default);
 * `baseUrl` is the endpoint for openai-compatible / ollama (null = the
 * provider default). API keys NEVER ride device settings — they live in main's
 * secure store, one slot per provider kind.
 */
export interface AiProviderSetting {
  readonly provider: AiProviderKind;
  readonly model: string | null;
  readonly baseUrl: string | null;
}

/** A provider's live model catalogue, or why it could not be fetched (`models` stays empty). */
export interface AiModelListing {
  readonly models: ReadonlyArray<string>;
  readonly error: 'not-configured' | 'unauthorized' | 'network' | 'unsupported' | null;
}

// ---------------------------------------------------------------------------
// Local models — the renderer-facing mirror of the desktop
// model manager's snapshot (@prismical/desktop-contracts modelsStateViewSchema,
// kept field-for-field like DeviceSettings). Plain TS: app-contracts stays
// dependency-light. The web adapter serves INERT_LOCAL_MODELS_STATE.
// ---------------------------------------------------------------------------

/** What a catalogue entry is for: whisper decoder weights, or VAD weights. */
export type LocalModelKind = 'whisper' | 'vad';

export type LocalModelDownloadStatus = 'downloading' | 'verifying' | 'cancelling' | 'error';

/** Why a download ended in `error` — a closed set the screen maps to copy. */
export type LocalModelDownloadError = 'network' | 'checksum-mismatch' | 'insufficient-space' | 'io';

/** Progress for one model — bytes only; the renderer derives the percentage. */
export interface LocalModelDownload {
  readonly status: LocalModelDownloadStatus;
  readonly bytesDownloaded: number;
  readonly totalBytes: number;
  readonly error: LocalModelDownloadError | null;
}

/** One catalogue row: static fields, the installed flag/time, the active download. */
export interface LocalModel {
  readonly id: string;
  readonly name: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly kind: LocalModelKind;
  readonly recommended: boolean;
  readonly installed: boolean;
  readonly installedAt: string | null;
  readonly download: LocalModelDownload | null;
}

export interface LocalModelsState {
  readonly models: ReadonlyArray<LocalModel>;
  /** Where the weights live on this device (identity-free; shown in the screen). */
  readonly modelsDir: string;
}

/** The inert snapshot used by platforms without a model manager (currently web). */
export const INERT_LOCAL_MODELS_STATE: LocalModelsState = { models: [], modelsDir: '' };

// ---------------------------------------------------------------------------
// Native action surface — the settings screens' native
// buttons: update check, logs export, app reset, and the mic/system-audio
// permission surface. Each maps to a `capability:*` IPC channel on desktop; the
// web adapter answers every one inertly (the controls are capability-gated off).
// ---------------------------------------------------------------------------

/** A native OS permission the desktop app can read or prompt for. */
export type PermissionKind = 'microphone' | 'system-audio';

/**
 * A native permission's status. Microphone maps Electron's TCC statuses
 * verbatim. System-audio has no separate TCC readout on this app — its
 * availability is reported as `granted` when usable (macOS ≥14.2, with the real
 * CoreAudio tap grant confirmed at capture time, or Windows WASAPI loopback)
 * and `unavailable` on unsupported hosts / older macOS.
 */
export type PermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'restricted'
  | 'unavailable'
  | 'unknown';

/** The full permission readout the Permissions surface renders. */
export interface PermissionStatuses {
  readonly microphone: PermissionStatus;
  readonly systemAudio: PermissionStatus;
}

export type AppleCalendarPermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'restricted'
  | 'write-only'
  | 'unavailable'
  | 'unknown';

export interface AppleCalendarStatus {
  readonly permission: AppleCalendarPermissionStatus;
  readonly state: 'disabled' | 'ready' | 'syncing' | 'error';
  readonly lastRefreshedAt: string | null;
  readonly error: string | null;
}

/**
 * Update-check outcome. `disabled` is reserved for builds where the native
 * updater is intentionally unavailable (web, development, and E2E).
 */
export type UpdateStatus =
  | 'disabled'
  | 'not-available'
  | 'checking'
  | 'available'
  | 'downloaded'
  | 'error';

export interface UpdateCheckResult {
  readonly status: UpdateStatus;
}

/** The pending update prompt: policy action, prompt/force, and release info. */
export interface UpdatePromptInfo {
  readonly action: 'prompt' | 'force';
  readonly version?: string;
  readonly releaseNotes?: string;
}

/** The live updater view: status, staged install, and pending prompt. */
export interface UpdateStateView {
  readonly status: UpdateStatus;
  readonly staged: boolean;
  readonly stagedVersion: string | null;
  readonly prompt: UpdatePromptInfo | null;
}

/** The inert view used by platforms without a native updater (currently web). */
export const INERT_UPDATE_STATE: UpdateStateView = {
  status: 'disabled',
  staged: false,
  stagedVersion: null,
  prompt: null,
};

// --- Dock settings ----------------------------------------------------------
// The dock (evolved floating widget) drags freely on both axes and persists a
// normalized anchor PER DISPLAY; the floating note persists normalized bounds
// per display. Both records are keyed by the desktop's `String(display.id)` —
// opaque to the renderer (settings screens never enumerate displays; they only
// carry these through patches like any other field).

/** A 2-axis normalized dock anchor within a display's margin bands (0..1 each). */
export interface DockAnchor {
  readonly nx: number;
  readonly ny: number;
}

/** The floating note's normalized bounds (position bands + size fractions). */
export interface FloatNoteNormBounds {
  readonly nx: number;
  readonly ny: number;
  readonly nw: number;
  readonly nh: number;
}

export interface DeviceSettings {
  /** Launch the app on OS login (side effect: openAtLogin). */
  readonly launchAtLogin: boolean;
  /** Show the macOS dock icon (side effect: app.dock show/hide). */
  readonly dockVisible: boolean;
  /** Meeting-widget visibility policy; changes re-project the widget stream. */
  readonly widgetVisibility: WidgetVisibility;
  /**
   * LEGACY: the old right-edge vertical anchor. Kept as the read-side migration seed for a display
   * with no `dockAnchors` entry yet; no new writes land here.
   */
  readonly widgetNormalizedY: number;
  /** Auto-update track. */
  readonly updateChannel: UpdateChannel;
  /** UI language; '' = follow the OS. Only complete launch catalogs are valid. */
  readonly language: InterfaceLanguagePreference;
  /** Per-display dock anchors, keyed by display id. */
  readonly dockAnchors: Readonly<Record<string, DockAnchor>>;
  /** The display the dock last lived on; null = primary. */
  readonly dockDisplayId: string | null;
  /** Per-display floating-note bounds, keyed by display id. */
  readonly floatNoteBounds: Readonly<Record<string, FloatNoteNormBounds>>;
  /** Meeting & call notification cards (decoupled from dock visibility). */
  readonly meetingNotifications: boolean;
  /** Floating-note global hotkey as an Electron accelerator; '' = disabled. */
  readonly dockHotkey: string;
  /** Auto-expand the floating note on ambient recording starts (default off). */
  readonly autoExpandOnRecording: boolean;
  /** Hide the dock windows from screen sharing (setContentProtection). */
  readonly dockContentProtection: boolean;
  /**
   * LOCAL-MODE telemetry opt-out. Ignored in cloud mode (service telemetry under the ToS);
   * honored in local mode. The setting does not yet have a UI.
   */
  readonly telemetryOptOut: boolean;
  /** Transcription engine choice. Main resolves the effective engine. */
  readonly transcription: TranscriptionSetting;
  /** AI provider choice. Main resolves the model per request. */
  readonly ai: AiProviderSetting;
}

/**
 * The seed every reader falls back to: main uses it when a stored key is
 * missing/malformed (a bad row never blocks boot), and the web adapter resolves
 * it verbatim (every desktop setting is the dead control it is on web).
 */
export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  launchAtLogin: false,
  dockVisible: true,
  widgetVisibility: 'always',
  widgetNormalizedY: 0.5,
  updateChannel: 'stable',
  language: '',
  dockAnchors: {},
  dockDisplayId: null,
  floatNoteBounds: {},
  meetingNotifications: true,
  dockHotkey: 'Alt+Shift+N',
  autoExpandOnRecording: false,
  dockContentProtection: false,
  telemetryOptOut: false,
  transcription: { engine: 'cloud', modelId: null, byokBaseUrl: null, byokModel: null },
  ai: { provider: 'openai', model: null, baseUrl: null },
};

export interface DesktopCapabilityPort {
  /** Whether a named desktop capability is available. Web: always false. */
  has(capability: DesktopCapability): boolean;
  /**
   * Platform-resolved feature flags. `null` means flags come
   * from the active organization (GET /me/organizations) — web and desktop's
   * cloud mode. A workspace that has no organization resolves its own: desktop's
   * local mode hands over a static table, and `useFeatureFlag` reads it
   * synchronously instead of querying the org list. Unknown keys read false.
   */
  readonly featureFlags: Readonly<Record<string, boolean>> | null;
  /**
   * Device-settings read/write/observe. Desktop wires it to main over IPC;
   * web answers inertly. `get` resolves the current settings; `set` merges a
   * partial patch (fire-and-forget — the observed truth flows back through
   * `subscribe`, which replays the latest settings to a new listener immediately
   * and returns an unsubscribe).
   */
  readonly settings: {
    get(): Promise<DeviceSettings>;
    set(patch: Partial<DeviceSettings>): Promise<void>;
    subscribe(listener: (settings: DeviceSettings) => void): () => void;
  };
  /**
   * Native action surface. Desktop wires each to a `capability:*` IPC
   * channel; web answers inertly (the controls are gated off `has(...)`, so on
   * web these are never invoked — the inert bodies just satisfy the type).
   */
  /** Trigger an update check. Web and updater-disabled desktop builds resolve `disabled`. */
  checkForUpdates(): Promise<UpdateCheckResult>;
  /** The current live updater view. Web resolves the inert view. */
  getUpdateState(): Promise<UpdateStateView>;
  /**
   * Live updater-view pushes; replays the latest view to a late
   * subscriber. Web: never fires; returns a no-op unsubscribe.
   */
  onUpdateState(listener: (state: UpdateStateView) => void): () => void;
  /** Restart into a staged update. No-op when nothing is staged or on web. */
  restartToUpdate(): Promise<void>;
  /** Dismiss the current update prompt; a forced update is non-dismissable. */
  dismissUpdatePrompt(): Promise<void>;
  /** Reveal the app log file for diagnostics. */
  exportLogs(): Promise<void>;
  /**
   * Pop a note out into the floating note window (gated on
   * `has("floating-note")`). Fire-and-forget — the float window opening IS the
   * feedback. Web: inert no-op (the button never renders).
   */
  openFloatingNote(noteId: string): Promise<void>;
  /** Relaunch without clearing settings or local recovery data. */
  restartApp(): Promise<void>;
  /**
   * Erase the device state, then relaunch. This destructive reset clears on-device
   * notes/recordings, the cloud cache, downloaded models, saved keys,
   * AI/transcription settings, and the telemetry identity. The
   * running mode and the signed-in accounts are kept — the mode SWITCH is a
   * desktop-owned control that talks to main directly.
   */
  resetApp(): Promise<void>;
  /** The current native permission statuses. */
  getPermissionStatus(): Promise<PermissionStatuses>;
  /** Prompt for a permission (mic → the OS TCC prompt); resolves the refreshed statuses. */
  requestPermission(kind: PermissionKind): Promise<PermissionStatuses>;
  /** Open the OS privacy pane for a permission. No-op on unsupported platforms. */
  openSystemSettings(kind: PermissionKind): Promise<void>;
  /** Read the local EventKit bridge state. Event details never cross IPC. */
  getAppleCalendarStatus(): Promise<AppleCalendarStatus>;
  /** Explicit user action: request EventKit access, then discover calendars. */
  enableAppleCalendar(): Promise<AppleCalendarStatus>;
  /** Ask the signed-in native service to publish a fresh bounded snapshot. */
  refreshAppleCalendar(): Promise<AppleCalendarStatus>;
  /**
   * Local whisper model manager, gated on `has('local-models')`.
   * The verbs are fire-and-forget — every outcome (progress, refusal, failure)
   * lands in the next `subscribe` snapshot. `subscribe` delivers the current
   * snapshot to a new listener promptly and returns its unsubscribe. Web: inert.
   */
  readonly localModels: {
    getState(): Promise<LocalModelsState>;
    download(modelId: string): Promise<void>;
    cancelDownload(modelId: string): Promise<void>;
    delete(modelId: string): Promise<void>;
    subscribe(listener: (state: LocalModelsState) => void): () => void;
  };
  /**
   * The BYOK transcription API key (gated on
   * `has('transcription-engine')`). The key lives ONLY in main's secure store —
   * it never rides DeviceSettings and is never read back: `hasKey` answers a
   * boolean. Web: no-ops, `hasKey` → false.
   */
  readonly transcriptionByok: {
    setKey(key: string): Promise<void>;
    clearKey(): Promise<void>;
    hasKey(): Promise<boolean>;
  };
  /**
   * The AI provider API keys and live model catalogue (gated on
   * `has('ai-provider')`). One key slot per provider kind, same custody as
   * `transcriptionByok`: never read back, `hasKey` answers a boolean.
   * `listModels` is best-effort (an unreachable provider yields an empty list
   * with a reason). Web: no-ops, `hasKey` → false, `listModels` → unsupported.
   */
  readonly aiProvider: {
    setKey(provider: AiProviderKind, key: string): Promise<void>;
    clearKey(provider: AiProviderKind): Promise<void>;
    hasKey(provider: AiProviderKind): Promise<boolean>;
    /** `force` re-fetches past main's brief cache (Refresh, a just-saved key). */
    listModels(provider: AiProviderKind, force?: boolean): Promise<AiModelListing>;
  };
}
