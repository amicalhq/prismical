import { Deferred, Effect, FiberSet, Scope } from 'effect';
import { MainLogger, LoggingTransport } from '../../src/main/infra/logging/service';
import { makeTestLogger } from '../helpers/test-layers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    exit: vi.fn(),
    setAppUserModelId: vi.fn(),
  },
  registerSchemes: vi.fn(),
  makeRuntime: vi.fn<() => {
    runPromise: (effect: Effect.Effect<void, unknown>) => Promise<void>;
    dispose: () => Promise<void>;
  }>(),
  bootProgram: undefined as unknown as Effect.Effect<void, unknown, Scope.Scope>,
}));

vi.mock('electron', () => ({
  app: mocks.app,
  protocol: { registerSchemesAsPrivileged: mocks.registerSchemes },
}));
vi.mock('../../src/main/runtime/runtime', () => ({ makeDesktopRuntime: mocks.makeRuntime }));
vi.mock('../../src/main/runtime/boot-program', () => ({
  get bootProgram() { return mocks.bootProgram; },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.bootProgram = Effect.never;
  mocks.makeRuntime.mockReturnValue({
    runPromise: () => new Promise<void>(() => {}),
    dispose: () => Promise.resolve(),
  });
  mocks.app.requestSingleInstanceLock.mockReturnValue(true);
  vi.stubEnv('PRISMICAL_E2E', '1');
  vi.stubEnv('PRISMICAL_E2E_BREAK_BOOT', '');
  vi.stubGlobal('process', { ...process, platform: 'win32' });
});

afterEach(() => {
  vi.useRealTimers();
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
  return logger;
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

  it('closes the program before disposing the runtime and exits once', async () => {
    const events: string[] = [];
    mocks.bootProgram = Effect.addFinalizer(() => Effect.sync(() => { events.push('program'); }));
    const dispose = vi.fn(async () => { events.push('runtime'); });
    mocks.makeRuntime.mockReturnValue({ runPromise: Effect.runPromise, dispose });

    await startDesktop();
    await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(0));

    expect(events).toEqual(['program', 'runtime']);
    expect(dispose).toHaveBeenCalledOnce();
    expect(mocks.app.exit).toHaveBeenCalledOnce();
  });

  it('bounds a wedged callback finalizer within the same five-second quit budget', async () => {
    vi.useFakeTimers();
    const finalizing = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    mocks.bootProgram = Effect.gen(function* () {
      const run = yield* FiberSet.makeRuntime();
      run(Effect.andThen(Effect.yieldNow, Effect.never.pipe(
        Effect.ensuring(Deferred.succeed(finalizing, undefined).pipe(
          Effect.andThen(Deferred.await(release))
        ))
      )));
      yield* Effect.yieldNow;
    });
    const dispose = vi.fn(async () => {});
    mocks.makeRuntime.mockReturnValue({ runPromise: Effect.runPromise, dispose });

    const logger = await startDesktop();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(Deferred.isDoneUnsafe(finalizing)).toBe(true);
      await vi.advanceTimersByTimeAsync(4999);
      expect(mocks.app.exit).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(logger.find(entry => entry.message === 'Runtime shutdown exceeded deadline; exiting')).toBeDefined();
    } finally {
      // Release the synthetic hang so the test leaves no detached cleanup behind.
      Deferred.doneUnsafe(release, Effect.void);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(dispose).toHaveBeenCalledOnce();
    expect(mocks.app.exit).toHaveBeenCalledOnce();
  });

  it('still disposes the runtime when a program finalizer defects', async () => {
    const failure = new Error('program cleanup failed');
    mocks.bootProgram = Effect.addFinalizer(() => Effect.die(failure));
    const dispose = vi.fn(async () => {});
    mocks.makeRuntime.mockReturnValue({ runPromise: Effect.runPromise, dispose });

    const logger = await startDesktop();
    await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(0));

    expect(dispose).toHaveBeenCalledOnce();
    expect(logger.find(entry => entry.message === 'Runtime shutdown failed')?.error?.message)
      .toBe(failure.message);
  });

  it('reports a direct Effect failure and exits one when boot fails', async () => {
    const failure = new Error('boot failed');
    mocks.bootProgram = Effect.fail(failure);
    const dispose = vi.fn(async () => {});
    mocks.makeRuntime.mockReturnValue({ runPromise: Effect.runPromise, dispose });

    const logger = await startDesktop();
    await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(1));

    expect(dispose).not.toHaveBeenCalled();
    expect(logger.find(entry => entry.message === 'Application boot failed')?.error?.message)
      .toBe(failure.message);
  });
});
