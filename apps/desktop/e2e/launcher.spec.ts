import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { launchPrismical, closePrismical, type PrismicalLaunch } from './helpers/launch';
import { createLocalModeProfile } from './helpers/local-profile';

function ipc(profile: string, action: string, headers: Record<string, string> = {}) {
  return new Promise<{
    ok?: boolean;
    message?: string;
    session: string;
    ready: boolean;
    recordingStatus: string;
  }>((resolve, reject) => {
    const req = request(
      {
        socketPath: path.join(profile, 'launcher/raycast.sock'),
        path: '/' + action,
        method: action === 'status' ? 'GET' : 'POST',
        headers: {
          'x-request-id': randomUUID(),
          'x-expires-at': String(Date.now() + 10000),
          ...headers,
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => resolve(JSON.parse(data)));
      }
    );
    req.on('error', reject);
    req.end();
  });
}
async function command(profile: string, action: string, id = randomUUID()) {
  const status = await ipc(profile, 'status');
  return ipc(profile, action, { 'x-session': status.session, 'x-request-id': id });
}
async function waitForBridge(launch: PrismicalLaunch) {
  await expect
    .poll(() => existsSync(path.join(launch.userDataDir, 'launcher/raycast.sock')))
    .toBe(true);
}
test('signed-out desktop exposes status and accepts universal Stop without a workspace', async () => {
  let launched: PrismicalLaunch | undefined;
  try {
    launched = await launchPrismical();
    await waitForBridge(launched);
    expect((await ipc(launched.userDataDir, 'status')).ready).toBe(false);
    expect((await command(launched.userDataDir, 'start-recording')).ok).toBe(false);
    expect((await command(launched.userDataDir, 'stop-recording')).ok).toBe(true);
  } finally {
    await closePrismical(launched);
  }
});
test('launcher resolves a fresh floating note and duplicate request IDs do not create another', async () => {
  let launched: PrismicalLaunch | undefined;
  try {
    launched = await launchPrismical({}, { seedMode: 'local' });
    const main = await launched.app.firstWindow();
    await expect(main.getByTestId('desktop-shell')).toBeVisible();
    await waitForBridge(launched);
    await expect.poll(async () => (await ipc(launched!.userDataDir, 'status')).ready).toBe(true);
    const id = randomUUID();
    expect((await command(launched.userDataDir, 'start-recording', id)).ok).toBe(true);
    await expect
      .poll(() => launched!.app.windows().some(page => page.url().includes('#/float/')))
      .toBe(true);
    const floating = launched.app.windows().find(page => page.url().includes('#/float/'))!;
    await expect(floating.getByRole('button', { name: 'New quick note' })).toBeVisible();
    const noteUrl = floating.url();
    expect((await command(launched.userDataDir, 'start-recording', id)).ok).toBe(true);
    expect(floating.url()).toBe(noteUrl);
    expect((await command(launched.userDataDir, 'stop-recording')).ok).toBe(true);
    await expect
      .poll(async () => (await ipc(launched!.userDataDir, 'status')).recordingStatus)
      .toBe('idle');
  } finally {
    await closePrismical(launched);
  }
});
test('real native capture starts from launcher and universal Stop ends it', async () => {
  test.skip(
    process.env.PRISMICAL_LIVE_RECORDING !== '1',
    'Opt-in: uses real macOS audio permissions and cached local model'
  );
  const profile = await createLocalModeProfile();
  await mkdir(path.join(profile, 'models'), { recursive: true });
  await copyFile(
    path.join(homedir(), '.cache/prismical/models/ggml-base.en.bin'),
    path.join(profile, 'models/ggml-base.en.bin')
  );
  let launched: PrismicalLaunch | undefined;
  try {
    launched = await launchPrismical({ PRISMICAL_E2E_USER_DATA_DIR: profile });
    const main = await launched.app.firstWindow();
    await expect(main.getByTestId('desktop-shell')).toBeVisible();
    await waitForBridge(launched);
    await expect.poll(async () => (await ipc(profile, 'status')).ready).toBe(true);
    expect((await command(profile, 'start-recording')).ok).toBe(true);
    await expect
      .poll(async () => (await ipc(profile, 'status')).recordingStatus, { timeout: 30000 })
      .toBe('recording');
    const floating = launched.app.windows().find(page => page.url().includes('#/float/'))!;
    await expect(floating.getByRole('button', { name: 'New quick note' })).toBeVisible();
    const noteUrl = floating.url();
    expect((await command(profile, 'start-recording')).message).toBe(
      'Showing the active recording'
    );
    expect(floating.url()).toBe(noteUrl);
    expect((await command(profile, 'stop-recording')).ok).toBe(true);
    await expect
      .poll(async () => (await ipc(profile, 'status')).recordingStatus, { timeout: 30000 })
      .toBe('idle');
  } finally {
    await closePrismical(launched);
  }
});
