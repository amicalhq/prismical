/**
 * A fake SystemPermissions edge: a settable mic TCC status and
 * OS version, with a recorded request that simulates the OS prompt granting.
 * Electron-free.
 */
import { Effect, Layer } from 'effect';
import {
  SystemPermissions,
  type MediaAccessStatus,
  type SystemPermissionsApi,
} from '../../src/main/infra/system-permissions/service';

export interface FakeSystemPermissions {
  readonly layer: Layer.Layer<SystemPermissions>;
  /** Number of requestMicrophoneAccess calls. */
  readonly requestCount: () => number;
  /** Force the mic status (e.g. to assert a denied readout). */
  readonly setMicStatus: (status: MediaAccessStatus) => void;
}

export const makeFakeSystemPermissions = (init?: {
  micStatus?: MediaAccessStatus;
  systemVersion?: string;
  /** The status the OS prompt resolves to (default: granted). */
  grantOnRequest?: MediaAccessStatus;
}): FakeSystemPermissions => {
  let micStatus: MediaAccessStatus = init?.micStatus ?? 'not-determined';
  const systemVersion = init?.systemVersion ?? '14.4.0';
  const grant = init?.grantOnRequest ?? 'granted';
  let requests = 0;

  const service: SystemPermissionsApi = {
    microphoneStatus: Effect.sync(() => micStatus),
    requestMicrophoneAccess: Effect.sync(() => {
      requests += 1;
      micStatus = grant;
      return grant === 'granted';
    }),
    systemVersion: Effect.sync(() => systemVersion),
  };
  return {
    layer: Layer.succeed(SystemPermissions, service),
    requestCount: () => requests,
    setMicStatus: status => {
      micStatus = status;
    },
  };
};
