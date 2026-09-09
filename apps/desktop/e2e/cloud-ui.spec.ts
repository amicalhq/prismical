import { test, expect, type Page } from '@playwright/test';
import type { RecordingStateView } from '@prismical/desktop-contracts';
import { startFakeOAuthServer, type FakeOAuthServer } from './helpers/fake-oauth';
import { launchPrismical, closePrismical, type PrismicalLaunch } from './helpers/launch';

test.describe('cloud desktop controls', () => {
  let server: FakeOAuthServer;
  let launched: PrismicalLaunch;
  let page: Page;
  let usedSeconds: number;

  test.beforeEach(async () => {
    usedSeconds = 12_000;
    server = await startFakeOAuthServer({
      appResponse: url => {
        const route = url.pathname.replace('/apps/v1/me/', '');
        if (route === 'notes') {
          return {
            status: 200,
            body: {
              results: [
                {
                  id: 'nt_cloud_ui',
                  title: 'Skills test note',
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
                  features: { deepgramByok: true, googleGeminiByok: true },
                  entitlements: {
                    planExternalId: null,
                    aiModelTier: 'pro',
                    pooled: false,
                    features: {
                      askAi: false,
                      floatingMode: true,
                      byok: true,
                      automations: true,
                      extendedRecording: true,
                    },
                    limits: {
                      seats: null,
                      cloudTranscriptionSeconds: 18_000,
                      aiCredits: null,
                      maxRecordingSeconds: 3600,
                    },
                  },
                },
              ],
            },
          };
        }
        if (route === 'usage') {
          return {
            status: 200,
            body: {
              period: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
              usage: {
                notesCreated: 0,
                skillRuns: 0,
                askMessages: 0,
                apiMutations: 0,
                transcriptionSecondsCloud: usedSeconds,
                transcriptionSecondsByok: 0,
                cloudInputTokens: 0,
                cloudOutputTokens: 0,
                aiTokens: {},
              },
              limits: { cloudTranscriptionSeconds: 18_000 },
              quota: {
                cloudTranscription: {
                  usedSeconds,
                  limitSeconds: 18_000,
                  resetsAt: '2026-10-01T00:00:00.000Z',
                  label: { kind: 'cloudTranscription' },
                  href: '/settings/billing',
                  action: { kind: 'upgradeUnlimited', href: '/settings/billing', external: false },
                },
              },
            },
          };
        }
        if (route === 'model-defaults')
          return { status: 200, body: { transcription: null, formatting: null } };
        if (route === 'instances')
          return {
            status: 200,
            body: {
              results: [
                {
                  id: 'ins_gemini_test',
                  provider: 'google-gemini',
                  label: 'Test Gemini',
                  config: {},
                  createdAt: '2026-09-01T00:00:00.000Z',
                  updatedAt: '2026-09-01T00:00:00.000Z',
                },
              ],
            },
          };
        if (route === 'instances/ins_gemini_test/models')
          return {
            status: 200,
            body: {
              results: [
                {
                  id: 'gemini-transcription-test',
                  name: 'Test transcription model',
                  type: 'transcription',
                },
              ],
            },
          };
        return undefined;
      },
    });
    launched = await launchPrismical({
      PRISMICAL_CORE_API_URL: server.origin,
      PRISMICAL_CLIENT_ID: 'desktop-e2e-client',
    });
    page = await launched.app.firstWindow({ timeout: 60_000 });
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
  });

  test.afterEach(async () => {
    await closePrismical(launched);
    await server?.close();
  });

  test('shows remaining usage, exhaustion, compact footer and billing navigation', async () => {
    await expect(page.getByText('1h 40m left', { exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '67');
    await expect(page.getByRole('link', { name: 'Discord', exact: true })).toBeVisible();
    await expect(page.locator('a[href="mailto:help@prismical.ai"]')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('sidebar-usage.png') });
    usedSeconds = 18_000;
    await page.reload();
    await expect(page.getByText('No time left', { exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    await page.getByRole('link', { name: 'Upgrade to unlimited', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/settings/billing');
  });

  test('offers Deepgram credentials and Gemini transcription caveats', async () => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'AI Models', exact: true }).click();
    await page.getByRole('button', { name: 'Deepgram', exact: true }).click();
    await expect(page.getByPlaceholder('Your Deepgram API key')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Change model', exact: true }).first().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Google Gemini.*Test Gemini/ })
      .click();
    await expect(
      page.getByText(/Speaker identification is not supported with Google Gemini yet/)
    ).toBeVisible();
    await expect(
      page.getByText(/Free Google Gemini keys are rate-limited too tightly/)
    ).toBeVisible();
    await expect(page.getByRole('radio', { name: /Test transcription model/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('transcription-picker.png') });
  });

  test('keeps a draft in the skills composer when Ask is outside the plan', async () => {
    await page.evaluate(() => {
      window.location.hash = '#/notes/nt_cloud_ui';
    });
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Type / to run a skill', exact: true });
    await expect(composer).toBeVisible();
    await composer.fill('Summarize my notes');
    await composer.press('Enter');
    await expect(composer).toHaveText('Summarize my notes');
    await expect(
      page.getByText('Ask AI isn’t included in your plan. Type / to run a skill instead.')
    ).toBeVisible();
    expect(server.requests.filter(request => request.path === '/apps/v1/me/ask')).toHaveLength(0);
  });

  test('warns only for recordings that spend Cloud quota and raises the next threshold', async () => {
    usedSeconds = 17_400;
    await page.reload();
    await expect(page.getByText('10m left', { exact: true })).toBeVisible();
    await page.clock.install();
    await page.evaluate(() => {
      window.location.hash = '#/notes/nt_cloud_ui';
    });
    const push = (recordingId: string, spendsCloudQuota: boolean) =>
      page.evaluate(
        view =>
          window.desktop.e2e!.recording({
            kind: 'push',
            view: { ...view, elapsedAt: Date.now(), startedAt: Date.now() },
          }),
        {
          recordingId,
          finalizingRecordingIds: [], completedRecordings: [],
          status: 'recording',
          captureMode: 'mic',
          requestedCaptureMode: 'mic',
          spendsCloudQuota,
          quotaRemainingAtStartSeconds: 600,
          micSource: 'system-default',
          noteId: 'nt_cloud_ui',
          segments: [],
          elapsedMs: 0,
        } satisfies RecordingStateView
      );
    const notice = page.getByText(
      'This recording will outlast it. The transcript stops when it runs out.'
    );
    await push('rec_own_key', false);
    await expect(page.getByRole('button', { name: 'Pause recording', exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
    await push('rec_cloud', true);
    await expect(notice).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await page.clock.fastForward(500_000);
    await expect(notice).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('recording-quota-warning.png') });
    await page.getByRole('button', { name: 'Upgrade', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/settings/billing');
  });

  test('restoring a paused recording uses its original allowance and capture time', async () => {
    usedSeconds = 17_160;
    await page.reload();
    await expect(page.getByText('14m left', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.location.hash = '#/notes/nt_cloud_ui';
    });
    // A late renderer receives six minutes of capture and twenty minutes of pause.
    // The current usage already includes those six minutes; main retains the original allowance.
    await page.evaluate(() =>
      window.desktop.e2e!.recording({
        kind: 'push',
        view: {
          recordingId: 'rec_restored',
          finalizingRecordingIds: [], completedRecordings: [],
          status: 'paused',
          captureMode: 'mic',
          requestedCaptureMode: 'mic',
          spendsCloudQuota: true,
          quotaRemainingAtStartSeconds: 1200,
          micSource: 'system-default',
          noteId: 'nt_cloud_ui',
          segments: [],
          elapsedMs: 6 * 60_000,
          elapsedAt: Date.now(),
          startedAt: Date.now() - 26 * 60_000,
          pausedAccumMs: 20 * 60_000,
        },
      })
    );
    await expect(page.getByRole('button', { name: 'Show transcription', exact: true })).toHaveText(
      '6:00'
    );
    await expect(
      page.getByText('About 14m of transcription left this month', { exact: true })
    ).toBeVisible();
  });
});
