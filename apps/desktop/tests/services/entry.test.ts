import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';

const mocks = vi.hoisted(() => ({
  started: true,
  quit: vi.fn(),
  start: vi.fn(),
  warn: vi.fn(),
  getCAs: vi.fn<(type: string) => string[]>(() => []),
  setCAs: vi.fn(),
  makeLogging: vi.fn(),
}));
vi.mock('node:tls', async importOriginal => ({
  ...(await importOriginal<typeof import('node:tls')>()),
  getCACertificates: mocks.getCAs,
  setDefaultCACertificates: mocks.setCAs,
}));
vi.mock('electron', () => ({ app: { isPackaged: false, quit: mocks.quit }, dialog: {} }));
vi.mock('../../src/main/squirrel-startup', () => ({ handleSquirrelStartup: () => mocks.started }));
vi.mock('../../src/main/infra/logging/live', () => ({ makeMainLogging: mocks.makeLogging }));
vi.mock('../../src/main/runtime/start', () => ({ startDesktop: mocks.start }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.getCAs.mockReset().mockReturnValue([]);
  mocks.setCAs.mockReset();
  mocks.makeLogging.mockReturnValue({
    service: { scopedSync: () => ({ info: vi.fn(), warn: mocks.warn }) },
  });
  vi.stubEnv('PRISMICAL_E2E_USER_DATA_DIR', '');
  vi.stubGlobal('process', { ...process, platform: 'win32' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('Squirrel hook processes leave shutdown to the handler without importing the app', async () => {
  mocks.started = true;
  await import('../../src/main/entry');
  expect(mocks.quit).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.makeLogging).not.toHaveBeenCalled();
  expect(mocks.getCAs).not.toHaveBeenCalled();
  expect(mocks.setCAs).not.toHaveBeenCalled();
});

it('normal and first-run launches load the app when Squirrel reports no hook', async () => {
  mocks.started = false;
  await import('../../src/main/entry');
  await vi.dynamicImportSettled();
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mocks.quit).not.toHaveBeenCalled();
});

it('merges valid default and system certificates before starting network services', async () => {
  const certificates = rootCertificates
    .map(pem => ({ pem, expires: Date.parse(new X509Certificate(pem).validTo) }))
    .sort((a, b) => a.expires - b.expires);
  const expired = certificates[0];
  const defaultCA = certificates[certificates.length - 1];
  const systemCA = certificates[certificates.length - 2];
  vi.spyOn(Date, 'now').mockReturnValue(expired.expires + 1);
  mocks.getCAs.mockImplementation(type =>
    type === 'default' ? [defaultCA.pem] : [systemCA.pem, expired.pem, 'invalid certificate']
  );
  mocks.started = false;

  await import('../../src/main/entry');
  await vi.dynamicImportSettled();

  expect(mocks.setCAs).toHaveBeenCalledExactlyOnceWith([defaultCA.pem, systemCA.pem]);
  expect(mocks.setCAs.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.start.mock.invocationCallOrder[0]
  );
  expect(mocks.warn).not.toHaveBeenCalled();
});

it.each(['read', 'apply'])('continues startup if trust-store %s fails', async operation => {
  const error = new Error('Trust store unavailable');
  const method = operation === 'read' ? mocks.getCAs : mocks.setCAs;
  method.mockImplementationOnce(() => {
    throw error;
  });
  mocks.started = false;

  await import('../../src/main/entry');
  await vi.dynamicImportSettled();

  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('Failed to load system CA certificates', {
    error,
  });
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mocks.quit).not.toHaveBeenCalled();
});
