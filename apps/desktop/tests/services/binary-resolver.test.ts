/**
 * Binary path resolver — the load-bearing correctness fix. A packaged app
 * must resolve the native helper binaries at Contents/Resources (where forge
 * extraResource drops them), while dev/start reads the repo bin/ copy. A wrong
 * packaged branch = the packaged app silently cannot spawn the helper.
 *
 * Mocks electron so app.isPackaged is toggleable and stubs the Electron-only
 * process.resourcesPath global.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { FakeElectron } from '../helpers/fake-electron';
import { resolveAudioCaptureBinaryPath } from '../../src/main/infra/audio-capture/audio-capture-binary';
import { resolveMicDetectorBinaryPath } from '../../src/main/infra/mic-detector/mic-detector-binary';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

const RESOURCES = '/fake/Prismical.app/Contents/Resources';
const withResourcesPath = process as unknown as { resourcesPath?: string };
let savedResourcesPath: string | undefined;

// Match the resolver's platform-dependent basename so the suite is valid on any
// CI runner (darwin/linux); this repo never packages on win32.
const audioBinaryName = process.platform === 'win32' ? 'audio-capture.exe' : 'audio-capture';
const micBinaryName =
  process.platform === 'win32' ? 'prismical-mic-detector.exe' : 'prismical-mic-detector';

const devPath = (pkg: string, binary: string): string =>
  path.join(process.cwd(), '..', '..', 'packages', 'native-helpers', pkg, 'bin', binary);

beforeEach(() => {
  savedResourcesPath = withResourcesPath.resourcesPath;
});

afterEach(() => {
  fake.app.isPackaged = false;
  if (savedResourcesPath === undefined) delete withResourcesPath.resourcesPath;
  else withResourcesPath.resourcesPath = savedResourcesPath;
});

describe('native helper binary resolver (dev vs packaged)', () => {
  it('audio-capture: dev build resolves the repo bin/ path', () => {
    fake.app.isPackaged = false;
    withResourcesPath.resourcesPath = RESOURCES; // ignored on the dev branch
    expect(resolveAudioCaptureBinaryPath()).toBe(devPath('audio-capture', audioBinaryName));
  });

  it('audio-capture: packaged build resolves process.resourcesPath/<binary>', () => {
    fake.app.isPackaged = true;
    withResourcesPath.resourcesPath = RESOURCES;
    expect(resolveAudioCaptureBinaryPath()).toBe(path.join(RESOURCES, audioBinaryName));
    // Exactly where extraResource lands it: Contents/Resources/audio-capture.
    expect(resolveAudioCaptureBinaryPath()).toBe(`${RESOURCES}/${audioBinaryName}`);
  });

  it('mic-detector: dev build resolves the repo bin/ path', () => {
    fake.app.isPackaged = false;
    withResourcesPath.resourcesPath = RESOURCES; // ignored on the dev branch
    expect(resolveMicDetectorBinaryPath()).toBe(devPath('mic-detector', micBinaryName));
  });

  it('mic-detector: packaged build resolves process.resourcesPath/<binary>', () => {
    fake.app.isPackaged = true;
    withResourcesPath.resourcesPath = RESOURCES;
    expect(resolveMicDetectorBinaryPath()).toBe(path.join(RESOURCES, micBinaryName));
    // Exactly where extraResource lands it: Contents/Resources/prismical-mic-detector.
    expect(resolveMicDetectorBinaryPath()).toBe(`${RESOURCES}/${micBinaryName}`);
  });
});
