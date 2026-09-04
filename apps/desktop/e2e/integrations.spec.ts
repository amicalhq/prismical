import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeOAuthServer, type FakeOAuthServer } from './helpers/fake-oauth';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

const CLIENT_ID = 'desktop-e2e-client';
const REDIRECT_URI = 'prismical://oauth/callback';

const pendingState = (page: Page): Promise<string | null> =>
  page.evaluate(() =>
    (
      window as never as {
        desktop: { e2e: { authPendingState: () => Promise<string | null> } };
      }
    ).desktop.e2e.authPendingState()
  );

const deliverOpenUrl = (app: ElectronApplication, url: string): Promise<void> =>
  app.evaluate(({ app: electronApp }, callbackUrl) => {
    electronApp.emit('open-url', { preventDefault: () => {} }, callbackUrl);
  }, url);

const routerHash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash);

test.describe('MCP integrations feature kill switch', () => {
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await server?.close();
    server = undefined;
  });

  test('keeps Automations available while MCP hides and returns after re-enable', async () => {
    server = await startFakeOAuthServer({ integrationsEnabled: true });
    launched = await launchPrismical({
      PRISMICAL_CORE_API_URL: server.origin,
      PRISMICAL_CLIENT_ID: CLIENT_ID,
    });
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await page.waitForLoadState('domcontentloaded');

    await page.getByTestId('auth-sign-in').click();
    await expect.poll(() => pendingState(page)).not.toBeNull();
    const state = String(await pendingState(page));
    await deliverOpenUrl(
      launched.app,
      `${REDIRECT_URI}?code=C1&state=${encodeURIComponent(state)}`
    );
    await expect(page.getByTestId('auth-gate')).toHaveAttribute('data-gate-state', 'signed-in');

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /Custom MCP server/ })).toBeVisible();
    await expect(page.getByText('Notion', { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('button')
        .filter({ hasText: 'Notion' })
        .locator('[data-integration-logo="notion"] svg')
    ).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Webhook/ })).toBeVisible();

    server.setIntegrationsEnabled(false);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /Custom MCP server/ })).toHaveCount(0);
    await expect(page.getByText('Notion', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Zapier', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Webhook/ })).toBeVisible();

    await page.evaluate(() => {
      window.location.hash = '#/settings/integrations/mcs_direct_e2e';
    });
    await expect.poll(() => routerHash(page)).toBe('#/settings/integrations');

    server.setIntegrationsEnabled(true);
    await page.reload();
    await expect(page.getByRole('button', { name: /Custom MCP server/ })).toBeVisible();
    await expect(page.getByText('Notion', { exact: true })).toBeVisible();
  });
});
