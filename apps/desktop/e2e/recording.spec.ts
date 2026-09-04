import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeOAuthServer, type FakeOAuthServer } from './helpers/fake-oauth';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

/**
 * The shared record button + live transcript over IPC, exercised through
 * the REAL preload/handler/bridge path (no capture device, no cloud). What is
 * REAL here vs. plumbing:
 *  - REAL: the recording:start / recording:stop invoke round-trip (preload →
 *    handler → RecordingBridge → back) and the recording:stateChanged push
 *    round-trip (main → preload buffer → renderer subscriber);
 *  - PLUMBING (injected): the native capture never runs (no device / the helper
 *    binaries are not packaged in the E2E fixture), so the transcript state is
 *    pushed via an e2e-only seam, and the permission-denied result is forced
 *    via that same seam. The state → dock/transcript RENDER mapping is unit-covered in
 *    app-client (use-recording.test.tsx) and shared with web.
 */

const CLIENT_ID = 'desktop-e2e-client';
// Both test targets currently accept the production callback scheme.
const REDIRECT_URI = 'prismical://oauth/callback';

const authEnv = (server: FakeOAuthServer): Record<string, string> => ({
  PRISMICAL_CORE_API_URL: server.origin,
  PRISMICAL_CLIENT_ID: CLIENT_ID,
});

interface StartResult {
  ok: boolean;
  reason?: string;
  recordingId?: string;
}

interface SegmentView {
  id: string;
  recordingId: string;
  source: string;
  speaker: string;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  segmentOrder: number;
}

interface RecordingStateView {
  recordingId: string | null;
  status: string;
  captureMode: string | null;
  requestedCaptureMode: string | null;
  micSource: 'meeting-app' | 'system-default' | 'unavailable';
  noteId: string | null;
  segments: SegmentView[];
  elapsedMs: number;
  elapsedAt?: number | null;
  pausedAccumMs?: number;
  startedAt?: number | null;
}

const pendingState = (page: Page): Promise<string | null> =>
  page.evaluate(() =>
    (
      window as never as {
        desktop: { e2e: { authPendingState: () => Promise<string | null> } };
      }
    ).desktop.e2e.authPendingState()
  );

const acquires = (page: Page): Promise<number> =>
  page
    .evaluate(() =>
      (
        window as never as {
          desktop: { e2e: { sessionProbe: () => Promise<{ acquires: number }> } };
        }
      ).desktop.e2e.sessionProbe()
    )
    .then(probe => probe.acquires);

const deliverOpenUrl = (app: ElectronApplication, url: string): Promise<void> =>
  app.evaluate(({ app: electronApp }, callbackUrl) => {
    electronApp.emit('open-url', { preventDefault: () => {} }, callbackUrl);
  }, url);

const startRecording = (page: Page, request: unknown): Promise<StartResult> =>
  page.evaluate(
    req =>
      (
        window as never as {
          desktop: { recording: { start: (r: unknown) => Promise<StartResult> } };
        }
      ).desktop.recording.start(req),
    request
  );

const stopRecording = (page: Page, recordingId: string): Promise<void> =>
  page.evaluate(
    id =>
      (
        window as never as {
          desktop: { recording: { stop: (r: { recordingId: string }) => Promise<void> } };
        }
      ).desktop.recording.stop({ recordingId: id }),
    recordingId
  );

const pauseRecording = (page: Page, recordingId: string): Promise<boolean> =>
  page.evaluate(
    id =>
      (
        window as never as {
          desktop: { recording: { pause: (r: { recordingId: string }) => Promise<boolean> } };
        }
      ).desktop.recording.pause({ recordingId: id }),
    recordingId
  );

const resumeRecording = (page: Page, recordingId: string): Promise<boolean> =>
  page.evaluate(
    id =>
      (
        window as never as {
          desktop: { recording: { resume: (r: { recordingId: string }) => Promise<boolean> } };
        }
      ).desktop.recording.resume({ recordingId: id }),
    recordingId
  );

/** Subscribe to the recording state pushes in the page and stash them. */
const subscribeStatePushes = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as never as {
      __recPushes?: RecordingStateView[];
      desktop: {
        recording: { onStateChanged: (cb: (s: RecordingStateView) => void) => () => void };
      };
    };
    w.__recPushes = [];
    w.desktop.recording.onStateChanged(state => w.__recPushes!.push(state));
  });

const capturedPushes = (page: Page): Promise<RecordingStateView[]> =>
  page.evaluate(
    () => (window as never as { __recPushes?: RecordingStateView[] }).__recPushes ?? []
  );

const injectRecordingPush = (page: Page, view: RecordingStateView): Promise<void> =>
  page.evaluate(
    v =>
      (
        window as never as {
          desktop: { e2e: { recording: (cmd: unknown) => Promise<void> } };
        }
      ).desktop.e2e.recording({ kind: 'push', view: v }),
    view
  );

const forceNextStart = (page: Page, result: StartResult): Promise<void> =>
  page.evaluate(
    r =>
      (
        window as never as {
          desktop: { e2e: { recording: (cmd: unknown) => Promise<void> } };
        }
      ).desktop.e2e.recording({ kind: 'forceStart', result: r }),
    result
  );

const signIn = async (page: Page, app: ElectronApplication): Promise<void> => {
  const gate = page.getByTestId('auth-gate');
  await expect(gate).toHaveAttribute('data-mode', 'gate');
  await page.getByTestId('auth-sign-in').click();
  await expect.poll(() => pendingState(page)).not.toBeNull();
  const state = String(await pendingState(page));
  await deliverOpenUrl(app, `${REDIRECT_URI}?code=C1&state=${encodeURIComponent(state)}`);
  await expect(gate).toHaveAttribute('data-gate-state', 'signed-in');
  await expect.poll(() => acquires(page)).toBeGreaterThanOrEqual(1);
};

test.describe('recording IPC + transcript push', () => {
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;

  test.beforeEach(async () => {
    server = await startFakeOAuthServer();
    launched = await launchPrismical(authEnv(server));
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await server?.close();
    server = undefined;
  });

  test('recording:start/stop round-trip through the bridge — no-session when signed out', async () => {
    const page = await launched!.app.firstWindow();
    // Signed out (no session registered in the bridge): start folds to a typed
    // no-session result — the full preload → handler → bridge round-trip, no
    // capture device touched, no unhandled rejection.
    await expect(
      startRecording(page, { captureMode: 'dual', noteId: null, title: 'Standup' })
    ).resolves.toEqual({
      ok: false,
      reason: 'no-session',
    });
    // stop is a graceful no-op with no active recording.
    await expect(stopRecording(page, 'rec_missing')).resolves.toBeUndefined();
    await expect(pauseRecording(page, 'rec_missing')).resolves.toBe(false);
    await expect(resumeRecording(page, 'rec_missing')).resolves.toBe(false);
  });

  test('recording:stateChanged delivers live segments + the mic-only degrade to the renderer', async () => {
    const page = await launched!.app.firstWindow();
    await signIn(page, launched!.app);
    await subscribeStatePushes(page);

    // Inject a recording state: one transcript segment + a dual → mic degrade.
    // The full valid segment shape (strict schema on the main side).
    const recordingView: RecordingStateView = {
      recordingId: 'rec_e2e',
      status: 'recording',
      captureMode: 'mic',
      requestedCaptureMode: 'dual',
      micSource: 'system-default',
      noteId: 'note_e2e',
      segments: [
        {
          id: 'tsg_0',
          recordingId: 'rec_e2e',
          source: 'mic',
          speaker: 'you',
          text: 'hello from native e2e',
          startTimeMs: 0,
          endTimeMs: 5000,
          segmentOrder: 1_000_000,
        },
      ],
      elapsedMs: 5000,
    };
    await injectRecordingPush(page, recordingView);

    await expect
      .poll(() =>
        capturedPushes(page).then(pushes =>
          pushes.some(p => p.recordingId === 'rec_e2e' && p.status === 'recording')
        )
      )
      .toBe(true);

    const pushes = await capturedPushes(page);
    const recording = pushes.find(p => p.recordingId === 'rec_e2e' && p.status === 'recording');
    expect(recording).toBeDefined();
    // The live transcript segment crossed to the renderer.
    expect(recording?.segments[0]?.text).toBe('hello from native e2e');
    // The mic-only degrade (requested !== effective) the dock surfaces.
    expect(recording?.captureMode).toBe('mic');
    expect(recording?.requestedCaptureMode).toBe('dual');

    // The same fabricated-state seam carries the mic recovery signal used by
    // the shared dock's recovery notice.
    await injectRecordingPush(page, {
      ...recordingView,
      captureMode: 'dual',
      requestedCaptureMode: 'dual',
      micSource: 'unavailable',
      segments: [],
    });
    await expect
      .poll(() => capturedPushes(page).then(states => states.at(-1)?.micSource))
      .toBe('unavailable');

    await injectRecordingPush(page, {
      ...recordingView,
      status: 'paused',
      elapsedMs: 5_000,
      elapsedAt: Date.now(),
      pausedAccumMs: 2_000,
      startedAt: Date.now() - 7_000,
    });
    await expect
      .poll(() => capturedPushes(page).then(states => states.at(-1)?.status))
      .toBe('paused');
    // Recording state is ids + transcript text only — no token material.
    expect(JSON.stringify(pushes)).not.toContain('token');

    // Idle push resets the surface.
    await injectRecordingPush(page, {
      recordingId: null,
      status: 'idle',
      captureMode: null,
      requestedCaptureMode: null,
      micSource: 'system-default',
      noteId: null,
      segments: [],
      elapsedMs: 0,
    });
    await expect
      .poll(() => capturedPushes(page).then(pushes => pushes.at(-1)?.status))
      .toBe('idle');
  });

  test('recording:start returns the typed permission-denied result', async () => {
    const page = await launched!.app.firstWindow();
    await signIn(page, launched!.app);
    // Force the next start to deny (the real permission gate needs a device).
    // This pins the preload → main → bridge response contract; visible renderer
    // mapping belongs to the shared useRecording component tests.
    await forceNextStart(page, { ok: false, reason: 'permission-denied' });
    await expect(
      startRecording(page, { captureMode: 'dual', noteId: 'note_e2e', title: 'Standup' })
    ).resolves.toEqual({ ok: false, reason: 'permission-denied' });
  });
});
