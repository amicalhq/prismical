import { test, expect, type Page } from '@playwright/test';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

test.describe('local settings alignment', () => {
  let launched: PrismicalLaunch;
  let page: Page;

  test.beforeEach(async () => {
    launched = await launchPrismical({}, { seedMode: 'local' });
    page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
  });

  test.afterEach(async () => {
    await closePrismical(launched);
  });

  test('keeps the Name note rollout disabled while other skills remain available', async () => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Skills', exact: true }).click();
    const main = page.getByRole('main');
    await expect(main.getByText('Cleanup', { exact: true })).toBeVisible();
    await expect(main.getByText('Enhance', { exact: true })).toBeVisible();
    await expect(main.getByText('Name note', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    const editor = page.locator('.note-prose');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill('Content is present, but the naming feature remains gated.');
    await expect(page.getByRole('button', { name: 'Name with AI', exact: true })).toHaveCount(0);
  });
});
