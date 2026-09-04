import { systemPreferences } from 'electron';
import { Effect, Layer } from 'effect';
import { SystemPermissions, type MediaAccessStatus, type SystemPermissionsApi } from './service';

/**
 * The real Electron edge. `getMediaAccessStatus` /
 * `askForMediaAccess` are the macOS TCC surface; `process.getSystemVersion()` is
 * the OS product version for the system-audio ≥14.2 gate. Only ever mounted
 * in the running app — every test uses a fake SystemPermissions instead — so the
 * macOS-only APIs are safe here; on Windows Electron reports the microphone
 * privacy state while system capture uses WASAPI loopback without a separate
 * permission prompt. PermissionService applies the platform capability gate.
 */
export const SystemPermissionsLive: Layer.Layer<SystemPermissions> = Layer.succeed(
  SystemPermissions,
  {
    microphoneStatus: Effect.sync(
      () => systemPreferences.getMediaAccessStatus('microphone') as MediaAccessStatus
    ),
    requestMicrophoneAccess: Effect.promise(() =>
      systemPreferences.askForMediaAccess('microphone')
    ),
    systemVersion: Effect.sync(() => process.getSystemVersion()),
  } satisfies SystemPermissionsApi
);
