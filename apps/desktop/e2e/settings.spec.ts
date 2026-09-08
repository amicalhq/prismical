import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
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

const hasByokKey = (page: Page): Promise<boolean> =>
  page.evaluate(() =>
    (
      window as never as {
        desktop: { capabilities: { hasTranscriptionByokKey: () => Promise<boolean> } };
      }
    ).desktop.capabilities.hasTranscriptionByokKey()
  );

const readOptional = (file: string): Promise<Buffer> =>
  readFile(file).catch(() => Buffer.alloc(0));

/** A key that could only be in the DB/log because THIS test put it there. */
const BYOK_KEY = 'e2e-byok-sentinel-4c9d21';

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

  test('transcription engine + BYOK key round-trip through IPC and persist across restart', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(server);
    launched = opened.launch;
    const page = opened.page;
    await signIn(page, launched.app);
    await openPreferences(page);

    // The desktop-owned engine card renders through the
    // shared TranscriptionScreen's named slot; the stored default is cloud.
    await page.getByRole('link', { name: 'Transcription', exact: true }).click();
    await expect(page.getByTestId('transcription-engine')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Prismical Cloud' })).toBeChecked();

    await page.getByRole('radio', { name: 'On this device' }).click();
    await expect(page.getByRole('radio', { name: 'On this device' })).toBeChecked();
    await expect(page.getByRole('link', { name: 'Manage local models' })).toBeVisible();
    await expect
      .poll(() => transcriptionSetting(page))
      .toEqual({ engine: 'local', modelId: null, byokBaseUrl: null, byokModel: null });

    // BYOK: the non-secret fields ride DeviceSettings (one record, replaced
    // whole); the key rides the capability channel into the secure store.
    await page.getByRole('radio', { name: 'Your own API' }).click();
    await expect(page.getByTestId('byok-fields')).toBeVisible();
    await page.getByLabel('Base URL', { exact: true }).fill('https://byok.example/v1');
    await page.getByLabel('Base URL', { exact: true }).press('Enter');
    await page.getByLabel('Model', { exact: true }).fill('whisper-1');
    await page.getByLabel('Model', { exact: true }).press('Enter');
    await expect
      .poll(() => transcriptionSetting(page))
      .toEqual({
        engine: 'byok',
        modelId: null,
        byokBaseUrl: 'https://byok.example/v1',
        byokModel: 'whisper-1',
      });
    await expect(page.getByTestId('byok-key-status')).toHaveAttribute('data-has-key', 'false');
    await page.getByLabel('API key', { exact: true }).fill(BYOK_KEY);
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByTestId('byok-key-status')).toHaveAttribute('data-has-key', 'true');
    // The input is never pre-filled and the key never rides device settings.
    await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
    expect(await hasByokKey(page)).toBe(true);
    expect(JSON.stringify(await deviceSettings(page))).not.toContain(BYOK_KEY);

    const profileDir = launched.userDataDir;
    keptProfile = profileDir;
    await closePrismical(launched, { keepProfile: true });
    launched = undefined;

    // On disk (same discipline as auth-sentinel): the raw key is absent from the
    // operational DB and the main log, while the e2e-fake secure-store custody
    // payload IS present — the scan reads the very file that holds the secret.
    const dbBytes = Buffer.concat(
      await Promise.all([
        readFile(path.join(profileDir, 'operational.db')),
        readOptional(path.join(profileDir, 'operational.db-wal')),
        readOptional(path.join(profileDir, 'operational.db-shm')),
      ])
    );
    expect(dbBytes.length).toBeGreaterThan(0);
    expect(dbBytes.includes(BYOK_KEY, 0, 'utf8')).toBe(false);
    const credential = JSON.stringify({ baseUrl: 'https://byok.example/v1', key: BYOK_KEY });
    const custody = Buffer.from(`e2e:${credential}`, 'utf8').toString('base64');
    expect(dbBytes.includes(custody, 0, 'utf8')).toBe(true);
    const mainLog = await readFile(path.join(profileDir, 'logs', 'main.jsonl'), 'utf8');
    expect(mainLog.length).toBeGreaterThan(0);
    expect(mainLog).not.toContain(BYOK_KEY);

    const second = await openApp(server, profileDir);
    reopened = second.launch;
    const page2 = second.page;
    await expect(page2.getByTestId('auth-gate')).toHaveAttribute('data-gate-state', 'signed-in');
    await expect(page2.getByTestId('desktop-shell')).toBeVisible();
    await expect
      .poll(() => transcriptionSetting(page2))
      .toEqual({
        engine: 'byok',
        modelId: null,
        byokBaseUrl: 'https://byok.example/v1',
        byokModel: 'whisper-1',
      });
    expect(await hasByokKey(page2)).toBe(true);

    await openPreferences(page2);
    await page2.getByRole('link', { name: 'Transcription', exact: true }).click();
    await expect(page2.getByRole('radio', { name: 'Your own API' })).toBeChecked();
    await expect(page2.getByLabel('Base URL', { exact: true })).toHaveValue(
      'https://byok.example/v1'
    );
    await expect(page2.getByLabel('Model', { exact: true })).toHaveValue('whisper-1');
    await expect(page2.getByTestId('byok-key-status')).toHaveAttribute('data-has-key', 'true');

    // The port-level settings seed ensures that a renderer reload
    // recreates the preload push-buffer empty and main pushes settings:changed
    // only on a CHANGE, so without the subscribe-time get() seed the screen
    // would sit on DEFAULT settings and the next whole-record patch would wipe
    // the stored BYOK record. Reload, patch ONE field, assert the rest survive.
    await page2.reload();
    await expect(page2.getByTestId('desktop-shell')).toBeVisible();
    await expect(page2.getByTestId('transcription-engine')).toBeVisible();
    await expect(page2.getByRole('radio', { name: 'Your own API' })).toBeChecked();
    await page2.getByLabel('Model', { exact: true }).fill('whisper-2');
    await page2.getByLabel('Model', { exact: true }).press('Enter');
    await expect
      .poll(() => transcriptionSetting(page2))
      .toEqual({
        engine: 'byok',
        modelId: null,
        byokBaseUrl: 'https://byok.example/v1',
        byokModel: 'whisper-2',
      });

    await page2.getByRole('button', { name: 'Clear key' }).click();
    await expect(page2.getByTestId('byok-key-status')).toHaveAttribute('data-has-key', 'false');
    expect(await hasByokKey(page2)).toBe(false);
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
