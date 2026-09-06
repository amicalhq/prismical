import { test, expect } from '@playwright/test';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

/**
 * Contract-enumeration gate at the preload boundary: the main window exposes
 * EXACTLY the typed surface from @prismical/desktop-contracts — nothing
 * generic, nothing extra. `e2e` is present because these runs set
 * PRISMICAL_E2E=1; production builds have no such key (the preload gates it
 * on the same env var that also gates the main-side channel).
 */
test.describe('main-window preload contract', () => {
  let launched: PrismicalLaunch;

  test.beforeEach(async () => {
    launched = await launchPrismical();
  });

  test.afterEach(async () => {
    await closePrismical(launched);
  });

  test('window.desktop exposes exactly the v1 contract surface', async () => {
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await page.waitForLoadState('domcontentloaded');

    const shape = await page.evaluate(() => {
      const desktop = (window as never as { desktop: Record<string, unknown> }).desktop;
      return {
        root: Object.keys(desktop).sort(),
        env: Object.keys(desktop.env as object).sort(),
        transport: Object.keys(desktop.transport as object).sort(),
        collab: Object.keys(desktop.collab as object).sort(),
        nav: Object.keys(desktop.nav as object).sort(),
        auth: Object.keys(desktop.auth as object).sort(),
        recording: Object.keys(desktop.recording as object).sort(),
        settings: Object.keys(desktop.settings as object).sort(),
        models: Object.keys(desktop.models as object).sort(),
        capabilities: Object.keys(desktop.capabilities as object).sort(),
        float: Object.keys(desktop.float as object).sort(),
        e2e: Object.keys(desktop.e2e as object).sort(),
        platform: desktop.platform,
      };
    });
    expect(shape.root).toEqual([
      'auth',
      'capabilities',
      'collab',
      'e2e',
      'env',
      'float',
      'models',
      'nav',
      'platform',
      'recording',
      'settings',
      'theme',
      'transport',
    ]);
    expect(shape.float).toEqual(['collapse', 'dockBack', 'onState', 'open']);
    expect(shape.env).toEqual(['get']);
    expect(shape.transport).toEqual(['openStream', 'request']);
    // The note-body log lane, exactly.
    expect(shape.collab).toEqual(['open']);
    expect(shape.nav).toEqual(['onPush']);
    expect(shape.auth).toEqual([
      'getCollabToken',
      'getSession',
      'onSessionChanged',
      'openWebSession',
      'signIn',
      'signOut',
      'switchAccount',
      'switchOrg',
    ]);
    // The native record button + live transcript surface, exactly.
    expect(shape.recording).toEqual(['claimCompletion', 'onStateChanged', 'pause', 'resume', 'start', 'stop']);
    // The device-settings read/write/observe surface, exactly.
    expect(shape.settings).toEqual(['get', 'onChanged', 'set']);
    // The local whisper model manager surface, exactly.
    expect(shape.models).toEqual(['cancelDownload', 'delete', 'download', 'getState', 'onStateChanged']);
    // Updater, BYOK-key, and AI-provider-key actions: the native action surface, exactly.
    expect(shape.capabilities).toEqual([
      'checkForUpdates',
      'chooseAppMode',
      'clearAiProviderKey',
      'clearTranscriptionByokKey',
      'dismissUpdatePrompt',
      'enableAppleCalendar',
      'exportLogs',
      'getAppModeState',
      'getAppleCalendarStatus',
      'getPermissionStatus',
      'getUpdateState',
      'hasAiProviderKey',
      'hasTranscriptionByokKey',
      'listAiModels',
      'onUpdateState',
      'openSystemSettings',
      'refreshAppleCalendar',
      'requestPermission',
      'resetApp',
      'restartApp',
      'restartToUpdate',
      'setAiProviderKey',
      'setTranscriptionByokKey',
    ]);
    expect(shape.e2e).toEqual([
      'authAuthorizeUrl',
      'authPendingState',
      'recording',
      'sessionProbe',
      'streamStats',
    ]);
    expect(shape.platform).toBe(process.platform);
  });

  test('env:get serves the renderer-safe descriptor (no core endpoint)', async () => {
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');

    const env = await page.evaluate(() =>
      (window as never as { desktop: { env: { get: () => Promise<unknown> } } }).desktop.env.get()
    );
    expect(Object.keys(env as object).sort()).toEqual([
      'analyticsHost',
      'analyticsKey',
      'appMode',
      'appVersion',
      'applicationLocale',
      'noteWsUrl',
      'platform',
      'systemLocale',
      'webAppOrigin',
    ]);
    const typed = env as {
      noteWsUrl: string;
      webAppOrigin: string;
      analyticsKey: string | null;
      analyticsHost: string | null;
      platform: string;
      appVersion: string;
      applicationLocale: string;
      systemLocale: string;
    };
    expect(['en', 'de', 'es', 'ja', 'zh-TW']).toContain(typed.applicationLocale);
    expect(typed.systemLocale).toBe(typed.applicationLocale);
    expect(typed.noteWsUrl).toMatch(/^wss:\/\//);
    expect(typed.webAppOrigin).toMatch(/^https:\/\//);
    // Analytics config is gated off under E2E (no telemetry from tests).
    expect(typed.analyticsKey).toBeNull();
    expect(typed.analyticsHost).toBeNull();
    expect(typed.platform).toBe(process.platform);
    expect(typed.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    // The renderer never learns core's address.
    expect(JSON.stringify(env)).not.toContain('core');
  });

  test('the updater-disabled E2E build reports an explicit disabled state', async () => {
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');

    const updater = await page.evaluate(async () => {
      const capabilities = (
        window as never as {
          desktop: {
            capabilities: {
              checkForUpdates: () => Promise<unknown>;
              getUpdateState: () => Promise<unknown>;
            };
          };
        }
      ).desktop.capabilities;
      const [check, view] = await Promise.all([
        capabilities.checkForUpdates(),
        capabilities.getUpdateState(),
      ]);
      return { check, view };
    });

    expect(updater.check).toEqual({ status: 'disabled' });
    expect(updater.view).toEqual({
      status: 'disabled',
      staged: false,
      stagedVersion: null,
      prompt: null,
    });
  });

  test('models:getState serves the offline catalogue snapshot (nothing installed, no URLs)', async () => {
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');

    const state = await page.evaluate(() =>
      (
        window as never as { desktop: { models: { getState: () => Promise<unknown> } } }
      ).desktop.models.getState()
    );
    expect(Object.keys(state as object).sort()).toEqual(['models', 'modelsDir']);
    const typed = state as {
      models: Array<{
        id: string;
        recommended: boolean;
        installed: boolean;
        download: unknown;
        kind: string;
      }>;
      modelsDir: string;
    };
    // A fresh e2e profile: the whole catalogue, nothing installed, nothing in
    // flight, and the weights dir inside the (isolated) profile.
    expect(typed.models.map(m => m.id)).toEqual([
      'whisper-base-en',
      'whisper-tiny',
      'whisper-base',
      'whisper-small',
      'whisper-medium',
      'whisper-large-v3',
      'whisper-large-v3-turbo',
      'silero-vad-v5',
    ]);
    expect(typed.models.filter(m => m.recommended).map(m => m.id)).toEqual(['whisper-base-en']);
    expect(typed.models.every(m => !m.installed && m.download === null)).toBe(true);
    // Seven whisper rows plus the one VAD entry (the settings screen
    // filters on kind, so its list still shows exactly the seven).
    expect(typed.models.filter(m => m.kind === 'whisper')).toHaveLength(7);
    expect(typed.models.filter(m => m.kind === 'vad').map(m => m.id)).toEqual(['silero-vad-v5']);
    expect(typed.modelsDir).toMatch(/models$/);
    // The download URLs never cross the membrane.
    expect(JSON.stringify(state)).not.toContain('http');
  });

  test('transport:request enforces the /apps/v1/me allowlist and dispatches into the CoreClient', async () => {
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');

    const call = (payload: unknown) =>
      page.evaluate(
        request =>
          (
            window as never as {
              desktop: { transport: { request: (r: unknown) => Promise<unknown> } };
            }
          ).desktop.transport.request(request),
        payload
      );

    // All three gates run before dispatch: foreign paths and malformed payloads
    // never reach the CoreClient.
    await expect(call({ method: 'GET', path: '/v1/other' })).resolves.toEqual({
      error: { code: 'PATH_NOT_ALLOWED' },
    });
    await expect(call({ method: 'GET', path: '/apps/v1/meow' })).resolves.toEqual({
      error: { code: 'PATH_NOT_ALLOWED' },
    });
    await expect(call({ bogus: 1 })).resolves.toEqual({ error: { code: 'INVALID_REQUEST' } });
    // An allowlisted request now dispatches into the CoreClient. This app is
    // signed OUT (no fake server here), so the session-current accessor reads
    // None and settles the reserved INTERNAL envelope — no fetch, no throw. The
    // signed-in fetch path (Bearer + org headers, {ok,status,bodyJson}) is
    // exercised against the fake core in auth.spec.
    await expect(call({ method: 'GET', path: '/apps/v1/me' })).resolves.toEqual({
      error: { code: 'INTERNAL' },
    });
  });
});
