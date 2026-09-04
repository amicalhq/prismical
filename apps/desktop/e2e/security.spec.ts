import { test, expect } from '@playwright/test';
import { launchPrismical, closePrismical, type PrismicalLaunch } from './helpers/launch';

/**
 * Preload membrane controls, verified on the real renderer:
 *  - setPermissionRequestHandler allowlist (media/main-window only) denies
 *    geolocation;
 *  - the injected CSP's connect-src blocks foreign origins;
 *  - the privileged custom scheme serves root-absolute assets — the imported
 *    AudioWorklet file loads by absolute path.
 */
test.describe('security membrane', () => {
  let launched: PrismicalLaunch;

  test.beforeEach(async () => {
    launched = await launchPrismical();
  });

  test.afterEach(async () => {
    await closePrismical(launched);
  });

  test('geolocation permission requests are denied', async () => {
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');

    const outcome = await page.evaluate(
      () =>
        new Promise<string>(resolve => {
          navigator.geolocation.getCurrentPosition(
            () => resolve('granted'),
            error => resolve(`denied:${error.code}`),
            { timeout: 10_000 }
          );
        })
    );
    // GeolocationPositionError.PERMISSION_DENIED === 1
    expect(outcome).toBe('denied:1');
  });

  test('inline scripts do not execute under the custom-scheme CSP', async () => {
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');

    // The packaged/bundle renderer loads over prismical-app://; its CSP
    // (script-src 'self') must block an injected inline <script>. Proves the
    // CSP rides the protocol.handle response, not just webRequest.
    const executed = await page.evaluate(() => {
      const flag = window as unknown as { __inlineRan?: boolean };
      const script = document.createElement('script');
      script.textContent = 'window.__inlineRan = true;';
      document.body.appendChild(script);
      return flag.__inlineRan === true;
    });
    expect(executed).toBe(false);
  });

  test('CSP blocks renderer fetches to foreign origins', async () => {
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');

    const outcome = await page.evaluate(() =>
      fetch('https://example.com/', { method: 'GET' }).then(
        () => 'fetched',
        (error: unknown) => `blocked:${String(error)}`
      )
    );
    expect(outcome).toMatch(/^blocked:/);
  });

  test('root-absolute assets resolve through the custom scheme', async () => {
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');

    const result = await page.evaluate(async () => {
      const response = await fetch('/audio-recorder-processor.js');
      const body = await response.text();
      return { status: response.status, hasProcessor: body.includes('AudioRecorderProcessor') };
    });
    expect(result.status).toBe(200);
    expect(result.hasProcessor).toBe(true);
  });
});
