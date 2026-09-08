import { Effect } from 'effect';
import { MainLogger, LoggingTransport } from '../../src/main/infra/logging/service';
import { makeTestLogger } from '../helpers/test-layers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    setAppUserModelId: vi.fn(),
  },
  registerSchemes: vi.fn(),
  makeRuntime: vi.fn(() => ({ runPromise: () => new Promise(() => {}) })),
}));

vi.mock('electron', () => ({
  app: mocks.app,
  protocol: { registerSchemesAsPrivileged: mocks.registerSchemes },
}));
vi.mock('../../src/main/runtime/runtime', () => ({ makeDesktopRuntime: mocks.makeRuntime }));
vi.mock('../../src/main/runtime/boot-program', () => ({ bootProgram: undefined }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.app.requestSingleInstanceLock.mockReturnValue(true);
  vi.stubEnv('PRISMICAL_E2E', '1');
  vi.stubEnv('PRISMICAL_E2E_BREAK_BOOT', '');
  vi.stubGlobal('process', { ...process, platform: 'win32' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function startDesktop() {
  const logger = makeTestLogger();
  const logging = Effect.runSync(
    Effect.gen(function* () {
      return {
        service: yield* MainLogger,
        transport: { ...(yield* LoggingTransport), exportBundle: () => Effect.void },
        layer: logger.layer,
      };
    }).pipe(Effect.provide(logger.layer))
  );
  const { startDesktop } = await import('../../src/main/runtime/start');
  startDesktop(logging);
}

describe('startup process boundary', () => {
  it('a second launch quits without starting services or registering protocols', async () => {
    mocks.app.requestSingleInstanceLock.mockReturnValue(false);
    await startDesktop();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    expect(mocks.makeRuntime).not.toHaveBeenCalled();
    expect(mocks.registerSchemes).not.toHaveBeenCalled();
    expect(mocks.app.setAppUserModelId).not.toHaveBeenCalled();
  });

  it('the Windows primary instance uses the Squirrel shortcut identity', async () => {
    await startDesktop();
    expect(mocks.app.setAppUserModelId).toHaveBeenCalledWith('ai.prismical.desktop');
    expect(mocks.makeRuntime).toHaveBeenCalledOnce();
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it('macOS starts without setting a Windows identity', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    await startDesktop();
    expect(mocks.app.setAppUserModelId).not.toHaveBeenCalled();
    expect(mocks.makeRuntime).toHaveBeenCalledOnce();
  });
});
