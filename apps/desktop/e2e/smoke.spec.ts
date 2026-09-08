import { advanceToMode } from './helpers/onboarding';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

/**
 * The boot invariants:
 *
 *  - A FRESH profile (no `app:mode` row) boots into the first-run MODE CHOOSER —
 *    never a product shell, and no sign-in before a mode is chosen.
 *  - Choosing the Prismical account starts browser sign-in in the SAME
 *    process (the fresh install already booted in cloud mode) and persists the
 *    choice; a renderer reload does not resurface the chooser or restart sign-in.
 *  - Choosing on-device mode persists it and RESTARTS the app (the mode is
 *    immutable per process); the next boot is the accountless local shell.
 *  - A cloud-mode profile (what every other cloud spec launches into) boots
 *    into the sign-in gate — never a product shell pre-auth.
 *
 * Under isE2E main QUITS instead of relaunching (Playwright cannot follow
 * app.relaunch(), and an orphan would hold the profile's single-instance
 * lock), so the restart arms relaunch into the kept profile themselves.
 */

/** The raw `app:mode` row main persisted (AppModeLive matches it verbatim). */
const readAppModeRow = (userDataDir: string): string | undefined => {
  const db = new DatabaseSync(path.join(userDataDir, 'operational.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app:mode') as
      | { value: string }
      | undefined;
    return row?.value;
  } finally {
    db.close();
  }
};

const firstWindow = async (app: ElectronApplication): Promise<Page> => {
  const page = await app.firstWindow({ timeout: 60_000 });
  assertNotStaleDevBundle(page.url());
  await page.waitForLoadState('domcontentloaded');
  return page;
};

/** Main-process posture every boot must keep: isolated profile, right build, no visible windows. */
const assertPosture = async (launched: PrismicalLaunch): Promise<void> => {
  const { app, target, userDataDir } = launched;
  const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    isPackaged: electronApp.isPackaged,
    userData: electronApp.getPath('userData'),
    visibleWindows: BrowserWindow.getAllWindows().filter(w => w.isVisible()).length,
    focusedWindows: BrowserWindow.getAllWindows().filter(w => w.isFocused()).length,
    throttledWindows: BrowserWindow.getAllWindows().filter(w =>
      w.webContents.getBackgroundThrottling()
    ).length,
  }));
  expect(state.isPackaged).toBe(target === 'packaged');
  expect(state.userData).toBe(userDataDir);
  expect(state.visibleWindows).toBe(0);
  expect(state.focusedWindows).toBe(0);
  expect(state.throttledWindows).toBe(0);
};

test.describe('smoke', () => {
  let launched: PrismicalLaunch | undefined;
  /** A profile that outlived its first process (the restart arm); reaped even on failure. */
  let keptProfile: string | undefined;

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    if (keptProfile !== undefined) await rm(keptProfile, { recursive: true, force: true });
    keptProfile = undefined;
  });

  test('a fresh profile boots into the mode chooser (never a product shell or sign-in before a mode is chosen)', async () => {
    launched = await launchPrismical({}, { seedMode: null });
    const page = await firstWindow(launched.app);

    const chooser = page.getByTestId('mode-chooser');
    await expect(chooser).toBeVisible();
    await expect(chooser).toHaveAttribute('data-step', 'discovery');
    await expect(page.getByTestId('mode-chooser-brand')).toHaveText('Prismical');
    await expect(page.getByTestId('onboarding-continue')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'GitHub', exact: true })).toBeVisible();
    // No product shell, and the chooser OWNS the surface: the element under
    // its centre is the chooser's, not the gate's (which is mounted beneath —
    // a fresh install boots cloud by default — but must not be reachable).
    await expect(page.getByTestId('desktop-shell')).toHaveCount(0);
    const owner = await page.evaluate(() => {
      const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return element?.closest('[data-testid="mode-chooser"]') !== null;
    });
    expect(owner).toBe(true);
    // Nothing was chosen, so nothing was persisted.
    expect(readAppModeRow(launched.userDataDir)).toBeUndefined();

    await assertPosture(launched);
  });

  test('discovery validates Other, resumes saved progress, and keeps a skipped answer empty', async () => {
    launched = await launchPrismical({}, { seedMode: null });
    const page = await firstWindow(launched.app);
    await page.getByRole('button', { name: 'Other', exact: true }).click();
    await expect(page.getByTestId('onboarding-continue')).toBeDisabled();
    await page.getByRole('textbox').fill('A community newsletter');
    await page.getByTestId('onboarding-continue').click();
    await expect(page.getByTestId('mode-chooser')).toHaveAttribute('data-step', 'permissions');
    await page.reload();
    await expect(page.getByTestId('mode-chooser')).toHaveAttribute('data-step', 'permissions');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('textbox')).toHaveValue('A community newsletter');
    await page.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await page.getByTestId('onboarding-continue').click();
    await expect(page.getByTestId('mode-chooser')).toHaveAttribute('data-step', 'mode');
    const progress = await page.evaluate(
      async () => (await window.desktop.settings.get()).onboarding
    );
    expect(progress).toEqual({ step: 'mode', discoverySource: null, discoveryDetails: '' });
    await page.reload();
    await expect(page.getByTestId('mode-chooser')).toHaveAttribute('data-step', 'mode');
  });

  test('choosing the Prismical account starts sign-in directly, persists, and survives a reload', async () => {
    launched = await launchPrismical(
      { PRISMICAL_CLIENT_ID: 'desktop-e2e-client' },
      { seedMode: null }
    );
    const page = await firstWindow(launched.app);
    await expect(page.getByTestId('mode-chooser')).toBeVisible();

    await advanceToMode(page);
    await page.getByTestId('mode-choose-cloud').click();

    // One click starts the PKCE flow and reveals the browser-pending surface.
    await expect(page.getByTestId('mode-chooser')).toHaveCount(0);
    const gate = page.getByTestId('auth-gate');
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute('data-mode', 'pending');
    await expect(gate).toHaveAttribute('data-gate-state', 'signing-in');
    await expect(page.getByTestId('auth-brand')).toHaveText('Prismical');
    await expect(page.getByTestId('auth-sign-in')).toHaveCount(0);
    const pendingState = () => page.evaluate(() => window.desktop.e2e!.authPendingState());
    const state = await pendingState();
    expect(state).not.toBeNull();
    await expect(page.getByTestId('desktop-shell')).toHaveCount(0);
    expect(readAppModeRow(launched.userDataDir)).toBe('cloud');

    // A renderer reload re-asks main for the mode state — chosen, so the gate
    // (not the chooser) comes back.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('auth-gate')).toHaveAttribute('data-mode', 'pending');
    await expect(page.getByTestId('mode-chooser')).toHaveCount(0);
    expect(await pendingState()).toBe(state);
  });

  test('a first-run sign-in failure shows the auth notice and allows retry', async () => {
    launched = await launchPrismical({ PRISMICAL_CLIENT_ID: '' }, { seedMode: null });
    const page = await firstWindow(launched.app);

    await advanceToMode(page);
    await page.getByTestId('mode-choose-cloud').click();

    await expect(page.getByTestId('mode-chooser')).toHaveCount(0);
    await expect(page.getByTestId('auth-gate')).toHaveAttribute('data-mode', 'gate');
    await expect(page.getByTestId('auth-notice')).toHaveAttribute('data-kind', 'error');
    await expect(page.getByTestId('auth-sign-in')).toBeEnabled();
    await page.getByTestId('auth-sign-in').click();
    await expect(page.getByTestId('auth-notice')).toHaveAttribute('data-kind', 'error');
    expect(readAppModeRow(launched.userDataDir)).toBe('cloud');
  });

  test('choosing on-device mode restarts into the accountless local shell', async () => {
    const first = await launchPrismical({}, { seedMode: null });
    // Tracked until it has exited, so a failure before the relaunch still reaps it.
    launched = first;
    const page = await firstWindow(first.app);
    await expect(page.getByTestId('mode-chooser')).toBeVisible();

    await advanceToMode(page);

    // Main persists the choice and (under isE2E) quits instead of relaunching.
    const exited = first.app.waitForEvent('close');
    await page.getByTestId('mode-choose-local').click();
    await exited;
    launched = undefined;
    keptProfile = first.userDataDir;
    expect(readAppModeRow(first.userDataDir)).toBe('local');

    // The relaunch this spec drives is the one main would have done.
    launched = await launchPrismical({ PRISMICAL_E2E_USER_DATA_DIR: first.userDataDir });
    keptProfile = undefined; // closePrismical reaps it now
    const shellPage = await firstWindow(launched.app);
    await expect(shellPage.getByTestId('desktop-shell')).toBeVisible();
    await expect(shellPage.getByTestId('mode-chooser')).toHaveCount(0);
    await expect(shellPage.getByTestId('auth-gate')).toHaveCount(0);
    await expect(shellPage.getByTestId('desktop-workspace-footer')).toBeVisible();
    // The local workspace mounts on the lifecycle's first emission — a beat
    // after the shell paints — so poll the probe rather than read it once.
    const probe = () =>
      shellPage.evaluate(() =>
        (
          window as never as {
            desktop: {
              e2e: {
                sessionProbe: () => Promise<{ acquires: number; pinned: unknown }>;
              };
            };
          }
        ).desktop.e2e.sessionProbe()
      );
    await expect.poll(probe).toMatchObject({ acquires: 1, pinned: null });
    await assertPosture(launched);
  });

  test('a cloud-mode profile boots into the sign-in gate (never a product shell pre-auth)', async () => {
    launched = await launchPrismical();
    const page = await firstWindow(launched.app);

    // The renderer mounted AND the auth IPC round-trip completed: the gate
    // renders only after getSession resolves through the preload bridge.
    const gate = page.getByTestId('auth-gate');
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute('data-mode', 'gate');
    await expect(gate).toHaveAttribute('data-gate-state', 'signed-out');
    await expect(page.getByTestId('auth-brand')).toHaveText('Prismical');
    await expect(page.getByTestId('auth-sign-in')).toBeVisible();
    // A chosen-cloud profile shows the gate, never a signed-in surface
    // and never the first-run chooser.
    await expect(page.getByTestId('auth-session')).toHaveCount(0);
    await expect(page.getByTestId('auth-account-email')).toHaveCount(0);
    await expect(page.getByTestId('mode-chooser')).toHaveCount(0);
    await expect(page.getByTestId('desktop-shell')).toHaveCount(0);

    await assertPosture(launched);
  });
});
