import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { retryTranscriptFinalizing } from './skill-run-retry';

describe('retryTranscriptFinalizing', () => {
  it('retries the readiness response using the server delay', async () => {
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new ApiError('TRANSCRIPT_FINALIZING', 'still finalizing', 409, { retryAfterMs: 750 })
      )
      .mockResolvedValue('ready');
    const delay = vi.fn(async () => {});

    await expect(
      retryTranscriptFinalizing(call, new AbortController().signal, delay)
    ).resolves.toBe('ready');
    expect(call).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(750, expect.any(AbortSignal));
  });

  it('does not retry unrelated failures', async () => {
    const error = new ApiError('NO_TRANSCRIPT', 'empty', 422);
    const call = vi.fn(async () => {
      throw error;
    });
    const delay = vi.fn(async () => {});

    await expect(retryTranscriptFinalizing(call, new AbortController().signal, delay)).rejects.toBe(
      error
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('bounds a stuck finalization instead of occupying the run UI forever', async () => {
    const error = new ApiError('TRANSCRIPT_FINALIZING', 'still finalizing', 409);
    const call = vi.fn(async () => {
      throw error;
    });
    const delay = vi.fn(async () => {});

    await expect(
      retryTranscriptFinalizing(call, new AbortController().signal, delay, 2)
    ).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('cancels while parked between readiness attempts', async () => {
    const ac = new AbortController();
    const call = vi.fn(async () => {
      throw new ApiError('TRANSCRIPT_FINALIZING', 'still finalizing', 409);
    });
    const delay = vi.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );

    const pending = retryTranscriptFinalizing(call, ac.signal, delay);
    await Promise.resolve();
    ac.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(call).toHaveBeenCalledTimes(1);
  });
});
