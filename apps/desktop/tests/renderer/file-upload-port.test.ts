import type { DesktopFileUpload, FileUploadResult } from '@prismical/desktop-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileUploadPort } from '../../src/renderer/main/app/ports/desktop-ports';

vi.mock('../../src/renderer/main/app/router', () => ({ router: {} }));
vi.mock('../../src/renderer/main/app/analytics/posthog', () => ({ desktopAnalyticsPort: {} }));

afterEach(() => vi.unstubAllGlobals());

const file = new File(['audio'], 'audio.wav');
const URL = 'https://storage.test/upload';
const request = (signal: AbortSignal, onProgress = vi.fn()) => ({
  url: URL,
  file,
  contentType: 'audio/wav',
  onProgress,
  signal,
});

const stubMain = () => {
  let finish!: (result: FileUploadResult) => void;
  const cancel = vi.fn();
  const put = vi.fn(
    (): DesktopFileUpload => ({
      done: new Promise(resolve => {
        finish = resolve;
      }),
      cancel,
    })
  );
  vi.stubGlobal('window', { desktop: { fileUpload: { put } } });
  return { put, cancel, finish: (result: FileUploadResult) => finish(result) };
};

describe('desktop file upload port', () => {
  it('hands the file to main and returns its result', async () => {
    const main = stubMain();
    const onProgress = vi.fn();
    const pending = fileUploadPort.put(request(new AbortController().signal, onProgress));
    expect(main.put).toHaveBeenCalledExactlyOnceWith(
      { url: URL, file, contentType: 'audio/wav' },
      onProgress
    );
    main.finish({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('cancels in main when the signal aborts', async () => {
    const main = stubMain();
    const controller = new AbortController();
    const pending = fileUploadPort.put(request(controller.signal));
    controller.abort();
    expect(main.cancel).toHaveBeenCalledOnce();
    main.finish({ ok: false, reason: 'cancelled' });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' });
  });

  it('does not start when the signal is already aborted', async () => {
    const main = stubMain();
    const controller = new AbortController();
    controller.abort();
    await expect(fileUploadPort.put(request(controller.signal))).resolves.toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(main.put).not.toHaveBeenCalled();
  });
});
