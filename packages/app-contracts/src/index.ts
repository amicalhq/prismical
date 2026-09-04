// @prismical/app-contracts — framework-free display types + the port
// interfaces shared by the web and desktop renderers.
// Types/interfaces ONLY: zero runtime dependencies, no React/Next/Electron
// (the eslint rails enforce it).

// Build-time canary: proves the source-consumed pipeline (exports map,
// type:check, lint, Next transpilePackages) end to end.
export const APP_CONTRACTS_CANARY = 'app-contracts' as const;

// Shared display types — the type vocabulary the data layer + screens speak.
export * from './display';

// Ports — platform seams shared by the renderers.
export type {
  AppLinkProps,
  AppSearchParams,
  NavigationActions,
  NavigationPort,
  RouteParams,
} from './ports/navigation';
export type { EnvDescriptor, EnvPort } from './ports/env';
export type { AuthPort, SessionAccount, SessionGateState, SessionView } from './ports/auth';
export type { AssetPort } from './ports/asset';
export type { ExternalPort } from './ports/external';
export type {
  DesktopCapability,
  DesktopCapabilityPort,
  AiModelListing,
  AiProviderKind,
  AiProviderSetting,
  AppleCalendarPermissionStatus,
  AppleCalendarStatus,
  DeviceSettings,
  LocalModel,
  LocalModelDownload,
  LocalModelDownloadError,
  LocalModelDownloadStatus,
  LocalModelKind,
  LocalModelsState,
  PermissionKind,
  PermissionStatus,
  PermissionStatuses,
  TranscriptionEngine,
  TranscriptionSetting,
  UpdateChannel,
  UpdateCheckResult,
  UpdatePromptInfo,
  UpdateStateView,
  UpdateStatus,
  WidgetVisibility,
} from './ports/desktop-capability';
export {
  DEFAULT_DEVICE_SETTINGS,
  INERT_LOCAL_MODELS_STATE,
  INERT_UPDATE_STATE,
} from './ports/desktop-capability';
export type { AnalyticsEventProperties, AnalyticsPort } from './ports/analytics';
export type {
  NativeCaptureMode,
  NativeRecordingControl,
  NativeRecordingState,
  NativeRecordingStatus,
  NativeStartResult,
  RecordingPort,
  RecordingTranscriptSegment,
} from './ports/recording';
export type {
  TransportErrorCode,
  TransportMethod,
  TransportPort,
  TransportRequest,
  TransportResponse,
} from './ports/transport';
export type {
  NoteLogConfig,
  NoteLogFlush,
  NoteLogHandle,
  NoteLogHydration,
  NoteLogOpenResult,
} from './ports/note-log';
