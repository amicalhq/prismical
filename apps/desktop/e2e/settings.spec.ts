import { rm } from 'node:fs/promises';
import type { ModelsStateView } from '@prismical/desktop-contracts';
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

const openApp = async (
  server: FakeOAuthServer,
  profileDir?: string
): Promise<{ launch: PrismicalLaunch; page: Page }> => {
  const launch = await launchPrismical({
    PRISMICAL_CORE_API_URL: server.origin,
    PRISMICAL_CLIENT_ID: CLIENT_ID,
    ...(profileDir === undefined ? {} : { PRISMICAL_E2E_USER_DATA_DIR: profileDir }),
  });
  const page = await launch.app.firstWindow({ timeout: 60_000 });
  assertNotStaleDevBundle(page.url());
  await page.waitForLoadState('domcontentloaded');
  return { launch, page };
};

const signIn = async (page: Page, app: ElectronApplication): Promise<void> => {
  const gate = page.getByTestId('auth-gate');
  await expect(gate).toHaveAttribute('data-mode', 'gate');
  await page.getByTestId('auth-sign-in').click();
  await expect.poll(() => pendingState(page)).not.toBeNull();
  const state = String(await pendingState(page));
  await deliverOpenUrl(app, `${REDIRECT_URI}?code=C1&state=${encodeURIComponent(state)}`);
  await expect(gate).toHaveAttribute('data-gate-state', 'signed-in');
  await expect(page.getByTestId('desktop-shell')).toBeVisible();
};

const openPreferences = async (page: Page): Promise<void> => {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByText('Manage your application preferences and settings.', { exact: true })
  ).toBeVisible();
};

const choose = async (page: Page, label: string, option: string): Promise<void> => {
  const select = page.getByRole('combobox', { name: label });
  await select.click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(select).toContainText(option);
};

interface DeviceSettingsSnapshot {
  widgetVisibility: string;
  meetingNotifications: boolean;
  dockContentProtection: boolean;
  updateChannel: string;
  telemetryOptOut: boolean;
}

const deviceSettings = (page: Page): Promise<DeviceSettingsSnapshot> =>
  page.evaluate(() =>
    (
      window as never as {
        desktop: { settings: { get: () => Promise<DeviceSettingsSnapshot> } };
      }
    ).desktop.settings.get()
  );

interface TranscriptionSettingSnapshot {
  engine: string;
  modelId: string | null;
  byokBaseUrl: string | null;
  byokModel: string | null;
}

const transcriptionSetting = (page: Page): Promise<TranscriptionSettingSnapshot> =>
  page.evaluate(() =>
    (
      window as never as {
        desktop: {
          settings: { get: () => Promise<{ transcription: TranscriptionSettingSnapshot }> };
        };
      }
    ).desktop.settings
      .get()
      .then(settings => settings.transcription)
  );

test.describe('native settings UI', () => {
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;
  let reopened: PrismicalLaunch | undefined;
  let keptProfile: string | undefined;

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await closePrismical(reopened);
    reopened = undefined;
    await Promise.all(
      [keptProfile]
        .filter((dir): dir is string => dir !== undefined)
        .map(dir => rm(dir, { recursive: true, force: true }))
    );
    keptProfile = undefined;
    await server?.close();
    server = undefined;
  });

  test('shows and retries a failed account interface-language save', async () => {
    const preferences = {
      language: { interfaceLanguage: 'en', aiOutputLanguage: 'source' },
      transcription: { language: 'hi' },
    };
    const responses: Record<string, () => { status: number; body: unknown }> = {
      'GET /apps/v1/me/preferences': () => ({ status: 200, body: preferences }),
      'PATCH /apps/v1/me/preferences': () => ({
        status: 500,
        body: { error: 'Injected save failure' },
      }),
    };
    server = await startFakeOAuthServer({
      appResponse: (url, request) => responses[`${request.method} ${url.pathname}`]?.(),
    });
    const opened = await openApp(server);
    launched = opened.launch;
    const page = opened.page;
    await signIn(page, launched.app);
    await openPreferences(page);
    const interfaceLanguage = page.getByRole('combobox', { name: 'Interface language' });
    await expect(interfaceLanguage).toBeEnabled();
    await interfaceLanguage.selectOption('de');
    const error = page.getByRole('alert').filter({
      hasText: 'Could not load or save your language preferences. Please try again.',
    });
    await expect(error).toBeVisible();
    await expect(interfaceLanguage).toHaveValue('en');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    const reads = () =>
      server!.requests.filter(
        request => request.path === '/apps/v1/me/preferences' && request.method === 'GET'
      ).length;
    const readsBeforeRetry = reads();
    await error.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.poll(reads).toBeGreaterThan(readsBeforeRetry);
    await expect(error).toHaveCount(0);
    await expect(interfaceLanguage).toHaveValue('en');

    responses['PATCH /apps/v1/me/preferences'] = () => {
      preferences.language.interfaceLanguage = 'de';
      return { status: 200, body: preferences };
    };
    await interfaceLanguage.selectOption('de');
    await expect(page.getByRole('alertdialog')).toContainText('Restart to change language');
    await page.getByRole('button', { name: 'Later', exact: true }).click();
    await expect(interfaceLanguage).toHaveValue('de');
    await expect(error).toHaveCount(0);
    await expect(page.getByText(/Currently Hindi\./)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('language-preferences.png') });
    expect(
      server.requests
        .filter(request => request.path === '/apps/v1/me/preferences' && request.method === 'PATCH')
        .map(request => request.body)
    ).toEqual([
      { language: { interfaceLanguage: 'de' } },
      { language: { interfaceLanguage: 'de' } },
    ]);
  });

  test('preferences and updater controls round-trip through IPC and persist across restart', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(server);
    launched = opened.launch;
    const page = opened.page;
    await signIn(page, launched.app);
    await openPreferences(page);

    // Desktop-only settings are genuinely mounted. Launch-at-login is asserted
    // but not toggled: an E2E test must not mutate the developer's OS login items.
    await expect(page.getByRole('switch', { name: 'Launch at login' })).toBeVisible();
    const notifications = page.getByRole('switch', {
      name: 'Meeting & call notifications',
    });
    const contentProtection = page.getByRole('switch', {
      name: 'Hide dock from screen sharing',
    });
    await expect(notifications).toBeChecked();
    await expect(contentProtection).not.toBeChecked();

    await choose(page, 'Show dock', 'Never');
    await notifications.click();
    await contentProtection.click();
    await expect(notifications).not.toBeChecked();
    await expect(contentProtection).toBeChecked();
    await expect
      .poll(() => deviceSettings(page))
      .toMatchObject({
        widgetVisibility: 'never',
        meetingNotifications: false,
        dockContentProtection: true,
        telemetryOptOut: true,
      });

    await page.getByRole('link', { name: 'About', exact: true }).click();
    await expect(
      page.getByText('Information about Prismical and useful resources.', { exact: true })
    ).toBeVisible();
    await expect(page.getByText(/^v\d+\.\d+\.\d+/)).toBeVisible();
    await choose(page, 'Update channel', 'Beta');
    await page.getByRole('button', { name: 'Check for updates' }).click();
    // Bundle e2e runs unpackaged ⇒ updaterEnabled=false ⇒ checkForUpdates
    // resolves the disabled lane. This assertion uses the current catalog copy.
    await expect(page.getByText('Updates are disabled in this build.')).toBeVisible();
    await expect.poll(() => deviceSettings(page)).toMatchObject({ updateChannel: 'beta' });

    const profileDir = launched.userDataDir;
    keptProfile = profileDir;
    await closePrismical(launched, { keepProfile: true });
    launched = undefined;

    const second = await openApp(server, profileDir);
    reopened = second.launch;
    const page2 = second.page;
    await expect(page2.getByTestId('auth-gate')).toHaveAttribute('data-gate-state', 'signed-in');
    await expect(page2.getByTestId('desktop-shell')).toBeVisible();
    await openPreferences(page2);

    await expect(page2.getByRole('combobox', { name: 'Show dock' })).toContainText('Never');
    await expect(
      page2.getByRole('switch', { name: 'Meeting & call notifications' })
    ).not.toBeChecked();
    await expect(
      page2.getByRole('switch', { name: 'Hide dock from screen sharing' })
    ).toBeChecked();

    await page2.getByRole('link', { name: 'About', exact: true }).click();
    await expect(page2.getByRole('combobox', { name: 'Update channel' })).toContainText('Beta');
    await expect
      .poll(() => deviceSettings(page2))
      .toMatchObject({
        widgetVisibility: 'never',
        meetingNotifications: false,
        dockContentProtection: true,
        updateChannel: 'beta',
        telemetryOptOut: true,
      });
    expect(server.refreshRequests()).toHaveLength(1);
  });

  test('AI Models and Local models keep selection and downloads separate from Transcription', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(server);
    launched = opened.launch;
    const page = opened.page;
    await signIn(page, launched.app);
    await openPreferences(page);

    await page.getByRole('link', { name: 'Transcription', exact: true }).click();
    await expect(page.getByTestId('transcription-engine')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Your own API' })).toHaveCount(0);
    await expect(page.getByTestId('byok-fields')).toHaveCount(0);

    await page.getByRole('link', { name: 'AI Models', exact: true }).click();
    await expect(page.getByTestId('local-models-list')).toHaveCount(0);
    await expect(page.getByTestId('transcription-provider')).toHaveCount(0);
    await expect(page.getByTestId('ai-provider')).toHaveCount(0);
    await page.getByRole('link', { name: 'Local models', exact: true }).click();
    await expect(page.getByTestId('local-models-list')).toBeVisible();
    await expect(page.getByTestId('local-model-row')).toHaveCount(7);
    await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(7);
    await expect
      .poll(() => transcriptionSetting(page))
      .toEqual({ engine: 'cloud', modelId: null, byokBaseUrl: null, byokModel: null });
  });

  test('AI Models reflects a manager selection and switches between installed and account models', async () => {
    server = await startFakeOAuthServer({
      appResponse: url => url.pathname === '/apps/v1/me/model-defaults'
        ? { status: 200, body: { transcription: null, formatting: null } }
        : undefined,
    });
    const opened = await openApp(server);
    launched = opened.launch;
    const page = opened.page;
    await signIn(page, launched.app);

    // Inject installed metadata at the model IPC boundary. This checks model
    // selection and persisted settings without downloading or running weights.
    const catalogue = await page.evaluate(() => (
      window as never as { desktop: { models: { getState: () => Promise<ModelsStateView> } } }
    ).desktop.models.getState());
    const installed = {
      ...catalogue,
      models: catalogue.models.map(model => model.id === 'whisper-tiny'
        ? { ...model, installed: true, installedAt: '2026-01-01T00:00:00Z' }
        : model),
    };
    await launched.app.evaluate(({ ipcMain, BrowserWindow }, snapshot) => {
      ipcMain.removeHandler('models:getState');
      ipcMain.handle('models:getState', () => snapshot);
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('models:stateChanged', snapshot);
      }
    }, installed);

    await openPreferences(page);
    await page.getByRole('link', { name: 'Local models', exact: true }).click();
    const tiny = page.getByTestId('local-model-row').filter({ hasText: 'Whisper Tiny' });
    await tiny.getByRole('button', { name: 'Use this model', exact: true }).click();
    await expect.poll(() => transcriptionSetting(page)).toMatchObject({
      engine: 'local', modelId: 'whisper-tiny',
    });
    await expect(tiny.getByTestId('local-model-active')).toBeVisible();

    await page.getByRole('link', { name: 'AI Models', exact: true }).click();
    await expect(page.getByTestId('local-models-list')).toHaveCount(0);
    const transcription = page.locator('[data-slot="card"]').filter({
      has: page.getByRole('heading', { name: 'Transcription', exact: true }),
    });
    await expect(transcription.getByText('Whisper Tiny', { exact: true })).toBeVisible();
    await expect(transcription.getByText('On this device', { exact: true })).toBeVisible();
    await transcription.getByRole('button', { name: 'Change model', exact: true }).click();
    const picker = page.getByRole('dialog');
    await expect(picker.getByRole('button', { name: /Whisper Tiny/ })).toBeVisible();
    await expect(picker.getByRole('button', { name: /Whisper Base/ })).toHaveCount(0);
    await picker.getByRole('button', { name: /Prismical Cloud.*Auto/ }).click();
    await expect(picker).toHaveCount(0);
    await expect.poll(() => transcriptionSetting(page)).toMatchObject({ engine: 'cloud' });
    await expect(transcription.getByText('Prismical Cloud · Auto', { exact: true })).toBeVisible();
    await expect(transcription.getByText('Whisper Tiny', { exact: true })).toHaveCount(0);

    await transcription.getByRole('button', { name: 'Change model', exact: true }).click();
    await picker.getByRole('button', { name: /Whisper Tiny/ }).click();
    await expect(picker).toHaveCount(0);
    await expect.poll(() => transcriptionSetting(page)).toMatchObject({
      engine: 'local', modelId: 'whisper-tiny',
    });
    await expect(transcription.getByText('Whisper Tiny', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Local models', exact: true }).click();
    await expect(tiny.getByTestId('local-model-active')).toBeVisible();
  });

  test('an owner can open billing on web with the active desktop organization', async () => {
    server = await startFakeOAuthServer({ integrationsEnabled: true });
    const opened = await openApp(server);
    launched = opened.launch;
    const page = opened.page;
    await signIn(page, launched.app);
    await openPreferences(page);

    await page.getByRole('link', { name: 'Billing', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Plans & billing' })).toBeVisible();
    await expect(
      // The catalog copy uses a TYPOGRAPHIC apostrophe (U+2019), so a straight
      // quote does not match it.
      page.getByText('Manage E2E Organization’s subscription securely in your browser.')
    ).toBeVisible();
    await page.getByRole('button', { name: 'Manage billing on web' }).click();

    await expect
      .poll(() => server?.count('/api/auth/handoff/web-session'))
      .toBe(1);
    const handoff = server.requests.find(
      request => request.path === '/api/auth/handoff/web-session'
    );
    expect(handoff?.body).toEqual({
      return: '/settings/billing',
      activeOrgId: 'org_e2e_1',
    });
    expect(handoff?.headers.authorization).toMatch(/^Bearer ey/);
  });

  test('a member cannot see or bypass the desktop billing handoff', async () => {
    server = await startFakeOAuthServer({
      integrationsEnabled: true,
      organizationRole: 'member',
    });
    const opened = await openApp(server);
    launched = opened.launch;
    const page = opened.page;
    await signIn(page, launched.app);
    await openPreferences(page);

    await expect(page.getByRole('link', { name: 'Billing', exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      window.location.hash = '#/settings/billing';
    });
    await expect(page.getByRole('heading', { name: 'Plans & billing' })).toBeVisible();
    await expect(
      page.getByText('Billing is available to organization owners and admins.')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Manage billing on web' })).toHaveCount(0);
    expect(server.count('/api/auth/handoff/web-session')).toBe(0);
  });
});
