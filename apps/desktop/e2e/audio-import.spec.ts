import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { statSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeOAuthServer, type FakeOAuthServer } from './helpers/fake-oauth';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

/**
 * Cloud audio import end to end through the REAL preload, IPC and main upload:
 * the page picks a file, core (fake) returns a storage upload URL, and MAIN
 * sends the file to that URL (a local fake storage server). The renderer CSP
 * does not allow storage, so the page could not have sent it itself.
 */

const CLIENT_ID = 'desktop-e2e-client';
const REDIRECT_URI = 'prismical://oauth/callback';
const NOTE_ID = 'nt_import_e2e';
const RECORDING_ID = 'rec_import_e2e';
const UPLOAD_ATTEMPT = '33333333-3333-4333-8333-333333333333';
const FIXTURE = path.resolve(__dirname, '../tests/fixtures/two-speaker.wav');
const FIXTURE_BYTES = statSync(FIXTURE).size;

interface StoragePut {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly bytes: number;
}

/** A fake storage endpoint: records each request and answers `status`. */
const startFakeStorage = async (status: number) => {
  const puts: StoragePut[] = [];
  const server: Server = createServer((request, response) => {
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    request.on('end', () => {
      puts.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, bytes });
      response.writeHead(status).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    puts,
    uploadUrl: `${origin}/upload/storage/v1/b/e2e/o?uploadType=resumable&upload_id=e2e-session`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

const importRecord = (uploadUrl: string, status: string, phase: string) => ({
  recordingId: RECORDING_ID,
  noteId: NOTE_ID,
  status,
  phase,
  fileName: 'two-speaker.wav',
  uploadAttempt: UPLOAD_ATTEMPT,
  uploadUrl,
  error: null,
  durationMs: null,
  maxDurationMs: 14_400_000,
});

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

test.describe('cloud audio import', () => {
  let storage: Awaited<ReturnType<typeof startFakeStorage>> | undefined;
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;

  const start = async (storageStatus: number): Promise<Page> => {
    const fakeStorage = await startFakeStorage(storageStatus);
    storage = fakeStorage;
    server = await startFakeOAuthServer({
      appResponse: (url, request) => {
        const route = url.pathname.replace('/apps/v1/me/', '');
        if (route === 'notes') {
          return {
            status: 200,
            body: {
              results: [
                {
                  id: NOTE_ID,
                  title: 'Import test note',
                  contentText: '',
                  isOwner: true,
                  canWrite: true,
                  createdAt: '2026-09-01T00:00:00.000Z',
                  updatedAt: '2026-09-01T00:00:00.000Z',
                },
              ],
            },
          };
        }
        if (route === 'organizations') {
          return {
            status: 200,
            body: {
              results: [
                {
                  orgUserId: 'org_user_e2e_1',
                  orgId: 'org_e2e_1',
                  name: 'Test workspace',
                  slug: 'test-workspace',
                  role: 'owner',
                  allowPublicSharing: false,
                  memberCount: 1,
                  features: { audioImport: true },
                },
              ],
            },
          };
        }
        if (route === 'recording-imports/active') return { status: 200, body: null };
        if (route === 'recording-imports' && request.method === 'POST') {
          return {
            status: 201,
            body: importRecord(fakeStorage.uploadUrl, 'uploading', 'uploading'),
          };
        }
        if (route === `recording-imports/${RECORDING_ID}/complete`) {
          return { status: 200, body: importRecord(fakeStorage.uploadUrl, 'done', 'ready') };
        }
        if (route === `recording-imports/${RECORDING_ID}/cancel`) {
          return { status: 200, body: importRecord(fakeStorage.uploadUrl, 'cancelled', 'cancelled') };
        }
        return undefined;
      },
    });
    launched = await launchPrismical({
      PRISMICAL_CORE_API_URL: server.origin,
      PRISMICAL_CLIENT_ID: CLIENT_ID,
    });
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await page.waitForLoadState('domcontentloaded');
    await signIn(page, launched.app);
    return page;
  };

  const importFixture = async (page: Page): Promise<void> => {
    await page.evaluate(noteId => {
      window.location.hash = `#/notes/${noteId}`;
    }, NOTE_ID);
    // At idle this only opens the record panel; Start is a separate panel control.
    await page.getByRole('button', { name: 'Record and transcribe', exact: true }).click();
    await page.getByRole('button', { name: 'Past recordings', exact: true }).click();
    await page.getByRole('button', { name: 'Import recording', exact: true }).click();
    await page.locator('#audio-import-file').setInputFiles(FIXTURE);
    await page.getByRole('button', { name: 'Import with Prismical Cloud', exact: true }).click();
  };

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await server?.close();
    server = undefined;
    await storage?.close();
    storage = undefined;
  });

  test('main sends the picked file to the upload URL that core returned', async () => {
    const page = await start(200);
    await importFixture(page);

    await expect.poll(() => storage!.puts.length).toBe(1);
    const put = storage!.puts[0]!;
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('/upload/storage/v1/b/e2e/o?uploadType=resumable&upload_id=e2e-session');
    expect(put.headers['content-type']).toBe('audio/wav');
    expect(put.headers['content-length']).toBe(String(FIXTURE_BYTES));
    expect(put.bytes).toBe(FIXTURE_BYTES);
    // Sent by main, not by a page: no browser Origin, so storage needs no CORS answer.
    expect(put.headers.origin).toBeUndefined();

    const create = server!.requests.find(
      r => r.method === 'POST' && r.path === '/apps/v1/me/recording-imports'
    );
    expect(create?.body).toMatchObject({
      noteId: NOTE_ID,
      expectedOrgUserId: 'org_user_e2e_1',
      fileName: 'two-speaker.wav',
      sizeBytes: FIXTURE_BYTES,
    });
    await expect
      .poll(
        () =>
          server!.requests.find(
            r => r.path === `/apps/v1/me/recording-imports/${RECORDING_ID}/complete`
          )?.body
      )
      .toEqual({ uploadAttempt: UPLOAD_ATTEMPT });
    await expect(page.getByText('Transcript ready', { exact: true })).toBeVisible();
  });

  test('shows the upload error when storage refuses the file', async () => {
    const page = await start(403);
    await importFixture(page);

    await expect.poll(() => storage!.puts.length).toBe(1);
    await expect(
      page.getByText('Audio upload failed. Cancel and try again.', { exact: true }).first()
    ).toBeVisible();
    expect(
      server!.requests.some(r => r.path === `/apps/v1/me/recording-imports/${RECORDING_ID}/complete`)
    ).toBe(false);
  });
});
