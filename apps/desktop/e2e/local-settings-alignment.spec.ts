import { rm } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

test.describe('local settings alignment', () => {
  let launched: PrismicalLaunch | undefined;
  let keptProfile: string | undefined;
  let page: Page;

  test.beforeEach(async () => {
    launched = await launchPrismical({}, { seedMode: 'local' });
    page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
  });

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await Promise.all(
      [keptProfile]
        .filter((dir): dir is string => dir !== undefined)
        .map(dir => rm(dir, { recursive: true, force: true }))
    );
    keptProfile = undefined;
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

  test('persists independent interface, AI output, and spoken languages across a local restart', async () => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const outputLanguage = page.getByRole('combobox', { name: 'AI output language', exact: true });
    const interfaceLanguage = page.getByRole('combobox', { name: 'Interface language', exact: true });
    await expect(outputLanguage).toBeEnabled();
    await expect(outputLanguage).toContainText('Same as the note');
    await outputLanguage.click();
    await expect(page.getByRole('option', { name: 'Same as the note', exact: true })).toHaveAccessibleDescription(
      'Each note stays in the language it was written in.'
    );
    await page.getByRole('option', { name: 'Español', exact: true }).click();
    await expect(outputLanguage).toContainText('Español');
    await expect(interfaceLanguage).toHaveValue('en');

    await page.getByRole('link', { name: 'Transcription settings', exact: true }).click();
    const spokenLanguage = page.getByRole('button', { name: 'Select language', exact: true });
    await expect(spokenLanguage).toContainText('English');
    await spokenLanguage.click();
    await page.getByRole('option', { name: 'Hindi', exact: true }).click();
    await expect(spokenLanguage).toContainText('Hindi');
    await page.getByRole('link', { name: 'Preferences', exact: true }).click();
    await expect(outputLanguage).toContainText('Español');
    await expect(interfaceLanguage).toHaveValue('en');
    await expect(page.getByText(/Currently Hindi\./)).toBeVisible();

    await interfaceLanguage.selectOption('de');
    await expect(page.getByRole('alertdialog')).toContainText('Restart to change language');
    await expect
      .poll(() => page.evaluate(() => window.desktop.settings.get().then(settings => settings.language)))
      .toBe('de');
    await page.getByRole('button', { name: 'Later', exact: true }).click();
    await expect(outputLanguage).toContainText('Español');
    await expect(interfaceLanguage).toHaveValue('de');

    keptProfile = launched!.userDataDir;
    await closePrismical(launched, { keepProfile: true });
    launched = undefined;
    launched = await launchPrismical({ PRISMICAL_E2E_USER_DATA_DIR: keptProfile });
    page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    await page.getByRole('link', { name: 'Einstellungen', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Oberflächensprache', exact: true })).toHaveValue('de');
    await expect(page.getByRole('combobox', { name: 'KI-Ausgabesprache', exact: true })).toContainText('Español');
    await expect(page.getByText(/Aktuell Hindi\./)).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });
});
