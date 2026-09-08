import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import {
  DEFAULT_TRANSCRIPT_WAIT_MS,
  MAX_TRANSCRIPT_WAIT_MS,
  retryTranscriptFinalizing,
} from './skill-run-retry';

/** A fake clock the delay stub advances, so the budget is exercised without real time. */
function clock() {
  let t = 1_000_000;
  const now = () => t;
  const delay = vi.fn(async (ms: number) => {
    t += ms;
  });
  return { now, delay };
}

const finalizing = (details?: Record<string, unknown>) =>
  new ApiError('TRANSCRIPT_FINALIZING', 'still finalizing', 409, details);

describe('retryTranscriptFinalizing', () => {
  it('retries the readiness response using the server delay', async () => {
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(finalizing({ retryAfterMs: 750 }))
      .mockResolvedValue('ready');
    const { now, delay } = clock();

    await expect(
      retryTranscriptFinalizing(call, new AbortController().signal, delay, { now })
    ).resolves.toBe('ready');
    expect(call).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(750, expect.any(AbortSignal));
  });

  it('does not retry unrelated failures', async () => {
    const error = new ApiError('NO_TRANSCRIPT', 'empty', 422);
    const call = vi.fn(async () => {
      throw error;
    });
    const { now, delay } = clock();

    await expect(
      retryTranscriptFinalizing(call, new AbortController().signal, delay, { now })
    ).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('budgets by the server deadline, not a retry count: outlasts the incident floor', async () => {
    // The incident: finalize settled 3m39s after stop; the old 60 × 2.4 s budget quit at 2m24s.
    // With the server advertising a 15-minute release deadline, a run that needs ~4 minutes of
    // 2 s polls (~120 attempts) must still get its transcript.
    const settleAfterMs = 4 * 60_000;
    const { now, delay } = clock();
    const started = now();
    const call = vi.fn(async () => {
      if (now() - started < settleAfterMs) {
        throw finalizing({ retryAfterMs: 2_000, deadlineMs: 15 * 60_000 - (now() - started) });
      }
      return 'ready';
    });
    await expect(
      retryTranscriptFinalizing(call, new AbortController().signal, delay, { now })
    ).resolves.toBe('ready');
    expect(call.mock.calls.length).toBeGreaterThan(100);
  });

  it('parks at the server deadline by rethrowing the readiness error', async () => {
    const error = finalizing({ retryAfterMs: 2_000, deadlineMs: 5_000 });
    const call = vi.fn(async () => {
      throw error;
    });
    const { now, delay } = clock();
    await expect(
      retryTranscriptFinalizing(call, new AbortController().signal, delay, { now })
    ).rejects.toBe(error);
    // 0 s, 2 s, 4 s attempted; the 6 s attempt would overrun the 5 s deadline.
    expect(call).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('only ever moves the deadline earlier, and never past the hard ceiling', async () => {
    const { now, delay } = clock();
    const started = now();
    const call = vi.fn(async () => {
      // A server that first says "10 s" then tries to extend to an hour, forever.
      const first = call.mock.calls.length === 1;
      throw finalizing({ retryAfterMs: 1_000, deadlineMs: first ? 10_000 : 60 * 60_000 });
    });
    await expect(
      retryTranscriptFinalizing(call, new AbortController().signal, delay, { now })
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_FINALIZING' });
    expect(now() - started).toBeLessThanOrEqual(10_000);

    // No deadline at all: the client default applies, capped by the ceiling.
    const { now: now2, delay: delay2 } = clock();
    const started2 = now2();
    const call2 = vi.fn(async () => {
      throw finalizing({ retryAfterMs: 30_000 });
    });
    await expect(
      retryTranscriptFinalizing(call2, new AbortController().signal, delay2, { now: now2 })
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_FINALIZING' });
    expect(now2() - started2).toBeLessThanOrEqual(DEFAULT_TRANSCRIPT_WAIT_MS);
    expect(DEFAULT_TRANSCRIPT_WAIT_MS).toBeLessThanOrEqual(MAX_TRANSCRIPT_WAIT_MS);
  });

  it('a zero or absent server deadline still gets the client default, never an instant park', async () => {
    // A server whose schedule fell behind used to be able to advertise deadlineMs: 0; the client
    // must not treat that as "give up now" on the first 409.
    const { now, delay } = clock();
    const started = now();
    const call = vi.fn(async () => {
      if (now() - started < 30_000) throw finalizing({ retryAfterMs: 2_000, deadlineMs: 0 });
      return 'ready';
    });
    await expect(
      retryTranscriptFinalizing(call, new AbortController().signal, delay, { now })
    ).resolves.toBe('ready');
    expect(call.mock.calls.length).toBeGreaterThan(10);
  });

  it('cancels while parked between readiness attempts', async () => {
    const ac = new AbortController();
    const call = vi.fn(async () => {
      throw finalizing();
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
