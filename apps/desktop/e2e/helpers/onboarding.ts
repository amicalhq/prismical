import { expect, type Page } from '@playwright/test';

export async function advanceToMode(page: Page) {
  await expect(page.getByTestId('mode-chooser')).toHaveAttribute('data-step', 'discovery');
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  await page.getByTestId('onboarding-continue').click();
  await expect(page.getByTestId('mode-chooser')).toHaveAttribute('data-step', 'permissions');
  await page.getByTestId('onboarding-continue').click();
  await expect(page.getByTestId('mode-chooser')).toHaveAttribute('data-step', 'mode');
}
