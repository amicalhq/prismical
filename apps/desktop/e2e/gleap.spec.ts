import { test, expect } from '@playwright/test';
import { closePrismical, launchPrismical, type PrismicalLaunch } from './helpers/launch';

let launched: PrismicalLaunch | undefined;
test.afterEach(async () => {
  if (launched) await closePrismical(launched);
  launched = undefined;
});

for (const mode of ['local', null] as const) {
  test(`Gleap stays unloaded with a configured key in ${mode ?? 'unchosen'} mode`, async () => {
    launched = await launchPrismical({ GLEAP_KEY: 'configured-test-key' }, { seedMode: mode });
    const page = await launched.app.firstWindow();
    await expect(page.locator(mode === 'local' ? '[data-testid="desktop-shell"]' : '[data-testid="onboarding-continue"]')).toBeVisible();
    const support = await page.evaluate(() => ({
      resources: performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /gleap/i.test(url)),
      frames: document.querySelectorAll('iframe[src*="gleap.io"]').length,
    }));
    expect(support).toEqual({ resources: [], frames: 0 });
    if (mode === 'local') {
      expect(await page.evaluate(async () => (await window.desktop.env.get()).gleap)).toBeNull();
    }
  });
}

test('live cloud support loads and opens without sending feedback', async () => {
  test.skip(!process.env.GLEAP_KEY, 'Set GLEAP_KEY to run the live SDK smoke test.');
  launched = await launchPrismical({ GLEAP_KEY: process.env.GLEAP_KEY! });
  const page = await launched.app.firstWindow();
  // Signed out cloud mode exposes the vendor launcher; no account or message is sent.
  const button = page.locator('.bb-feedback-button');
  await expect(button).toBeVisible({ timeout: 45_000 });
  await button.click();
  const frame = page.frameLocator('iframe[src*="messenger-app.gleap.io"]');
  await expect(frame.locator('body')).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator('body')).not.toHaveText('');
  const inlineAllowed = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__gleapInlineTest = true';
    document.body.append(script);
    return '__gleapInlineTest' in window;
  });
  expect(inlineAllowed).toBe(false);
});
