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

  test('creates and edits tags, rejects duplicate names, and persists the color', async () => {
    await page.getByRole('link', { name: 'View all tags' }).click();
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'New tag', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('work');
    await dialog.getByRole('button', { name: 'Create tag', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'work', exact: true })).toBeVisible();

    await main.getByRole('button', { name: 'New tag', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('WORK');
    await expect(dialog.getByRole('button', { name: 'Create tag', exact: true })).toBeDisabled();
    await expect(dialog.getByText('A tag called WORK already exists.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    await main.getByRole('button', { name: 'work options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit tag', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('roadmap');
    await dialog.getByRole('button', { name: 'Use color #a78bfa', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await expect(main.getByRole('link', { name: 'roadmap', exact: true })).toBeVisible();
    await main.getByRole('button', { name: 'roadmap options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit tag', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Use color #a78bfa', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await main.getByRole('link', { name: 'roadmap', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/notes\?tags=tag_/);
  });

  test('loads the note reading fonts from the packaged app', async () => {
    await page.getByRole('link', { name: 'View all folders' }).click();
    await expect(page.getByRole('main').getByRole('button', { name: 'New folder', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    const editor = page.locator('.note-prose');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill('A note with the shared reading font.');
    await expect.poll(() => editor.evaluate(element => getComputedStyle(element).fontFamily)).toContain('DM Sans');
    const loaded = await page.evaluate(async () => {
      const normal = await document.fonts.load('400 16px "DM Sans"');
      const italic = await document.fonts.load('italic 400 16px "DM Sans"');
      return [normal.length, italic.length];
    });
    expect(loaded).toEqual([1, 1]);
    await page.screenshot({ path: test.info().outputPath('note-reading-font.png') });
  });
});
