import { makeTestLogger, testI18nLayer } from '../helpers/test-layers';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeOsLive } from '../../src/main/infra/native-os/live';
import { NativeOs } from '../../src/main/infra/native-os/service';

const app = vi.hoisted(() => ({ isPackaged: false, relaunch: vi.fn(), quit: vi.fn() }));
vi.mock('electron', () => ({ app, shell: {} }));

let directory: string;
let restartFile: string;
beforeEach(() => {
  vi.clearAllMocks();
  app.isPackaged = false;
  directory = mkdtempSync(path.join(tmpdir(), 'prismical-relaunch-test-'));
  restartFile = path.join(directory, 'requested');
  vi.stubEnv('PRISMICAL_DEV_RESTART_FILE', restartFile);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const relaunch = () =>
  Effect.runPromise(
    Effect.flatMap(NativeOs, nativeOs => nativeOs.relaunch).pipe(
      Effect.provide(
        NativeOsLive.pipe(Layer.provide(makeTestLogger().layer), Layer.provide(testI18nLayer()))
      )
    )
  );

describe('native relaunch', () => {
  it('requests a launcher restart before quitting an unpackaged app', async () => {
    app.quit.mockImplementationOnce(() => expect(existsSync(restartFile)).toBe(true));
    await relaunch();
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('uses Electron relaunch for packaged builds even when the dev marker is in the environment', async () => {
    app.isPackaged = true;
    await relaunch();
    expect(existsSync(restartFile)).toBe(false);
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('retains Electron relaunch when running without the dev launcher', async () => {
    vi.stubEnv('PRISMICAL_DEV_RESTART_FILE', undefined);
    await relaunch();
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });
});
