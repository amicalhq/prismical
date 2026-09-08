import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '@playwright/test';
import type { UpdateAccessView, UpdateStateView } from '@prismical/desktop-contracts';
import { version } from '../package.json';
import { createSeededProfile } from './helpers/local-profile';
import { launchPrismical, closePrismical, type PrismicalLaunch } from './helpers/launch';

const requirement = { required: true, evaluatedVersion: version, minimumVersion: '99.0.0' };
let launch: PrismicalLaunch | undefined;
let server: Server;
let origin: string;
let envelope: unknown;
let requests: Array<{ url: URL; headers: IncomingHttpHeaders }>;

test.beforeEach(async () => {
  envelope = { updateRequirement: requirement };
  requests = [];
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname !== '/apps/v1/remote-config') {
      res.writeHead(404).end();
      return;
    }
    requests.push({ url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(envelope));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterEach(async () => {
  await closePrismical(launch);
  launch = undefined;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('startup policy blocks sign-in, carries installation metadata, and cannot be dismissed', async () => {
  launch = await launchPrismical({ PRISMICAL_CORE_API_URL: origin });
  const page = await launch.app.firstWindow();
  const dialog = page.getByTestId('required-update-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Required Update');
  await expect(dialog).toContainText(
    'This version of Prismical is no longer supported. Please update now to continue.'
  );
  await expect(dialog.getByRole('button', { name: 'Update now', exact: true })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.click(10, 100);
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('desktop-shell')).toHaveCount(0);
  // If sign-in mounted before the startup response, its existing root is made inert.
  expect(
    await page.getByTestId('auth-gate').evaluateAll(nodes => nodes.every(n => n.closest('[inert]')))
  ).toBe(true);
  expect(requests[0]!.url.searchParams.get('version')).toBe(version);
  expect(requests[0]!.headers['prismical-version']).toBe(version);
  expect(requests[0]!.headers['prismical-client']).toBe('desktop');
  expect(requests[0]!.headers['prismical-platform']).toBe(process.platform);
  expect(requests[0]!.headers['user-agent']).toMatch(/^prismical-desktop\//);
  expect(requests[0]!.headers['accept-language']).toBeTruthy();
  expect(requests[0]!.headers['prismical-device-id']).toBeTruthy();
  expect(requests[0]!.headers.authorization).toBeUndefined();
  await page.screenshot({
    path: test.info().outputPath('required-update.png'),
    animations: 'disabled',
  });
  const exited = launch.app.waitForEvent('close');
  await dialog.getByRole('button', { name: 'Quit Prismical' }).click();
  await exited;
});

test('cached policy blocks mounting offline, explicit clear unlocks, and later blocks preserve mounted content', async () => {
  const dir = await createSeededProfile('local');
  const db = new DatabaseSync(path.join(dir, 'operational.db'));
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'remote-config',
    JSON.stringify({ updateRequirement: requirement }),
    new Date().toISOString()
  );
  db.close();
  envelope = {}; // An unavailable policy must not clear the persisted requirement.
  launch = await launchPrismical({
    PRISMICAL_CORE_API_URL: origin,
    PRISMICAL_E2E_USER_DATA_DIR: dir,
  });
  const page = await launch.app.firstWindow();
  const dialog = page.getByTestId('required-update-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('desktop-shell')).toHaveCount(0);
  await expect(page.getByTestId('auth-gate')).toHaveCount(0);
  await expect.poll(() => requests.length).toBe(1);
  envelope = { updateRequirement: { required: false, evaluatedVersion: version } };
  await dialog.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const shell = page.getByTestId('desktop-shell');
  await expect(shell).toBeVisible();
  await shell.evaluate(element => element.setAttribute('data-preserved', 'yes'));
  envelope = { updateRequirement: requirement };
  await page.evaluate(() => window.desktop.capabilities.checkForUpdates());
  await expect(dialog).toBeVisible();
  await expect(shell).toHaveAttribute('data-preserved', 'yes');
  expect(await shell.evaluate(element => !!element.closest('[inert]'))).toBe(true);
  expect(await page.evaluate(() => window.desktop.recording.start({ captureMode: 'mic' }))).toEqual(
    { ok: false, reason: 'update-required' }
  );
  await page.evaluate(() => window.desktop.float.open(null));
  await expect
    .poll(() => launch!.app.windows().some(window => window.url().includes('#/float')))
    .toBe(true);
  const float = launch.app.windows().find(window => window.url().includes('#/float'))!;
  await expect(float.getByTestId('required-update-dialog')).toBeVisible();
  await expect(float.getByRole('button', { name: 'Update now', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId('required-update-dialog')).toBeVisible();
  await expect(page.getByTestId('desktop-shell')).toHaveCount(0);
});

test('signed-out main windows show staged update prompts and release notes', async () => {
  envelope = {};
  launch = await launchPrismical({ PRISMICAL_CORE_API_URL: origin });
  const page = await launch.app.firstWindow();
  await expect(page.getByTestId('auth-gate')).toBeVisible();
  const sendPrompt = (action: 'force' | 'prompt') =>
    launch!.app.evaluate(({ BrowserWindow }, action) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('updater:stateChanged', {
          status: 'downloaded',
          staged: true,
          stagedVersion: '99.0.0',
          prompt: {
            action,
            version: '99.0.0',
            releaseNotes: '## Improvements\n\n- **Reliable updates**',
          },
        });
    }, action);
  await sendPrompt('force');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Required Update' })).toBeVisible();
  await expect(dialog).toContainText('Version 99.0.0 is required.');
  await expect(dialog.getByText('Improvements', { exact: true })).toBeVisible();
  await expect(dialog.locator('strong')).toHaveText('Reliable updates');
  await expect(dialog.getByRole('button', { name: 'Later', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await sendPrompt('prompt');
  await expect(dialog.getByRole('heading', { name: 'Update Available' })).toBeVisible();
  await expect(dialog).toContainText('Version 99.0.0 is available.');
  await expect(dialog.getByRole('button', { name: 'Later', exact: true })).toBeEnabled();
});

test('recording grace, download states, retry, install, and manual fallback follow the Amical dialog', async () => {
  envelope = {};
  launch = await launchPrismical({ PRISMICAL_CORE_API_URL: origin }, { seedMode: 'local' });
  const app = launch.app;
  const page = await app.firstWindow();
  await expect(page.getByTestId('desktop-shell')).toBeVisible();
  envelope = { updateRequirement: requirement };
  await page.evaluate(() => window.desktop.capabilities.checkForUpdates());
  await expect(page.getByTestId('required-update-dialog')).toBeVisible();
  // Drive the renderer with main-process events, without downloading/installing a binary.
  // Hold these two streams at the test boundary so real idle-recording events
  // cannot overwrite the simulated active-recording snapshot.
  await app.evaluate(({ BrowserWindow }) => {
    const sends = BrowserWindow.getAllWindows().map(window => {
      const send = window.webContents.send.bind(window.webContents);
      window.webContents.send = (channel, ...args) => {
        if (channel !== 'updater:accessChanged' && channel !== 'updater:stateChanged')
          send(channel, ...args);
      };
      return send;
    });
    (
      globalThis as unknown as { pushUpdate: (channel: string, value: unknown) => void }
    ).pushUpdate = (channel, value) => {
      for (const send of sends) send(channel, value);
    };
  });
  const push = (channel: string, value: unknown) =>
    app.evaluate(
      (_, event) => {
        (
          globalThis as unknown as { pushUpdate: (channel: string, value: unknown) => void }
        ).pushUpdate(event.channel, event.value);
      },
      { channel, value }
    );
  const pushAccess = (access: UpdateAccessView) => push('updater:accessChanged', access);
  const pushState = (status: UpdateStateView['status'], prompt: UpdateStateView['prompt'] = null) =>
    push('updater:stateChanged', {
      status,
      staged: status === 'downloaded',
      stagedVersion: '99.0.0',
      prompt,
    });
  await pushAccess({ requirement, recordingActive: true });
  await expect(
    page.getByText('Finish your current recording. Prismical will save it before you update.')
  ).toBeVisible();
  await expect(page.getByTestId('required-update-dialog')).toHaveCount(0);
  await pushState('downloaded', {
    action: 'force',
    version: '99.0.0',
    releaseNotes: 'A required release',
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await pushAccess({ requirement, recordingActive: false });
  const dialog = page.getByTestId('required-update-dialog');
  await expect(dialog).toBeVisible();
  await pushState('checking');
  await expect(dialog.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
  await pushState('available');
  await expect(dialog.getByRole('button', { name: 'Downloading…', exact: true })).toBeDisabled();
  await pushState('error');
  await expect(dialog.getByRole('alert')).toHaveText(
    'The update could not complete. Please try again.'
  );
  await expect(dialog.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
  await app.evaluate(({ ipcMain, shell }) => {
    const calls = { check: 0, install: 0, urls: [] as string[] };
    (globalThis as unknown as { updateCalls: typeof calls }).updateCalls = calls;
    ipcMain.removeHandler('capability:checkUpdates');
    ipcMain.handle('capability:checkUpdates', () => {
      calls.check++;
      return { status: 'error' };
    });
    ipcMain.removeHandler('updater:quitInstall');
    ipcMain.handle('updater:quitInstall', () => {
      calls.install++;
    });
    shell.openExternal = async url => {
      calls.urls.push(url);
      throw new Error('test browser unavailable');
    };
  });
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await pushState('downloaded');
  await dialog.getByRole('button', { name: 'Restart & Update', exact: true }).click();
  await dialog.getByRole('button', { name: 'Download manually', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Couldn’t open the download page. Please try again.'
  );
  expect(
    await app.evaluate(() => (globalThis as unknown as { updateCalls: unknown }).updateCalls)
  ).toEqual({
    check: 1,
    install: 1,
    urls: ['https://prismical.ai/download'],
  });
});
