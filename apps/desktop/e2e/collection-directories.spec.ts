import { test, expect, type Page } from '@playwright/test';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

test.describe('local collection directories', () => {
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

  test('creates, finds, and opens a folder through its directory', async () => {
    await page.getByRole('link', { name: 'View all folders' }).click();
    await expect(page.getByRole('heading', { name: 'Folders', level: 1 }).last()).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'New folder', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Project notes');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const folder = page.getByRole('main').getByRole('link', { name: 'Project notes', exact: true });
    await expect(folder).toBeVisible();
    await page.getByPlaceholder('Search folders').fill('unmatched');
    await expect(page.getByText('No folders match your search')).toBeVisible();
    await page.getByPlaceholder('Search folders').fill('Project');
    await expect(folder).toBeVisible();
    await folder.click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/notes\?folder=fld_/);

    await page.getByRole('link', { name: 'View all folders' }).click();
    await page.reload();
    await expect(folder).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('folders-directory.png') });
  });
});
