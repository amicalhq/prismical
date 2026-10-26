import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeOAuthServer, type FakeOAuthServer } from './helpers/fake-oauth';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

/**
 * Join on a Home meeting row, end to end on a packaged cloud build. The page
 * opens the meeting link through main (window open → shell.openExternal, stubbed
 * here), and for a meeting under way it also opens the meeting's note and asks
 * MAIN to record it. Main's recording start checks core for a pending suggestion
 * on that note before it touches a capture device; the fake core reports one, so
 * the start stops there with its typed reason. That check carries the note id,
 * so it proves the start request reached main for the right note.
 */

const CLIENT_ID = 'desktop-e2e-client';
const REDIRECT_URI = 'prismical://oauth/callback';
const MEETING = {
  id: 'evt_join_e2e',
  title: 'Design review',
  url: 'https://meet.example.com/design-review',
};
const ALL_DAY = {
  id: 'evt_offsite_e2e',
  title: 'Team offsite',
  url: 'https://meet.example.com/team-offsite',
};
const PENDING_MEETING_RECORDING_KEY = 'prismical:pending-meeting-recording-note';

const DAY_MS = 86_400_000;
/** UTC midnight of the local calendar day `offsetDays` from today (how all-day events are keyed). */
const allDayBoundary = (offsetDays: number): string => {
  const day = new Date(Date.now() + offsetDays * DAY_MS);
  return new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())).toISOString();
};

const calendarEvents = () => {
  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  return [
    {
      id: MEETING.id,
      calendarId: 'cal_e2e',
      title: MEETING.title,
      startsAt: new Date(now - 5 * 60_000).toISOString(),
      endsAt: new Date(now + 25 * 60_000).toISOString(),
      isAllDay: false,
      status: 'confirmed',
      meetingUrl: MEETING.url,
      updatedAt,
    },
    {
      // Spans yesterday to tomorrow, so it is under way in every time zone.
      id: ALL_DAY.id,
      calendarId: 'cal_e2e',
      title: ALL_DAY.title,
      startsAt: allDayBoundary(-1),
      endsAt: allDayBoundary(2),
      isAllDay: true,
      status: 'confirmed',
      meetingUrl: ALL_DAY.url,
      updatedAt,
    },
  ];
};

const pendingState = (page: Page): Promise<string | null> =>
  page.evaluate(() => window.desktop.e2e!.authPendingState());

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

/** Record every URL main would hand to the OS browser instead of opening it. */
const stubOpenExternal = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ shell }) => {
    const urls: string[] = [];
    (globalThis as unknown as { openedUrls: string[] }).openedUrls = urls;
    shell.openExternal = async url => {
      urls.push(url);
    };
  });

const openedUrls = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls);

test.describe('meeting Join', () => {
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;
  /** The note ids of main's recording-start checks, in arrival order. */
  let startChecks: string[] = [];

  const start = async (): Promise<Page> => {
    startChecks = [];
    server = await startFakeOAuthServer({
      appResponse: (url, request, body) => {
        const route = url.pathname.replace('/apps/v1/me/', '');
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
                  features: { calendar: true },
                },
              ],
            },
          };
        }
        if (route === 'connections') {
          return {
            status: 200,
            body: {
              results: [
                {
                  id: 'conn_e2e',
                  provider: 'google',
                  syncMode: 'pull',
                  deviceId: null,
                  deviceName: null,
                  status: 'active',
                  statusReason: null,
                  accountEmail: 'user@example.com',
                  lastSyncedAt: new Date().toISOString(),
                },
              ],
            },
          };
        }
        if (route === 'events') return { status: 200, body: { results: calendarEvents() } };
        if (route === 'notes' && request.method === 'POST' && body) {
          const now = new Date().toISOString();
          return {
            status: 201,
            body: {
              result: { updatedAt: now, ...body, createdAt: now },
              applied: true,
              created: true,
            },
          };
        }
        // Main's recording start asks this (the page asks `skill-runs/pending/durable`).
        if (route === 'skill-runs/pending') {
          const noteId = url.searchParams.get('noteId');
          if (noteId) startChecks.push(noteId);
          return {
            status: 200,
            body: {
              results: [
                {
                  resultId: 'res_e2e',
                  mode: 'replace-doc',
                  skillId: 'enhance',
                  skillName: 'Enhance',
                  modelId: 'model-e2e',
                  rawMarkdown: 'Suggested notes',
                  reasoning: null,
                },
              ],
            },
          };
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
    await stubOpenExternal(launched.app);
    await page.evaluate(() => {
      window.location.hash = '#/home';
    });
    return page;
  };

  /** The row's actions show on hover; Join is a link that opens in the OS browser. */
  const join = async (page: Page, title: string): Promise<void> => {
    const row = page.locator('.group').filter({ hasText: title });
    await row.hover();
    await row.getByRole('link', { name: 'Join', exact: true }).click();
  };

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await server?.close();
    server = undefined;
  });

  test('Join on a meeting under way opens the link, opens its note, and asks main to record', async () => {
    const page = await start();
    await join(page, MEETING.title);

    await expect.poll(() => openedUrls(launched!.app)).toEqual([MEETING.url]);
    // Find-or-create: no note links this meeting yet, so Join creates one for it.
    const createdNoteId = () =>
      server!.requests.find(
        r => r.method === 'POST' && r.path === '/apps/v1/me/notes' && r.body?.eventId === MEETING.id
      )?.body?.id;
    await expect.poll(createdNoteId).toEqual(expect.any(String));
    const noteId = String(createdNoteId());
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/notes/${noteId}`);

    await expect.poll(() => startChecks).toEqual([noteId]);
    await expect(
      page.getByText('Apply or discard the suggested changes before recording.').first()
    ).toBeVisible();
  });

  test('Join on an all-day event only opens the link', async () => {
    const page = await start();
    await join(page, ALL_DAY.title);

    await expect.poll(() => openedUrls(launched!.app)).toEqual([ALL_DAY.url]);
    // The click handler runs before the link opens, so a note or a recording request
    // would already be visible here.
    expect(await page.evaluate(() => window.location.hash)).toBe('#/home');
    expect(
      await page.evaluate(key => window.sessionStorage.getItem(key), PENDING_MEETING_RECORDING_KEY)
    ).toBeNull();
    expect(server!.requests.some(r => r.method === 'POST' && r.path === '/apps/v1/me/notes')).toBe(
      false
    );
    expect(startChecks).toEqual([]);
  });
});
