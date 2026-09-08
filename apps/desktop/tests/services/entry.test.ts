import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  started: true,
  quit: vi.fn(),
  start: vi.fn(),
  makeLogging: vi.fn(() => ({ service: { scopedSync: () => ({ info: vi.fn() }) } })),
}));
vi.mock('electron', () => ({ app: { isPackaged: false, quit: mocks.quit }, dialog: {} }));
vi.mock('../../src/main/squirrel-startup', () => ({ handleSquirrelStartup: () => mocks.started }));
vi.mock('../../src/main/infra/logging/live', () => ({ makeMainLogging: mocks.makeLogging }));
vi.mock('../../src/main/runtime/start', () => ({ startDesktop: mocks.start }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('PRISMICAL_E2E_USER_DATA_DIR', '');
  vi.stubGlobal('process', { ...process, platform: 'win32' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('Squirrel hook processes leave shutdown to the handler without importing the app', async () => {
  mocks.started = true;
  await import('../../src/main/entry');
  expect(mocks.quit).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.makeLogging).not.toHaveBeenCalled();
});

it('normal and first-run launches load the app when Squirrel reports no hook', async () => {
  mocks.started = false;
  await import('../../src/main/entry');
  await vi.dynamicImportSettled();
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mocks.quit).not.toHaveBeenCalled();
});
