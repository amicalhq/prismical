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

  const openCloudApp = async (signupAt?: string): Promise<Page> => {
    const {
      ACCOUNT_EXPERIENCE_DEFAULTS,
      LANGUAGE_PREFERENCE_DEFAULTS,
      TRANSCRIPTION_PREFERENCE_DEFAULTS,
      UpdateUserPreferencesRequestSchema,
      UserPreferencesSchema,
    } = await import('@prismical/api-contracts/apps/v1');
    let preferences = UserPreferencesSchema.parse({
      ...ACCOUNT_EXPERIENCE_DEFAULTS,
      language: LANGUAGE_PREFERENCE_DEFAULTS,
      transcription: TRANSCRIPTION_PREFERENCE_DEFAULTS,
    });
    server = await startFakeOAuthServer({
      signupAt,
      integrationsEnabled: false,
      appResponse: (url, request) => {
        if (url.pathname !== '/apps/v1/me/preferences') return undefined;
        if (request.method === 'PATCH') {
          const patch = UpdateUserPreferencesRequestSchema.parse(server!.requests.at(-1)?.body);
          preferences = UserPreferencesSchema.parse(
            Object.fromEntries(
              Object.entries(preferences).map(([group, saved]) => [
                group,
                { ...saved, ...patch[group as keyof typeof patch] },
              ])
            )
          );
        }
        // Every group is initialized; POST keeps the first saved choice, like core.
        return { status: 200, body: preferences };
      },
    });
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
    return page;
  };

  const startReplay = async (page: Page) => {
    await page.getByRole('button', { name: 'Help and support', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Getting started', exact: true }).click();
    await expect(page.locator('.prismical-tour')).toContainText('Create a note from the dock');
  };

  test('recent Cloud account uses its verified signup date for the welcome', async () => {
    const page = await openCloudApp(new Date(Date.now() - 60_000).toISOString());
    const welcome = page.getByRole('dialog', { name: 'Welcome to your AI Note taker' });
    await expect(welcome).toBeVisible();
    await expect(welcome.getByRole('button', { name: 'Continue in desktop' })).toBeVisible();
    await expect(welcome.getByRole('button', { name: 'macOS', exact: true })).toHaveCount(0);
    await welcome.getByRole('button', { name: 'Maybe later' }).click();
    await page.reload();
    await startReplay(page);
    await expect(welcome).toHaveCount(0);
    await page.getByRole('button', { name: 'Exit walkthrough' }).click();
    await expect(page.locator('.prismical-tour')).toHaveCount(0);
  });

  for (const { account, signupAt } of [
    { account: 'existing', signupAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() },
    { account: 'legacy', signupAt: undefined },
  ]) {
    test(`${account} Cloud account can replay without an automatic welcome`, async () => {
      const page = await openCloudApp(signupAt);
      await startReplay(page);
      await expect(page.getByRole('dialog', { name: 'Welcome to your AI Note taker' })).toHaveCount(
        0
      );
      await page.getByRole('button', { name: 'Exit walkthrough' }).click();
      await expect(page.locator('.prismical-tour')).toHaveCount(0);
    });
  }

  test('local mode can start the guide manually and floating notes do not duplicate it', async () => {
    launched = await launchPrismical({}, { seedMode: 'local' });
    const page = await mainPage();
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Welcome to your AI Note taker' })).toHaveCount(
      0
    );
    await startReplay(page);
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
    await expect(floatPage.getByRole('button', { name: 'Help and support' })).toHaveCount(0);
    await expect(
      floatPage.getByRole('dialog', { name: 'Welcome to your AI Note taker' })
    ).toHaveCount(0);

    await floatPage.getByRole('button', { name: 'Dock back into app' }).click();
    await page.getByRole('button', { name: 'Exit walkthrough' }).click();
    for (let noteCount = 2; noteCount <= 3; noteCount += 1) {
      await page.getByRole('button', { name: 'Help and support', exact: true }).click();
      await expect(
        page.getByRole('menuitem', { name: 'Getting started', exact: true })
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        window.location.hash = '#/home';
      });
      await page.getByRole('button', { name: 'New note', exact: true }).click();
      await expect(page).toHaveURL(/#\/notes\/nt_/);
    }
    await page.reload();
    await page.getByRole('button', { name: 'Help and support', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Getting started', exact: true })).toHaveCount(
      0
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.desktop.transport.request({ method: 'GET', path: '/apps/v1/me/preferences' })
        )
      )
      .toMatchObject({ ok: true, bodyJson: { onboarding: { replayRetired: true } } });
    const deleted = await page.evaluate(() =>
      window.desktop.transport.request({
        method: 'DELETE',
        path: `/apps/v1/me/notes/${window.location.hash.replace('#/notes/', '')}`,
      })
    );
    expect(deleted).toMatchObject({ ok: true });
    await page.evaluate(() => {
      window.location.hash = '#/home';
    });
    await page.reload();
    await page.getByRole('button', { name: 'Help and support', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Getting started', exact: true })).toHaveCount(
      0
    );
  });
});
