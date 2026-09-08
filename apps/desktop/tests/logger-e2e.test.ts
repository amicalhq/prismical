import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ profile: '', packaged: false, savePath: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => state.profile,
    getVersion: () => '1.2.3',
    get isPackaged() {
      return state.packaged;
    },
  },
  dialog: {
    showSaveDialog: async () => ({ canceled: !state.savePath, filePath: state.savePath }),
    showErrorBox: vi.fn(),
  },
}));
import {
  makeMainLogging,
  resolveLogPaths,
  snapshotLogs,
  LOG_MAX_BYTES,
} from '../src/main/infra/logging/live';
import { Effect } from 'effect';

afterEach(() => {
  vi.unstubAllEnvs();
  state.packaged = false;
  state.savePath = '';
});
const profile = (packaged = false) => {
  state.packaged = packaged;
  state.profile = mkdtempSync(path.join(tmpdir(), 'prismical-jsonl-'));
  return resolveLogPaths(state.profile, { isDev: !packaged });
};

describe('real diagnostic persistence', () => {
  it('separates development and packaged logs while preserving isolated E2E filenames', () => {
    expect(resolveLogPaths('/profile', { isDev: true }).current).toBe(
      '/profile/logs/main-dev.jsonl'
    );
    expect(resolveLogPaths('/profile').current).toBe('/profile/logs/main.jsonl');
    expect(resolveLogPaths('/e2e-run', { isDev: true, isE2E: true }).current).toBe(
      '/e2e-run/logs/main.jsonl'
    );
  });

  it('uses the supplied profile, writes one JSON line, and preserves safe error classification', () => {
    const paths = profile();
    const logging = makeMainLogging('run-a');
    logging.service.scopedSync('auth').error('OAuth failed\nretry unavailable', {
      context: { apiKey: 'private-key', transcript: 'private transcript' },
      error: Object.assign(new Error('https://auth.example/callback?code=private-code'), {
        _tag: 'AuthError',
        code: 'UNAUTHORIZED',
      }),
    });
    const content = readFileSync(paths.current, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(1);
    expect(content).not.toMatch(/private-key|private transcript|private-code/);
    expect(JSON.parse(content)).toMatchObject({
      appRunId: 'run-a',
      runtime: 'main',
      scope: 'auth',
      error: { tag: 'AuthError', code: 'UNAUTHORIZED' },
    });
  });

  it('enforces production file admission and rotates to one JSONL backup', () => {
    const paths = profile(true);
    const first = makeMainLogging('old-run');
    first.service.scopedSync('test').debug('not admitted');
    expect(existsSync(paths.current)).toBe(false);
    first.service.scopedSync('test').info('seed');
    const log = first.service.scopedSync('test');
    for (let index = 0; index < Math.ceil(LOG_MAX_BYTES / 1800) + 1; index++)
      log.info('x'.repeat(1800));
    makeMainLogging('new-run').service.scopedSync('test').info('after rotation');
    expect(existsSync(paths.backup)).toBe(true);
    const last = readFileSync(paths.current, 'utf8').trim().split('\n').at(-1)!;
    expect(JSON.parse(last).appRunId).toBe('new-run');
  });

  it('exports current and backup with partial-line and legacy notices', async () => {
    const paths = profile();
    const logging = makeMainLogging('export-run');
    logging.service.scopedSync('test').info('current');
    writeFileSync(paths.backup, readFileSync(paths.current, 'utf8') + '{incomplete');
    writeFileSync(paths.legacy, 'secret legacy transcript');
    state.savePath = path.join(state.profile, 'bundle.json');
    await Effect.runPromise(logging.transport.exportBundle);
    const bundle = JSON.parse(readFileSync(state.savePath, 'utf8'));
    expect(bundle.files.map((file: { name: string }) => file.name)).toEqual([
      'main-dev.jsonl',
      'main-dev.old.jsonl',
    ]);
    expect(bundle.manifest.appRunIds).toEqual(['export-run']);
    expect(bundle.manifest.notices.join(' ')).toMatch(/incomplete final line/);
    expect(JSON.stringify(bundle)).not.toContain('secret legacy transcript');
    expect(snapshotLogs(paths).notices.join(' ')).toContain('Legacy text logs excluded');
  });

  it('revalidates retained records and strips untrusted fields during export', () => {
    const paths = profile();
    makeMainLogging('export-run').service.scopedSync('test').info('seed');
    const record = JSON.parse(readFileSync(paths.current, 'utf8'));
    writeFileSync(
      paths.current,
      `${JSON.stringify({ ...record, context: { transcript: 'private transcript' }, extra: 'private extra' })}\n${JSON.stringify({ schemaVersion: 1, appRunId: 'forged' })}\n`
    );
    const snapshot = snapshotLogs(paths);
    expect(snapshot.files[0]!.content).not.toMatch(/private transcript|private extra|forged/);
    expect(snapshot.notices.join(' ')).toContain('invalid record excluded');
    expect(JSON.parse(snapshot.files[0]!.content).context.transcript).toBe('[redacted]');
  });
});
