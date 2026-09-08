// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRendererLogging } from '../../src/renderer/logging';
import type { RendererLoggingConfig } from '@prismical/desktop-contracts';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});
const config: RendererLoggingConfig = {
  appVersion: 'test',
  appRunId: 'run',
  isDev: false,
  pid: 42,
  surface: 'widget',
};

describe('renderer diagnostic boundary', () => {
  it('applies production admission to sanitized DevTools and IPC records', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = vi.fn(async () => {});
    cleanup = installRendererLogging({ getConfig: async () => config, write });
    await Promise.resolve();
    console.debug('hidden debug');
    console.info('file-only info');
    console.warn('https://auth.example/callback?code=private-code', {
      transcript: 'private transcript',
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/private-code|private transcript/);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-code|private transcript/);
  });

  it('caps early records and accounts for suppression after configuration arrives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resolve!: (value: RendererLoggingConfig) => void;
    const getConfig = () =>
      new Promise<RendererLoggingConfig>(done => {
        resolve = done;
      });
    const write = vi.fn(async () => {});
    cleanup = installRendererLogging({ getConfig, write });
    for (let index = 0; index < 300; index++) console.info('early record');
    expect(write).not.toHaveBeenCalled();
    resolve(config);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(129));
    console.info('next record');
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(130));
    expect(JSON.stringify(write.mock.calls)).toContain('Renderer log records suppressed');
  });

  it('deduplicates the same Error across a console report and an uncaught observer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.fn(async () => {});
    cleanup = installRendererLogging({ getConfig: async () => config, write });
    await Promise.resolve();
    const error = new Error('failed');
    console.error('Renderer failed', error);
    window.dispatchEvent(new ErrorEvent('error', { error }));
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  });
});
