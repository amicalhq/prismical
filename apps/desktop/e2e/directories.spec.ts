import { test, expect, type Page } from '@playwright/test';
import { startFakeOAuthServer, type FakeOAuthServer } from './helpers/fake-oauth';
import { DIRECTORY_ORGS, directoryFixtures } from './helpers/directory-fixtures';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

test.describe('cloud people and companies directory', () => {
  let server: FakeOAuthServer;
  let launched: PrismicalLaunch;
  let page: Page;
  let fixtures: ReturnType<typeof directoryFixtures>;

  test.beforeEach(async () => {
    fixtures = directoryFixtures();
    server = await startFakeOAuthServer({
      orgUsers: DIRECTORY_ORGS,
      appResponse: fixtures.appResponse,
    });
    launched = await launchPrismical({
      PRISMICAL_CORE_API_URL: server.origin,
      PRISMICAL_CLIENT_ID: 'desktop-e2e-client',
    });
    page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await page.getByTestId('auth-sign-in').click();
    const pendingState = () => page.evaluate(() => window.desktop.e2e!.authPendingState());
    await expect.poll(pendingState).not.toBeNull();
    const state = String(await pendingState());
    await launched.app.evaluate(
      ({ app }, url) => {
        app.emit('open-url', { preventDefault: () => {} }, url);
      },
      `prismical://oauth/callback?code=C1&state=${encodeURIComponent(state)}`
    );
    await expect(page.getByTestId('auth-gate')).toHaveAttribute('data-gate-state', 'signed-in');
    await page.getByRole('link', { name: 'People', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'People', level: 1 }).last()).toBeVisible();
  });

  test.afterEach(async () => {
    await test.info().attach('directory-requests', {
      body: JSON.stringify(fixtures.requests, null, 2),
      contentType: 'application/json',
    });
    await closePrismical(launched);
    await server?.close();
  });

  const personRows = () => page.locator('a[href^="#/people/"]');
  const companyRows = () => page.locator('a[href^="#/companies/"]');

  test('loads later pages in both lists and resets paging on search and filters', async () => {
    await expect(personRows()).toHaveCount(50);
    await page.getByRole('link', { name: /Person 49/ }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('link', { name: /Person 50/ })).toBeVisible();
    await expect(personRows()).toHaveCount(51);
    expect(fixtures.requests.filter(r => r.path === 'people' && r.offset === 50)).toHaveLength(1);
    await page.getByPlaceholder('Search people').fill('Person 00');
    await expect(personRows()).toHaveCount(1);
    await expect(page.getByRole('link', { name: /Person 00/ })).toBeVisible();
    await page.getByPlaceholder('Search people').fill('');
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await expect(personRows()).toHaveCount(1);
    await page.getByRole('button', { name: 'External', exact: true }).click();
    await expect(personRows()).toHaveCount(50);
    await expect(page.getByRole('link', { name: /Person 00/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByRole('link', { name: /Person 00/ })).toBeVisible();
    await page.getByRole('link', { name: 'Companies', exact: true }).click();
    await expect(companyRows()).toHaveCount(50);
    await page.getByRole('link', { name: /Company 49/ }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('link', { name: /Company 50/ })).toBeVisible();
    expect(fixtures.requests.filter(r => r.path === 'companies' && r.offset === 50)).toHaveLength(
      1
    );
    await page.getByPlaceholder('Search companies').fill('Company 50');
    await expect(companyRows()).toHaveCount(1);
    expect(fixtures.requests.at(-1)?.offset).toBe(0);
  });

  test('opens details, linked people, meeting history and notes inside desktop', async () => {
    await page.getByRole('link', { name: /Person 00/ }).click();
    await expect(page.getByRole('heading', { name: 'Person 00', level: 1 })).toBeVisible();
    await expect(page.getByText('Directory meeting', { exact: true })).toBeVisible();
    await expect(page.getByText('Declined', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Company 00', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Company 00', level: 1 })).toBeVisible();
    await expect(personRows()).toHaveCount(2);
    await page.getByRole('link', { name: /Person 01/ }).click();
    await expect(page.getByRole('heading', { name: 'Person 01', level: 1 })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Person 01', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Note', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe('#/notes/note_directory');
  });

  test('shows empty, no-match and API error states', async () => {
    await page.getByPlaceholder('Search people').fill('no-such-person');
    await expect(page.getByText('No people match your search', { exact: true })).toBeVisible();
    fixtures.setEmpty();
    await page.reload();
    await expect(page.getByText('No people yet', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Companies', exact: true }).click();
    await expect(page.getByText('No companies yet', { exact: true })).toBeVisible();
    fixtures.setFailed();
    await page.reload();
    await expect(
      page.getByText('Could not load this content. Please try again.', { exact: true })
    ).toBeVisible();
    await expect(page.getByText('backend exploded')).toHaveCount(0);
  });

  for (const directory of [
    { title: 'People', path: 'people', rowPrefix: 'Person' },
    { title: 'Companies', path: 'companies', rowPrefix: 'Company' },
  ]) {
    test(`retries a failed ${directory.path} page only when requested`, async () => {
      await page
        .getByRole('main')
        .getByRole('link', { name: directory.title, exact: true })
        .click();
      const rows = page.locator(`a[href^="#/${directory.path}/"]`);
      await expect(rows).toHaveCount(50);
      fixtures.setFailed();
      await page
        .getByRole('link', { name: new RegExp(`${directory.rowPrefix} 49`) })
        .scrollIntoViewIfNeeded();
      const error = page.getByText('Could not load this content. Please try again.', {
        exact: true,
      });
      await expect(error).toBeVisible();
      await expect(rows).toHaveCount(50);
      const retry = page.getByRole('button', { name: 'Try again', exact: true });
      await expect(retry).toBeEnabled();
      expect(
        fixtures.requests.filter(r => r.path === directory.path && r.offset === 50)
      ).toHaveLength(1);
      fixtures.setFailed(false);
      await retry.click();
      await expect(rows).toHaveCount(51);
      await expect(error).toHaveCount(0);
      expect(
        fixtures.requests.filter(r => r.path === directory.path && r.offset === 50)
      ).toHaveLength(2);
    });
  }

  test('replaces cached directory data when the active organization changes', async () => {
    await expect(page.getByRole('link', { name: /Person 00/ })).toBeVisible();
    await page.evaluate(
      orgId => window.desktop.auth.switchOrg({ orgId }),
      DIRECTORY_ORGS[1]!.org_id
    );
    await expect(page.getByRole('link', { name: /Second organization person/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Person 00/ })).toHaveCount(0);
    const responses = await page.evaluate(async orgId => {
      await window.desktop.auth.switchOrg({ orgId });
      return Promise.all(
        ['notes', 'tags', 'companies'].map(path =>
          window.desktop.transport.request({ method: 'GET', path: `/apps/v1/me/${path}` })
        )
      );
    }, DIRECTORY_ORGS[0]!.org_id);
    expect(responses).toEqual([
      expect.objectContaining({ ok: true, status: 200 }),
      expect.objectContaining({ ok: true, status: 200 }),
      expect.objectContaining({ ok: true, status: 200 }),
    ]);
    await expect(page.getByRole('link', { name: /Person 00/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Second organization person/ })).toHaveCount(0);
    expect(
      fixtures.requests.some(r => r.path === 'people' && r.orgId === DIRECTORY_ORGS[1]!.org_id)
    ).toBe(true);
  });
});
