import { test, expect, type Page } from '@playwright/test';
import { startFakeOAuthServer, type FakeOAuthServer } from './helpers/fake-oauth';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

test.describe('first-note onboarding', () => {
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await server?.close();
    server = undefined;
  });

  const mainPage = async (): Promise<Page> => {
    const page = await launched!.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await page.waitForLoadState('domcontentloaded');
    return page;
  };

  for (const account of ['recent', 'existing', 'legacy'] as const) {
    test(`${account} Cloud account uses its verified signup date for the welcome`, async () => {
      const signupAt =
        account === 'legacy'
          ? undefined
          : new Date(
              Date.now() - (account === 'recent' ? 60_000 : 7 * 24 * 60 * 60 * 1000)
            ).toISOString();
      server = await startFakeOAuthServer({ signupAt, integrationsEnabled: false });
      launched = await launchPrismical({
        PRISMICAL_CORE_API_URL: server.origin,
        PRISMICAL_CLIENT_ID: 'desktop-e2e-client',
      });
      const page = await mainPage();
      await page.getByTestId('auth-sign-in').click();
      await expect
        .poll(() => page.evaluate(() => window.desktop.e2e!.authPendingState()))
        .not.toBeNull();
      const state = await page.evaluate(() => window.desktop.e2e!.authPendingState());
      await launched.app.evaluate(
        ({ app }, callbackUrl) => {
          app.emit('open-url', { preventDefault: () => {} }, callbackUrl);
        },
        `prismical://oauth/callback?code=ONBOARDING&state=${encodeURIComponent(state!)}`
      );
      await expect(page.getByTestId('desktop-shell')).toBeVisible();
      await expect
        .poll(async () => {
          const session = await page.evaluate(() => window.desktop.auth.getSession());
          return session.accounts[0]?.signupAt ?? null;
        })
        .toBe(signupAt ?? null);

      // Replay appears only after the account's initial note list has settled.
      const replay = page.getByRole('button', { name: /Getting started/ });
      const welcome = page.getByRole('dialog', { name: 'Welcome to your AI Note taker' });
      if (account === 'recent') {
        await expect(welcome).toBeVisible();
        await welcome.getByRole('button', { name: 'Maybe later' }).click();
        await page.reload();
      }
      await expect(replay).toBeVisible();
      await expect(welcome).toHaveCount(0);
      await replay.click();
      await expect(page.locator('.prismical-tour')).toContainText('Create a note from the dock');
      await page.getByRole('button', { name: 'Exit walkthrough' }).click();
      await expect(page.locator('.prismical-tour')).toHaveCount(0);
    });
  }

  test('local mode can start the guide manually and floating notes do not duplicate it', async () => {
    launched = await launchPrismical({}, { seedMode: 'local' });
    const page = await mainPage();
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    await expect(page.getByRole('button', { name: /Getting started/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Welcome to your AI Note taker' })).toHaveCount(
      0
    );
    await page.getByRole('button', { name: /Getting started/ }).click();
    await expect(page.locator('.prismical-tour')).toContainText('Create a note from the dock');
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await expect(page).toHaveURL(/#\/notes\/nt_/);
    await expect(page.locator('.prismical-tour')).toContainText('Start recording');
    const noteId = new URL(page.url()).hash.replace('#/notes/', '');

    await page.evaluate(id => window.desktop.float.open(id), noteId);
    await expect
      .poll(() => launched!.app.windows().some(candidate => candidate.url().includes('#/float')))
      .toBe(true);
    const floatPage = launched.app
      .windows()
      .find(candidate => candidate.url().includes('#/float'))!;
    await expect(floatPage.getByRole('button', { name: 'Dock back into app' })).toBeVisible();
    await expect(floatPage.locator('.prismical-tour')).toHaveCount(0);
    await expect(floatPage.getByRole('button', { name: /Getting started/ })).toHaveCount(0);
    await expect(
      floatPage.getByRole('dialog', { name: 'Welcome to your AI Note taker' })
    ).toHaveCount(0);

    await floatPage.getByRole('button', { name: 'Dock back into app' }).click();
    await page.getByRole('button', { name: 'Exit walkthrough' }).click();
    for (let noteCount = 2; noteCount <= 3; noteCount += 1) {
      await expect(page.getByRole('button', { name: /Getting started/ })).toBeVisible();
      await page.evaluate(() => {
        window.location.hash = '#/home';
      });
      await page.getByRole('button', { name: 'New note', exact: true }).click();
      await expect(page).toHaveURL(/#\/notes\/nt_/);
    }
    await expect(page.getByRole('button', { name: /Getting started/ })).toHaveCount(0);
  });
});
