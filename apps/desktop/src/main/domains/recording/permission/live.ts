/**
 * PermissionServiceLive. Stateless — every call queries the
 * OS fresh (mic status can change while the app runs when the user edits System
 * Settings, so a cache would go stale; the queries are cheap syncs). Reads the
 * electron edge through the injectable SystemPermissions port so the whole
 * service is headless-testable with a fake port + a fake platform/version.
 */
import { Effect, Layer } from 'effect';
import type { MeetingCaptureMode } from '@/types/meeting';
import { AppConfig } from '../../../infra/config/service';
import { MainLogger } from '../../../infra/logging/service';
import {
  SystemPermissions,
  type MediaAccessStatus,
} from '../../../infra/system-permissions/service';
import { SYSTEM_AUDIO_MIN_MAJOR, SYSTEM_AUDIO_MIN_MINOR, meetsMinimumVersion } from './policy';
import {
  PermissionError,
  PermissionService,
  type PermissionServiceApi,
  type ResolvedCaptureMode,
} from './service';

const needsSystemAudio = (mode: MeetingCaptureMode): boolean =>
  mode === 'system' || mode === 'dual';

const needsMicrophone = (mode: MeetingCaptureMode): boolean => mode === 'mic' || mode === 'dual';

export const PermissionServiceLive: Layer.Layer<
  PermissionService,
  never,
  SystemPermissions | AppConfig | MainLogger
> = Layer.effect(
  PermissionService,
  Effect.gen(function* () {
    const sys = yield* SystemPermissions;
    const config = yield* AppConfig;
    const log = (yield* MainLogger).scoped('permission');

    const micStatus: Effect.Effect<MediaAccessStatus> = sys.microphoneStatus;

    const requestMic: Effect.Effect<MediaAccessStatus> = sys.microphoneStatus.pipe(
      Effect.flatMap(status =>
        status === 'not-determined'
          ? sys.requestMicrophoneAccess.pipe(
              Effect.map((granted): MediaAccessStatus => (granted ? 'granted' : 'denied'))
            )
          : Effect.succeed(status)
      )
    );

    // macOS system audio requires the CoreAudio process tap and macOS ≥ 14.2
    // Windows uses WASAPI loopback without a separate permission gate;
    // unsupported platforms degrade system/dual to mic-only.
    const systemAudioAvailable: Effect.Effect<boolean> =
      config.platform === 'win32'
        ? Effect.succeed(true)
        : config.platform === 'darwin'
          ? sys.systemVersion.pipe(
              Effect.map(version =>
                meetsMinimumVersion(version, SYSTEM_AUDIO_MIN_MAJOR, SYSTEM_AUDIO_MIN_MINOR)
              )
            )
          : Effect.succeed(false);

    const effectiveCaptureMode = (
      requested: MeetingCaptureMode
    ): Effect.Effect<ResolvedCaptureMode, PermissionError> =>
      Effect.gen(function* () {
        const sysAvail = yield* systemAudioAvailable;
        const degraded = needsSystemAudio(requested) && !sysAvail;
        const mode: MeetingCaptureMode = degraded ? 'mic' : requested;
        if (degraded) {
          yield* log.info('system audio unavailable — degrading to mic-only', {
            context: { requested, platform: config.platform },
          });
        }

        if (needsMicrophone(mode)) {
          const status = yield* requestMic;
          if (status !== 'granted') {
            yield* log.warn('microphone permission not granted — recording blocked', {
              context: { requested, mode, status },
            });
            return yield* Effect.fail(
              new PermissionError({
                requested,
                effective: mode,
                reason: 'mic-denied',
                micStatus: status,
              })
            );
          }
        }

        return { requested, mode, systemAudioAvailable: sysAvail, degraded };
      });

    const api: PermissionServiceApi = {
      micStatus,
      requestMic,
      systemAudioAvailable,
      effectiveCaptureMode,
    };
    return api;
  })
);
