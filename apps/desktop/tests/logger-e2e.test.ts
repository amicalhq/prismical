/**
 * Log-hermeticity seam (src/main/logger.ts): under the e2e harness env the
 * electron-log file transport must resolve into the per-run profile dir — the
 * sentinel scans read <profile>/logs/main.log — because electron-log's default
 * resolvePathFn uses the SHARED OS log dir (~/Library/Logs/<appName> on macOS)
 * regardless of app.setPath('userData'). Without the env, the default
 * resolution must stay untouched.
 *
 * electron-log is an externalized CJS singleton: vi.resetModules() re-runs
 * logger.ts (so it re-reads the env) but the `log` instance is shared across
 * tests — snapshot the pristine resolvePathFn here and restore it after each
 * test, or a mutation from one test leaks into the next.
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log as sharedLog } from '../src/main/logger';

const defaultResolvePathFn = sharedLog.transports.file.resolvePathFn;

type ResolveVars = Parameters<typeof defaultResolvePathFn>[0];
const vars = (fileName: string, libraryDefaultDir: string): ResolveVars =>
  ({ fileName, libraryDefaultDir }) as unknown as ResolveVars;

const ORIGINAL_E2E = process.env.PRISMICAL_E2E;
const ORIGINAL_DIR = process.env.PRISMICAL_E2E_USER_DATA_DIR;

const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

/** Fresh logger.ts evaluation so it re-reads the env at import time. */
const importLogger = async () => {
  vi.resetModules();
  return import('../src/main/logger');
};

afterEach(() => {
  restore('PRISMICAL_E2E', ORIGINAL_E2E);
  restore('PRISMICAL_E2E_USER_DATA_DIR', ORIGINAL_DIR);
  sharedLog.transports.file.resolvePathFn = defaultResolvePathFn;
  vi.resetModules();
});

describe('logger e2e file-path seam', () => {
  it('pins the file transport under the e2e profile dir when the harness env is set', async () => {
    process.env.PRISMICAL_E2E = '1';
    process.env.PRISMICAL_E2E_USER_DATA_DIR = path.join(path.sep, 'tmp', 'prismical-e2e-profile');
    const { log } = await importLogger();

    const resolved = log.transports.file.resolvePathFn(
      vars('main.log', path.join(path.sep, 'shared', 'Logs', 'Prismical'))
    );
    expect(resolved).toBe(
      path.join(path.sep, 'tmp', 'prismical-e2e-profile', 'logs', 'main.log')
    );
  });

  it('keeps electron-log default resolution when PRISMICAL_E2E is not set', async () => {
    delete process.env.PRISMICAL_E2E;
    delete process.env.PRISMICAL_E2E_USER_DATA_DIR;
    const { log } = await importLogger();

    const shared = path.join(path.sep, 'shared', 'Logs', 'Prismical');
    const resolved = log.transports.file.resolvePathFn(vars('main.log', shared));
    expect(resolved).toBe(path.join(shared, 'main.log'));
  });

  it('a profile dir without the E2E flag does NOT hijack production logs', async () => {
    delete process.env.PRISMICAL_E2E;
    process.env.PRISMICAL_E2E_USER_DATA_DIR = path.join(path.sep, 'tmp', 'stray-profile');
    const { log } = await importLogger();

    const shared = path.join(path.sep, 'shared', 'Logs', 'Prismical');
    const resolved = log.transports.file.resolvePathFn(vars('main.log', shared));
    expect(resolved).toBe(path.join(shared, 'main.log'));
  });
});
