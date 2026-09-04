import { Context, Data, type Effect } from 'effect';
import type { MeetingCaptureMode } from '@/types/meeting';
import type { MediaAccessStatus } from '../../../infra/system-permissions/service';

/**
 * The PermissionService is the pre-flight gate the RecordingService consults
 * before it spawns the native capture child.
 * It resolves two things the OS decides:
 *
 *  - **Mic (TCC):** `getMediaAccessStatus('microphone')` and, when
 *    `not-determined`, `askForMediaAccess('microphone')` (the OS prompt).
 *  - **System audio:** macOS availability is version-gated to the CoreAudio
 *    process tap on ≥14.2; Windows uses WASAPI loopback. Unsupported
 *    hosts and older macOS degrade `system`/`dual` to mic-only.
 *
 * `effectiveCaptureMode` folds both into a mode the native binary can actually
 * satisfy: it degrades `system`/`dual` → `mic` when system audio is
 * unavailable, ensures the microphone whenever the resolved mode needs it, and
 * fails `PermissionError` (no spawn) when the mic is denied.
 */

export type { MediaAccessStatus };

/**
 * The resolved mode a recording should actually capture with. `mode` may be a
 * degraded form of `requested` (dual/system → mic when system audio is
 * unavailable); `degraded` flags exactly that so the UI can surface "mic only".
 */
export interface ResolvedCaptureMode {
  readonly requested: MeetingCaptureMode;
  readonly mode: MeetingCaptureMode;
  readonly systemAudioAvailable: boolean;
  /** requested needed system audio but resolved to mic-only. */
  readonly degraded: boolean;
}

/**
 * The microphone is required for the resolved mode but not granted — recording
 * must NOT spawn. `effective` is the mode that would have run (post-degrade);
 * `micStatus` is the denying status (denied / restricted / not-determined after
 * a declined prompt).
 */
export class PermissionError extends Data.TaggedError('PermissionError')<{
  readonly requested: MeetingCaptureMode;
  readonly effective: MeetingCaptureMode;
  readonly reason: 'mic-denied';
  readonly micStatus: MediaAccessStatus;
}> {}

export interface PermissionServiceApi {
  /** Current mic TCC status (never prompts). */
  readonly micStatus: Effect.Effect<MediaAccessStatus>;
  /**
   * Ensure the mic: prompts (OS TCC) when `not-determined`, otherwise returns
   * the current status unchanged. The resolved status after any prompt.
   */
  readonly requestMic: Effect.Effect<MediaAccessStatus>;
  /** Whether native system capture is usable here (macOS ≥14.2 or Windows). */
  readonly systemAudioAvailable: Effect.Effect<boolean>;
  /**
   * Resolve `requested` into a capturable mode: degrade system/dual → mic when
   * system audio is unavailable, ensure (prompt) the mic when the resolved mode
   * needs it, and fail `PermissionError` when the mic is required but denied.
   */
  readonly effectiveCaptureMode: (
    requested: MeetingCaptureMode
  ) => Effect.Effect<ResolvedCaptureMode, PermissionError>;
}

export class PermissionService extends Context.Tag('desktop/recording/PermissionService')<
  PermissionService,
  PermissionServiceApi
>() {}
