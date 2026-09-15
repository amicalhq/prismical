import { test, expect, type Page } from '@playwright/test';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

async function createNamedNote(page: Page, title: string) {
  await page
    .locator('[data-sidebar="sidebar"]')
    .getByRole('link', { name: 'Notes', exact: true })
    .click();
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await expect(page.locator('.note-prose')).toHaveAttribute('contenteditable', 'true');
  const field = page.getByRole('textbox', { name: 'Note title', exact: true }).first();
  await field.fill(title);
  await field.press('Enter');
}

test.describe('local collections in Notes', () => {
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

  test('creates a folder, filters Notes, and keeps the folder after reload', async () => {
    const sidebar = page.locator('[data-sidebar="sidebar"]');
    const main = page.getByRole('main');
    await sidebar.getByRole('link', { name: 'Notes', exact: true }).click();
    await expect(main.getByRole('heading', { name: 'Notes', level: 1 }).last()).toBeVisible();
    await main.getByRole('button', { name: 'New folder', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Project notes');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const folder = sidebar.getByRole('link', { name: 'Project notes', exact: true });
    await expect(folder).toBeVisible();
    await createNamedNote(page, 'Project planning');
    await page.getByRole('button', { name: 'Add to folder', exact: true }).click();
    await page.getByRole('option', { name: 'Project notes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Change folder', exact: true })).toContainText(
      'Project notes'
    );
    await createNamedNote(page, 'Unfiled note');
    await sidebar.getByRole('link', { name: 'Notes', exact: true }).click();
    await expect(main.getByRole('link', { name: 'Project planning', exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Unfiled note', exact: true })).toBeVisible();
    await folder.click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toMatch(/^#\/notes\?folder=fld_/);
    await expect(
      main.getByRole('heading', { name: 'Project notes', level: 1 }).last()
    ).toBeVisible();
    await expect(main.getByRole('link', { name: 'Project planning', exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Unfiled note', exact: true })).toHaveCount(0);
    await main.getByRole('button', { name: 'Search these notes', exact: true }).click();
    await main.getByRole('textbox', { name: 'Search these notes', exact: true }).fill('unmatched');
    await expect(main.getByText('No notes match', { exact: true })).toBeVisible();
    await main.getByRole('textbox', { name: 'Search these notes', exact: true }).fill('Project');
    await expect(main.getByRole('link', { name: 'Project planning', exact: true })).toBeVisible();
    await page.reload();
    await expect(folder).toBeVisible();
    await expect(
      main.getByRole('heading', { name: 'Project notes', level: 1 }).last()
    ).toBeVisible();
    await expect(main.getByRole('link', { name: 'Project planning', exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Unfiled note', exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('folder-notes.png') });

    await page.evaluate(() => {
      window.location.hash = '/folders';
    });
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/notes');
    await expect(main.getByRole('heading', { name: 'Notes', level: 1 }).last()).toBeVisible();
    await expect(main.getByRole('link', { name: 'Unfiled note', exact: true })).toBeVisible();
  });

  test('creates and edits tags, rejects duplicate names, and persists the color', async () => {
    const sidebar = page.locator('[data-sidebar="sidebar"]');
    const main = page.getByRole('main');
    await sidebar.getByRole('button', { name: 'Create tag', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('work');
    await dialog.getByRole('button', { name: 'Create tag', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: '#work', exact: true })).toBeVisible();
    await createNamedNote(page, 'Tagged note');
    await page.getByRole('button', { name: 'Add tag', exact: true }).click();
    const tagSearch = page.getByPlaceholder('Search or create…');
    await tagSearch.fill('WORK');
    await expect(page.getByRole('option', { name: 'Create “WORK”', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: 'work', exact: true }).click();
    await tagSearch.fill('personal');
    await page.getByRole('option', { name: 'Create “personal”', exact: true }).click();
    await expect(sidebar.getByRole('link', { name: '#personal', exact: true })).toBeVisible();
    await tagSearch.press('Escape');

    await sidebar.getByRole('button', { name: 'personal options', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Edit tag/ }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('WORK');
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(dialog.getByText('A tag called WORK already exists.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    await sidebar.getByRole('button', { name: 'work options', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Edit tag/ }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('roadmap');
    await dialog.getByRole('button', { name: 'Use color #a78bfa', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await createNamedNote(page, 'Untagged note');
    await sidebar.getByRole('link', { name: '#roadmap', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toMatch(/^#\/notes\?tags=tag_/);
    await expect(main.getByRole('link', { name: 'Tagged note', exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Untagged note', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(sidebar.getByRole('link', { name: '#roadmap', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: '#work', exact: true })).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Tagged note', exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Untagged note', exact: true })).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'roadmap options', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Edit tag/ }).click();
    await expect(
      dialog.getByRole('button', { name: 'Use color #a78bfa', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await main.getByRole('button', { name: 'Clear tag filter', exact: true }).click();
    await expect(main.getByRole('link', { name: 'Untagged note', exact: true })).toBeVisible();

    await page.evaluate(() => {
      window.location.hash = '/tags';
    });
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/notes');
    await expect(main.getByRole('heading', { name: 'Notes', level: 1 }).last()).toBeVisible();
  });

  test('loads the note reading fonts from the packaged app', async () => {
    await createNamedNote(page, 'Reading font');
    const editor = page.locator('.note-prose');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill('A note with the shared reading font.');
    await expect
      .poll(() => editor.evaluate(element => getComputedStyle(element).fontFamily))
      .toContain('DM Sans');
    const loaded = await page.evaluate(async () => {
      const normal = await document.fonts.load('400 16px "DM Sans"');
      const italic = await document.fonts.load('italic 400 16px "DM Sans"');
      return [normal.length, italic.length];
    });
    expect(loaded).toEqual([1, 1]);
    await page.screenshot({ path: test.info().outputPath('note-reading-font.png') });
  });
});
