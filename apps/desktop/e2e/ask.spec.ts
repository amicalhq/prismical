import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeOAuthServer, type FakeOAuthServer } from './helpers/fake-oauth';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

/**
 * Ask streams and cancels end to end through the REAL preload/IPC
 * path against the fake core: after a fake sign-in, the desktop transport opens
 * `POST /apps/v1/me/ask` in MAIN (Bearer + org stamped there), and core's
 * AI-SDK SSE bytes are forwarded VERBATIM across the MessagePort to a
 * `text/event-stream` Response. Proves: tokens stream and parse as SSE chunks;
 * cancel mid-stream settles the renderer reader AND interrupts the main producer
 * (the fake server sees the connection drop); tool-approval resume round-trips as
 * a fresh POST; and the Ask POST carried the Bearer id_token.
 */

const CLIENT_ID = 'desktop-e2e-client';
// Both test targets currently accept the production callback scheme.
const REDIRECT_URI = 'prismical://oauth/callback';

const authEnv = (server: FakeOAuthServer): Record<string, string> => ({
  PRISMICAL_CORE_API_URL: server.origin,
  PRISMICAL_CLIENT_ID: CLIENT_ID,
});

interface AskChunk {
  type: string;
  delta?: string;
  toolCallId?: string;
}

interface StreamStats {
  opened: number;
  active: number;
  completed: number;
  aborted: number;
}

interface SessionProbeSnapshot {
  acquires: number;
}

const pendingState = (page: Page): Promise<string | null> =>
  page.evaluate(() =>
    (
      window as never as {
        desktop: { e2e: { authPendingState: () => Promise<string | null> } };
      }
    ).desktop.e2e.authPendingState()
  );

const streamStats = (page: Page): Promise<StreamStats> =>
  page.evaluate(() =>
    (
      window as never as { desktop: { e2e: { streamStats: () => Promise<StreamStats> } } }
    ).desktop.e2e.streamStats()
  );

const acquires = (page: Page): Promise<number> =>
  page
    .evaluate(() =>
      (
        window as never as {
          desktop: { e2e: { sessionProbe: () => Promise<SessionProbeSnapshot> } };
        }
      ).desktop.e2e.sessionProbe()
    )
    .then(probe => probe.acquires);

const deliverOpenUrl = (app: ElectronApplication, url: string): Promise<void> =>
  app.evaluate(({ app: electronApp }, callbackUrl) => {
    electronApp.emit('open-url', { preventDefault: () => {} }, callbackUrl);
  }, url);

const openApp = async (
  server: FakeOAuthServer
): Promise<{ launch: PrismicalLaunch; page: Page }> => {
  const launch = await launchPrismical(authEnv(server));
  const page = await launch.app.firstWindow({ timeout: 60_000 });
  assertNotStaleDevBundle(page.url());
  await page.waitForLoadState('domcontentloaded');
  return { launch, page };
};

/** Sign in via the parked PKCE attempt + open-url callback, then wait for the
 *  SignedInRuntime (its CoreClient must be registered before the Ask stream). */
const signIn = async (page: Page, app: ElectronApplication): Promise<void> => {
  const gate = page.getByTestId('auth-gate');
  await expect(gate).toHaveAttribute('data-mode', 'gate');
  await page.getByTestId('auth-sign-in').click();
  await expect.poll(() => pendingState(page)).not.toBeNull();
  const state = String(await pendingState(page));
  await deliverOpenUrl(app, `${REDIRECT_URI}?code=C1&state=${encodeURIComponent(state)}`);
  await expect(gate).toHaveAttribute('data-gate-state', 'signed-in');
  await expect.poll(() => acquires(page)).toBeGreaterThanOrEqual(1);
};

test.describe('Ask streaming lane', () => {
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;

  test.beforeEach(async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(server);
    launched = opened.launch;
    await signIn(opened.page, launched.app);
  });

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await server?.close();
    server = undefined;
  });

  test('streams AI-SDK SSE tokens as text/event-stream, Bearer id_token on the POST', async () => {
    const page = await launched!.app.firstWindow();

    const result = await page.evaluate(async () => {
      const testApi = (
        window as never as {
          __desktopStreamTest: {
            open: (request: unknown) => {
              opened: Promise<unknown>;
              response: Promise<Response>;
            };
            collect: (
              handle: unknown,
              until: (events: Array<{ type: string }>) => boolean
            ) => Promise<Array<{ type: string; delta?: string }>>;
          };
        }
      ).__desktopStreamTest;

      const handle = testApi.open({
        method: 'POST',
        path: '/apps/v1/me/ask',
        body: { messages: [{ role: 'user', content: 'hi' }] },
      });
      await handle.opened;
      const response = await handle.response;
      const contentType = response.headers.get('content-type');
      const events = await testApi.collect(handle, evts => evts.some(e => e.type === '[DONE]'));
      return { contentType, events };
    });

    // The shim marked the port body as SSE so the AI-SDK transport parses it.
    expect(result.contentType).toBe('text/event-stream');
    const chunks = result.events as AskChunk[];
    // The SSE parsed into AI-SDK UI-message-stream chunks: start … deltas … [DONE].
    expect(chunks[0]).toEqual({ type: 'start' });
    expect(chunks.at(-1)).toEqual({ type: '[DONE]' });
    const text = chunks
      .filter(c => c.type === 'text-delta')
      .map(c => c.delta ?? '')
      .join('');
    expect(text).toBe('Hello from Prismical');

    // Main stamped the Bearer id_token on the Ask POST (the renderer never sees a
    // token). The fake core recorded exactly the header it received.
    const askReq = server!.requests.find(r => r.method === 'POST' && r.path === '/apps/v1/me/ask');
    expect(askReq).toBeDefined();
    expect(askReq?.headers['authorization']).toBe(`Bearer ${server!.minted[0].idToken}`);
    expect(askReq?.headers['x-prismical-ask-error-format']).toBe('envelope');
    expect(askReq?.headers['x-prismical-locale']).toBe('en');
    expect(server!.askConnections).toHaveLength(1);
    expect(server!.askConnections[0]).toMatchObject({ finished: true, aborted: false });
  });

  test('cancel mid-stream settles the reader AND drops the core connection', async () => {
    const page = await launched!.app.firstWindow();

    const drained = await page.evaluate(async () => {
      const testApi = (
        window as never as {
          __desktopStreamTest: {
            open: (request: unknown) => { opened: Promise<unknown>; abort: () => void };
            collect: (
              handle: unknown,
              until: (events: Array<{ type: string }>) => boolean
            ) => Promise<unknown>;
          };
        }
      ).__desktopStreamTest;

      const handle = testApi.open({
        method: 'POST',
        path: '/apps/v1/me/ask',
        body: { messages: [{ role: 'user', content: 'hi' }], variant: 'slow' },
      });
      await handle.opened;
      // Take the first streamed token, then cancel during the (long) gap.
      await testApi.collect(handle, evts => evts.some(e => e.type === 'text-delta'));
      handle.abort();
      // Renderer proof: reading AFTER abort reaches a terminal state (controller
      // closed) — it drains, it does not hang.
      return Promise.race([
        testApi.collect(handle, () => false).then(() => 'drained'),
        new Promise<string>(resolve => setTimeout(() => resolve('hung'), 8_000)),
      ]);
    });
    expect(drained).toBe('drained');

    // Main-side proof: the broker interrupted the producer fiber.
    await expect
      .poll(() => streamStats(page), { timeout: 10_000 })
      .toMatchObject({ opened: 1, aborted: 1, active: 0, completed: 0 });

    // Core-side proof: the fake server saw the Ask connection drop mid-stream
    // (the interrupted producer aborted the fetch).
    await expect
      .poll(() => server!.askConnections.some(c => c.aborted && !c.finished), { timeout: 10_000 })
      .toBe(true);
  });

  test('tool-approval resume round-trips as a fresh POST', async () => {
    const page = await launched!.app.firstWindow();

    const result = await page.evaluate(async () => {
      const testApi = (
        window as never as {
          __desktopStreamTest: {
            open: (request: unknown) => { opened: Promise<unknown> };
            collect: (
              handle: unknown,
              until: (events: Array<{ type: string }>) => boolean
            ) => Promise<Array<{ type: string }>>;
          };
        }
      ).__desktopStreamTest;

      // POST #1: the assistant turn pauses on a tool needing approval.
      const first = testApi.open({
        method: 'POST',
        path: '/apps/v1/me/ask',
        body: { messages: [{ role: 'user', content: 'do a thing' }], variant: 'approval' },
      });
      await first.opened;
      const requested = await testApi.collect(first, evts => evts.some(e => e.type === '[DONE]'));

      // POST #2: approval granted → the continuation streams (a fresh stream, as
      // DefaultChatTransport drives approval-resume — not a same-port resume).
      const second = testApi.open({
        method: 'POST',
        path: '/apps/v1/me/ask',
        body: {
          messages: [{ role: 'user', content: 'do a thing' }],
          variant: 'approval',
          resume: true,
        },
      });
      await second.opened;
      const resumed = await testApi.collect(second, evts => evts.some(e => e.type === '[DONE]'));
      return { requested, resumed };
    });

    const requested = result.requested as AskChunk[];
    const resumed = result.resumed as AskChunk[];
    // Turn 1 requested approval (a tool chunk) and produced NO answer text yet.
    expect(requested.some(c => c.type === 'tool-input-available')).toBe(true);
    expect(requested.some(c => c.type === 'text-delta')).toBe(false);
    // Turn 2 (the resume POST) streamed the continuation text.
    expect(resumed.some(c => c.type === 'text-delta')).toBe(true);

    // Two distinct Ask POSTs completed — the resume was a fresh stream over the lane.
    expect(server!.askConnections).toHaveLength(2);
    expect(server!.askConnections.every(c => c.finished)).toBe(true);
  });
});
