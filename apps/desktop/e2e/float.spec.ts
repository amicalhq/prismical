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
const NOTE_ID = 'nt_e2e_float';

interface FloatState {
  open: boolean;
  noteId: string | null;
}

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

const latestFloatState = (page: Page): Promise<FloatState | null> =>
  page.evaluate(
    () => (window as never as { __floatStates?: FloatState[] }).__floatStates?.at(-1) ?? null
  );

test.describe('floating note window', () => {
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;

  test.beforeEach(async () => {
    server = await startFakeOAuthServer();
    launched = await launchPrismical({
      PRISMICAL_CORE_API_URL: server.origin,
      PRISMICAL_CLIENT_ID: CLIENT_ID,
    });
  });

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await server?.close();
    server = undefined;
  });

  test('opens, collapses without losing its slot, reopens, and docks back', async () => {
    const page = await launched!.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await page.waitForLoadState('domcontentloaded');
    await signIn(page, launched!.app);

    await page.evaluate(() => {
      const target = window as never as {
        __floatStates?: FloatState[];
        desktop: {
          float: { onState: (listener: (state: FloatState) => void) => () => void };
        };
      };
      target.__floatStates = [];
      target.desktop.float.onState(state => target.__floatStates!.push(state));
    });

    await page.evaluate(noteId => window.desktop.float.open(noteId), NOTE_ID);
    await expect.poll(() => launched!.app.windows().length).toBe(4);
    await expect.poll(() => latestFloatState(page)).toEqual({ open: true, noteId: NOTE_ID });

    const floatPage = launched!.app
      .windows()
      .find(candidate => candidate.url().includes('#/float'));
    expect(floatPage, 'floating note renderer').toBeDefined();
    await floatPage!.waitForLoadState('domcontentloaded');
    await expect(floatPage!.getByTestId('desktop-shell')).toHaveCount(0);
    await expect(floatPage!.getByRole('button', { name: 'Dock back into app' })).toBeVisible();
    await expect(floatPage!.getByRole('button', { name: 'New quick note' })).toBeVisible();
    await expect(floatPage!.getByRole('button', { name: 'Collapse to the pill' })).toBeVisible();

    await floatPage!.getByRole('button', { name: 'Collapse to the pill' }).click();
    await expect.poll(() => latestFloatState(page)).toEqual({ open: false, noteId: NOTE_ID });
    // Collapse is keep-alive: the same warm renderer remains registered.
    expect(launched!.app.windows()).toHaveLength(4);

    await page.evaluate(() => window.desktop.float.open(null));
    await expect.poll(() => latestFloatState(page)).toEqual({ open: true, noteId: NOTE_ID });
    expect(launched!.app.windows()).toHaveLength(4);

    await floatPage!.getByRole('button', { name: 'Dock back into app' }).click();
    await expect.poll(() => launched!.app.windows().length).toBe(3);
    await expect.poll(() => latestFloatState(page)).toEqual({ open: false, noteId: null });
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/notes/${NOTE_ID}`);
  });
});
