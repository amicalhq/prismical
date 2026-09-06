import { once } from 'node:events';
import { createServer } from 'node:net';
import { Effect, Fiber, Queue, SubscriptionRef } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDevLoopbackOAuthServer } from '../../src/main/domains/deep-link/dev-loopback';
import { DeepLinks, type PendingOAuthEntry } from '../../src/main/domains/deep-link/service';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';

afterEach(() => vi.unstubAllEnvs());

const start = async (isPackaged = false) => {
  const logger = makeTestLogger();
  const urls = await Effect.runPromise(Queue.unbounded<string>());
  const pendingOAuth = await Effect.runPromise(
    SubscriptionRef.make<ReadonlyArray<PendingOAuthEntry>>([])
  );
  const fiber = Effect.runFork(
    runDevLoopbackOAuthServer.pipe(
      Effect.provideService(DeepLinks, {
        urls,
        offerUrl: url => Queue.offer(urls, url),
        pendingOAuth,
      }),
      Effect.provide(testConfigLayer({ isPackaged })),
      Effect.provide(logger.layer)
    )
  );
  return { logger, urls, fiber };
};

describe('dev OAuth callback listener', () => {
  it('listens on PORT and forwards callbacks into the deep-link queue', async () => {
    // Under portless, exercise the HTTPS proxy too. Otherwise reserve a free test port.
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address() as { port: number };
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const port = process.env.PORTLESS_URL ? Number(process.env.PORT) : address.port;
    vi.stubEnv('PORT', String(port));
    const { logger, urls, fiber } = await start();
    try {
      await vi.waitFor(() =>
        expect(
          logger.find(entry => entry.message === 'dev loopback oauth server listening')?.data
        ).toEqual({ port })
      );
      const origin = process.env.PORTLESS_URL ?? `http://127.0.0.1:${port}`;
      const missing = await fetch(`${origin}/missing`);
      expect(missing.status).toBe(404);
      expect(await Effect.runPromise(Queue.size(urls))).toBe(0);

      const response = await fetch(`${origin}/oauth/callback?code=test-code&state=test-state`);
      expect(response.status).toBe(200);
      expect(await Effect.runPromise(Queue.take(urls))).toBe(
        'prismical-dev://oauth/callback?code=test-code&state=test-state'
      );
      expect(JSON.stringify(logger.entries)).not.toContain('test-code');
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
    await expect(fetch(`http://127.0.0.1:${port}/oauth/callback`)).rejects.toThrow();
  });

  it.each([undefined, '', 'invalid', '0', '-1', '65536'])(
    'skips listening with invalid PORT=%s',
    async port => {
      vi.stubEnv('PORT', port);
      const { logger, fiber } = await start();
      await Effect.runPromise(Fiber.join(fiber));
      expect(logger.entries).toEqual([
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('requires PORT'),
        }),
      ]);
    }
  );

  it('never starts the listener in packaged builds', async () => {
    vi.stubEnv('PORT', '43210');
    const { logger, fiber } = await start(true);
    await Effect.runPromise(Fiber.join(fiber));
    expect(logger.entries).toEqual([]);
  });
});
