/**
 * A fake NativeOs edge that records every OS side effect
 * instead of touching electron, so the os-sync consumer + the capability handlers
 * are headless-testable. Electron-free.
 */
import { Effect, Layer } from 'effect';
import { NativeOs, type NativeOsApi } from '../../src/main/infra/native-os/service';

export interface FakeNativeOsCalls {
  readonly loginItem: boolean[];
  readonly dock: boolean[];
  readonly openExternal: string[];
  reveal: number;
  relaunch: number;
}

export interface FakeNativeOs {
  readonly layer: Layer.Layer<NativeOs>;
  readonly calls: FakeNativeOsCalls;
}

export const makeFakeNativeOs = (): FakeNativeOs => {
  const calls: FakeNativeOsCalls = {
    loginItem: [],
    dock: [],
    openExternal: [],
    reveal: 0,
    relaunch: 0,
  };
  const service: NativeOsApi = {
    setLoginItem: openAtLogin =>
      Effect.sync(() => {
        calls.loginItem.push(openAtLogin);
      }),
    setDockVisible: visible =>
      Effect.sync(() => {
        calls.dock.push(visible);
      }),
    openExternal: url =>
      Effect.sync(() => {
        calls.openExternal.push(url);
      }),
    revealLogs: Effect.sync(() => {
      calls.reveal += 1;
    }),
    relaunch: Effect.sync(() => {
      calls.relaunch += 1;
    }),
  };
  return { layer: Layer.succeed(NativeOs, service), calls };
};
