import { Context, type Effect } from 'effect';

/**
 * The seam over Electron's `systemPreferences` media-access API + the OS version
 * source. The PermissionService (domains/recording/permission)
 * reads through this port so the electron edge is a single, injectable boundary:
 * the Live layer touches `systemPreferences` / `process.getSystemVersion()`, unit
 * tests provide a fake with a settable mic status + version. No raw promise leaks
 * past here — `askForMediaAccess` (which triggers the OS TCC prompt) is wrapped as
 * an Effect.
 */

/** Electron's `getMediaAccessStatus` return set (verbatim). */
export type MediaAccessStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export interface SystemPermissionsApi {
  /** `systemPreferences.getMediaAccessStatus('microphone')` — never prompts. */
  readonly microphoneStatus: Effect.Effect<MediaAccessStatus>;
  /**
   * `systemPreferences.askForMediaAccess('microphone')` — triggers the OS TCC
   * prompt when the status is `not-determined`; resolves the granted boolean.
   * A no-op prompt (already granted/denied) resolves immediately.
   */
  readonly requestMicrophoneAccess: Effect.Effect<boolean>;
  /**
   * `process.getSystemVersion()` — the real OS product version (e.g. "14.2.1" on
   * macOS, not the Darwin kernel version). The system-audio gate compares
   * this against macOS 14.2.
   */
  readonly systemVersion: Effect.Effect<string>;
}

export class SystemPermissions extends Context.Tag('desktop/SystemPermissions')<
  SystemPermissions,
  SystemPermissionsApi
>() {}
