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

  const openCloudApp = async (
    signupAt?: string,
    { userTour = true, replayRetired = false, welcomeVideo = false } = {}
  ): Promise<Page> => {
    const {
      ACCOUNT_EXPERIENCE_DEFAULTS,
      LANGUAGE_PREFERENCE_DEFAULTS,
      TRANSCRIPTION_PREFERENCE_DEFAULTS,
      UpdateUserPreferencesRequestSchema,
      UserPreferencesSchema,
    } = await import('@prismical/api-contracts/apps/v1');
    let preferences = UserPreferencesSchema.parse({
      ...ACCOUNT_EXPERIENCE_DEFAULTS,
      onboarding: { ...ACCOUNT_EXPERIENCE_DEFAULTS.onboarding, replayRetired },
      language: LANGUAGE_PREFERENCE_DEFAULTS,
      transcription: TRANSCRIPTION_PREFERENCE_DEFAULTS,
    });
    server = await startFakeOAuthServer({
      signupAt,
      integrationsEnabled: false,
      userTourEnabled: userTour,
      welcomeVideoEnabled: welcomeVideo,
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
    // A real cross-origin frame request exercises Electron's CSP without depending on the player.
    await page.route('https://livid.com/embed/**', route =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><body style="background:#101827;color:white">Getting started player</body></html>',
      })
    );
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
    await page.getByRole('menuitem', { name: 'Quick start tour', exact: true }).click();
    await expect(page.locator('.prismical-tour')).toContainText('Create a note from the dock');
  };

  test('recent Cloud account uses its verified signup date for the welcome', async () => {
    const page = await openCloudApp(new Date(Date.now() - 60_000).toISOString(), {
      welcomeVideo: true,
    });
    const welcome = page.getByRole('dialog', { name: 'Welcome to your AI Note taker' });
    await expect(welcome).toBeVisible();
    await expect(page.getByRole('dialog', { name: "Here's how Prismical works" })).toHaveCount(0);
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

  test('Cloud accounts do not show the welcome or Help replay when the tour is disabled', async () => {
    const page = await openCloudApp(new Date(Date.now() - 60_000).toISOString(), {
      userTour: false,
    });
    await expect(page.getByRole('dialog', { name: 'Welcome to your AI Note taker' })).toHaveCount(
      0
    );
    await page.getByRole('button', { name: 'Help and support', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Quick start tour', exact: true })).toHaveCount(
      0
    );
    await expect(page.locator('.prismical-tour')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: "Here's how Prismical works" })).toHaveCount(0);
  });

  test('existing Cloud account sees the video once, loads its frame, and can watch again from Help', async () => {
    const page = await openCloudApp('2025-01-01T00:00:00.000Z', {
      userTour: false,
      welcomeVideo: true,
    });
    const welcome = page.getByRole('dialog', { name: "Here's how Prismical works" });
    await expect(welcome).toBeVisible();
    await expect(page.frameLocator('iframe').getByText('Getting started player')).toBeVisible();
    await expect(welcome.getByRole('link', { name: 'iOS', exact: true })).toBeVisible();
    await expect(welcome.getByRole('link', { name: 'Android', exact: true })).toBeVisible();
    await expect(welcome.getByRole('button', { name: 'macOS', exact: true })).toHaveCount(0);
    await expect(welcome.getByRole('link', { name: 'Windows', exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        server!.requests.some(
          request =>
            request.method === 'PATCH' &&
            request.path === '/apps/v1/me/preferences' &&
            (request.body as { welcome?: { seen?: boolean } })?.welcome?.seen === true
        )
      )
      .toBe(true);

    await launched!.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find(window => window.webContents.getURL().includes('#/home'))!
        .setSize(800, 480);
    });
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect
        .poll(() => page.locator('html').evaluate(element => element.classList.contains('dark')))
        .toBe(theme === 'dark');
      await expect(welcome.getByRole('button', { name: 'Close', exact: true })).toBeInViewport({
        ratio: 1,
      });
      await expect(welcome.getByRole('link', { name: 'Android', exact: true })).toBeInViewport({
        ratio: 1,
      });
      await page.screenshot({
        path: test.info().outputPath(`welcome-${theme}.png`),
        animations: 'disabled',
      });
    }
    await page.keyboard.press('Escape');
    await expect(welcome).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    await expect(welcome).toHaveCount(0);

    const userDataDir = launched!.userDataDir;
    await closePrismical(launched, { keepProfile: true });
    launched = await launchPrismical({
      PRISMICAL_CORE_API_URL: server!.origin,
      PRISMICAL_CLIENT_ID: 'desktop-e2e-client',
      PRISMICAL_E2E_USER_DATA_DIR: userDataDir,
    });
    const restored = await mainPage();
    await expect(restored.getByTestId('desktop-shell')).toBeVisible();
    await expect(restored.getByRole('dialog', { name: "Here's how Prismical works" })).toHaveCount(
      0
    );
    await launched.app.evaluate(({ shell }) => {
      const urls: string[] = [];
      (globalThis as unknown as { welcomeUrls: string[] }).welcomeUrls = urls;
      shell.openExternal = async url => {
        urls.push(url);
      };
    });
    await restored.getByRole('button', { name: 'Help and support', exact: true }).click();
    await restored.getByRole('menuitem', { name: 'Watch quick start', exact: true }).click();
    await expect
      .poll(() =>
        launched!.app.evaluate(
          () => (globalThis as unknown as { welcomeUrls: string[] }).welcomeUrls
        )
      )
      .toEqual(['https://link.prismical.ai/watch-getting-started']);
  });

  test('new Cloud account can close the welcome video with its close control', async () => {
    const page = await openCloudApp(new Date(Date.now() - 60_000).toISOString(), {
      userTour: false,
      welcomeVideo: true,
    });
    const welcome = page.getByRole('dialog', { name: "Here's how Prismical works" });
    await expect(welcome).toBeVisible();
    await welcome.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(welcome).toHaveCount(0);
  });

  test('enabled Cloud replay remains available after completion and prior retirement', async () => {
    const page = await openCloudApp(undefined, { replayRetired: true });
    await startReplay(page);
    await page.getByRole('button', { name: 'Exit walkthrough' }).click();
    const completed = await page.evaluate(() =>
      window.desktop.transport.request({
        method: 'PATCH',
        path: '/apps/v1/me/preferences',
        body: { onboarding: { walkthrough: { status: 'completed' } } },
      })
    );
    expect(completed).toMatchObject({ ok: true });
    await page.reload();
    await startReplay(page);
    await page.getByRole('button', { name: 'Exit walkthrough' }).click();
    await expect(page.locator('.prismical-tour')).toHaveCount(0);
  });

  test('local mode and floating notes keep the optional tour disabled', async () => {
    launched = await launchPrismical({}, { seedMode: 'local' });
    const page = await mainPage();
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    await expect(page.getByRole('dialog', { name: "Here's how Prismical works" })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Welcome to your AI Note taker' })).toHaveCount(
      0
    );
    await page.getByRole('button', { name: 'Help and support', exact: true }).click();
    await expect(
      page.getByRole('menuitem', { name: 'Watch quick start', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Quick start tour', exact: true })).toHaveCount(
      0
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await expect(page).toHaveURL(/#\/notes\/nt_/);
    await expect(page.locator('.prismical-tour')).toHaveCount(0);
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
    await page.reload();
    await page.getByRole('button', { name: 'Help and support', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Quick start tour', exact: true })).toHaveCount(
      0
    );
  });
});
