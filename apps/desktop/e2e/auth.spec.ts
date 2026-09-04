import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeOAuthServer, type FakeOAuthServer } from './helpers/fake-oauth';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  resolveTarget,
  type PrismicalLaunch,
} from './helpers/launch';

/**
 * The authentication flow, exercised end to end against the fake OIDC/core
 * server: sign-in via a parked PKCE attempt and emitted deep link,
 * wrong/duplicate state rejection, provider error,
 * restart-restore from the secure store, revoked refresh, sign-out revocation.
 *
 * Deep-link delivery uses the spike-proven emissions: `app.emit('open-url', …)`
 * (macOS path) and `app.emit('second-instance', …argv)` (Win/Linux path) —
 * both land in ElectronAppLive's real listeners. The system browser never
 * opens: the app's E2E guard skips shell.openExternal and the specs read the
 * parked attempt's state via the e2e:authPendingState seam instead.
 */

const CLIENT_ID = 'desktop-e2e-client';
/** Both test targets currently accept the production callback scheme. */
const REDIRECT_URI = 'prismical://oauth/callback';
// What the app SENDS as redirect_uri in the token exchange: config/live.ts
// derives it from packaging — unpackaged (the bundle target) uses the RFC 8252
// loopback receiver, packaged keeps the custom scheme. The prismical://
// deliverOpenUrl above stays valid either way (the deep-link queue accepts the
// scheme regardless of which redirect the exchange used). This expectation
// follows the redirect used by each target.
const TOKEN_REDIRECT_URI =
  resolveTarget() === 'packaged'
    ? 'prismical://oauth/callback'
    : 'http://127.0.0.1:17829/oauth/callback';

/**
 * A navigation deep link, `prismical(-dev)://app/<path>`, parses to a Navigate
 * that the consumer forwards as a nav:push. Scheme follows the app under test,
 * exactly like REDIRECT_URI (the bundle target is unpackaged ⇒ the dev scheme).
 */
const NAV_SCHEME = resolveTarget() === 'packaged' ? 'prismical://app' : 'prismical-dev://app';

const authEnv = (server: FakeOAuthServer): Record<string, string> => ({
  PRISMICAL_CORE_API_URL: server.origin,
  PRISMICAL_CLIENT_ID: CLIENT_ID,
});

const pendingState = (page: Page): Promise<string | null> =>
  page.evaluate(() =>
    (
      window as never as {
        desktop: { e2e: { authPendingState: () => Promise<string | null> } };
      }
    ).desktop.e2e.authPendingState()
  );

const getSession = (page: Page): Promise<unknown> =>
  page.evaluate(() =>
    (
      window as never as { desktop: { auth: { getSession: () => Promise<unknown> } } }
    ).desktop.auth.getSession()
  );

/** e2e:sessionProbe — SignedInRuntime acquire/release counters + pinned identity. */
interface SessionProbeSnapshot {
  readonly acquires: number;
  readonly releases: number;
  readonly acquireFailures: number;
  readonly pinned: { readonly sub: string; readonly orgId: string | null } | null;
}

const sessionProbe = (page: Page): Promise<SessionProbeSnapshot> =>
  page.evaluate(() =>
    (
      window as never as {
        desktop: { e2e: { sessionProbe: () => Promise<SessionProbeSnapshot> } };
      }
    ).desktop.e2e.sessionProbe()
  );

/** macOS delivery path: the URL travels as the evaluate ARG (never inlined). */
const deliverOpenUrl = (app: ElectronApplication, url: string): Promise<void> =>
  app.evaluate(({ app: electronApp }, callbackUrl) => {
    electronApp.emit('open-url', { preventDefault: () => {} }, callbackUrl);
  }, url);

/** Win/Linux delivery path: the URL rides a second-instance argv. */
const deliverSecondInstance = (app: ElectronApplication, url: string): Promise<void> =>
  app.evaluate(({ app: electronApp }, callbackUrl) => {
    electronApp.emit(
      'second-instance',
      { preventDefault: () => {} },
      ['/fake/Prismical', callbackUrl],
      '/',
      null
    );
  }, url);

/** A Navigate deep link → nav:push, delivered over the same open-url path. */
const deliverNav = (app: ElectronApplication, appPath: string): Promise<void> =>
  deliverOpenUrl(app, `${NAV_SCHEME}${appPath}`);

/** The hash router's current app path (createHashHistory keeps it in location.hash). */
const routerHash = (page: Page): Promise<string> =>
  page.evaluate(() => window.location.hash);

const openApp = async (
  extraEnv: Record<string, string>
): Promise<{ launch: PrismicalLaunch; page: Page }> => {
  const launch = await launchPrismical(extraEnv);
  const page = await launch.app.firstWindow({ timeout: 60_000 });
  assertNotStaleDevBundle(page.url());
  await page.waitForLoadState('domcontentloaded');
  return { launch, page };
};

/** Click sign-in, wait for the parked attempt, return its state param. */
const startSignIn = async (page: Page): Promise<string> => {
  const gate = page.getByTestId('auth-gate');
  await expect(gate).toHaveAttribute('data-mode', 'gate');
  await page.getByTestId('auth-sign-in').click();
  await expect(gate).toHaveAttribute('data-mode', 'pending');
  await expect(gate).toHaveAttribute('data-gate-state', 'signing-in');
  await expect.poll(() => pendingState(page)).not.toBeNull();
  const state = await pendingState(page);
  expect(state).not.toBeNull();
  return String(state);
};

/** Full happy-path sign-in over the open-url delivery; returns the used state. */
const completeSignIn = async (
  page: Page,
  app: ElectronApplication,
  code = 'C1'
): Promise<string> => {
  const state = await startSignIn(page);
  await deliverOpenUrl(app, `${REDIRECT_URI}?code=${code}&state=${encodeURIComponent(state)}`);
  const gate = page.getByTestId('auth-gate');
  await expect(gate).toHaveAttribute('data-mode', 'session');
  await expect(gate).toHaveAttribute('data-gate-state', 'signed-in');
  return state;
};

/** The per-run main log (the test seam pins electron-log under the profile). */
const readMainLog = (profileDir: string): Promise<string> =>
  readFile(path.join(profileDir, 'logs', 'main.log'), 'utf8').then(
    text => text,
    () => ''
  );

test.describe('authentication flow (fake OIDC server)', () => {
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;
  let second: PrismicalLaunch | undefined;
  /** Profile kept alive across a restart; reaped here even on mid-test failure. */
  let keptProfile: string | undefined;

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await closePrismical(second);
    second = undefined;
    await Promise.all(
      [keptProfile]
        .filter((dir): dir is string => dir !== undefined)
        .map(dir => rm(dir, { recursive: true, force: true }))
    );
    keptProfile = undefined;
    await server?.close();
    server = undefined;
  });

  test('happy path: gate → pending → open-url callback → session, exactly one exchange', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    await completeSignIn(page, launched.app);
    await expect(page.getByTestId('auth-account-email')).toHaveText(server.email);

    // Once signed in, the shared @prismical/app-ui
    // shell mounts past the gate — its overlay is present and the sidebar brand
    // renders (proving the AppShell chrome, not just an empty container/error).
    const shell = page.getByTestId('desktop-shell');
    await expect(shell).toBeVisible();
    await expect(shell.getByRole('img', { name: 'Prismical' })).toBeVisible();
    // The signed-in surface is the account switcher (its trigger carries the
    // sign-out; a dedicated test below drives the dropdown itself).
    await expect(shell.getByTestId('desktop-account-switcher')).toBeVisible();

    // Exactly ONE token request, and it is the JSON code exchange.
    expect(server.tokenRequests()).toHaveLength(1);
    const exchanges = server.exchangeRequests();
    expect(exchanges).toHaveLength(1);
    const body = exchanges[0].body ?? {};
    expect(body['grant_type']).toBe('authorization_code');
    expect(body['client_id']).toBe(CLIENT_ID);
    expect(body['code']).toBe('C1');
    expect(body['redirect_uri']).toBe(TOKEN_REDIRECT_URI);
    // Public client: a client_secret must NEVER be sent.
    expect(body).not.toHaveProperty('client_secret');
    // S256 can't be re-verified server-side (authorize is never hit in E2E, so
    // the challenge never reached the fake server) — assert the verifier's
    // presence and RFC 7636 shape instead (base64url of 32 bytes = 43 chars).
    expect(typeof body['code_verifier']).toBe('string');
    expect(String(body['code_verifier'])).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    // Identity was JWKS-verified (the fake keypair's JWKS was fetched)…
    expect(server.count('/api/auth/jwks')).toBeGreaterThanOrEqual(1);
    // …and the consumed attempt cleared its slot.
    expect(await pendingState(page)).toBeNull();
    // The authorize endpoint is browser territory — never hit in E2E.
    expect(server.count('/api/auth/oauth2/authorize')).toBe(0);

    // Exactly ONE SignedInRuntime acquisition for the one valid callback,
    // pinned to the verified identity. Acquisition failure is silent to the
    // gate UI — only e2e:sessionProbe can observe it.
    await expect.poll(() => sessionProbe(page).then(probe => probe.acquires)).toBe(1);
    const probe = await sessionProbe(page);
    expect(probe.releases).toBe(0);
    expect(probe.acquireFailures).toBe(0);
    expect(probe.pinned?.sub).toBe(server.sub);
  });

  test('account switcher shows the active account and add-account starts a sign-in', async () => {
    // The sidebar-footer switcher is session-view-driven — it renders the
    // signed-in account(s) and reuses the sign-in flow for "Add account". One
    // account proves the surface (a 2nd account needs a 2nd sub, out of this fake
    // server's scope); org switching is intentionally absent — the sanitized
    // SessionView carries no org list; switchOrg stays
    // reachable from the accept-invitation flow).
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    await completeSignIn(page, launched.app);

    // The trigger is the signed-in surface and shows the active account's email.
    const trigger = page.getByTestId('desktop-account-switcher');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText(server.email);

    // Open it: sign-out is offered at the top level, and the account list lives
    // one level in — the shared <AccountSwitcher> (app-ui) puts the accounts and
    // "Add account" in a Radix submenu, whose content isn't mounted until the sub
    // trigger is hovered. Mirrors the shared account-switching spec.
    await trigger.click();
    await expect(page.getByTestId('desktop-sign-out')).toBeVisible();
    const accountSubmenu = page.getByTestId('desktop-account-submenu');
    await expect(accountSubmenu).toBeVisible();
    // CLICK, not hover: Radix opens a sub-trigger on either, but hover-open depends on a
    // pointerenter landing and surviving the open delay, which is flaky under Electron —
    // it opened locally and then failed in a packaged run, leaving the submenu unmounted
    // and the account rows "not found". A click is a single deterministic event.
    await accountSubmenu.click();
    await expect(page.getByTestId('desktop-switch-account')).toContainText(server.email);

    // "Add account" reuses signIn: the browser launch is skipped in E2E, so a new
    // PKCE attempt PARKS — observable via the pending-attempt seam (the consumed
    // sign-in cleared its slot, so a fresh non-null state proves the flow started).
    expect(await pendingState(page)).toBeNull();
    await page.getByTestId('desktop-add-account').click();
    await expect.poll(() => pendingState(page)).not.toBeNull();
  });

  test('transport lane fetches core with a Bearer id_token after sign-in', async () => {
    // The fake OIDC server doubles as fake core, serving the allowlisted
    // /apps/v1/me lane. After sign-in the desktop transport lane is a REAL fetch.
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    await completeSignIn(page, launched.app);

    // Drive the unary lane directly (the shell also fires /me hooks on mount —
    // this pins a deterministic assertion on top of that).
    const result = await page.evaluate(() =>
      (
        window as never as {
          desktop: { transport: { request: (r: unknown) => Promise<unknown> } };
        }
      ).desktop.transport.request({ method: 'GET', path: '/apps/v1/me/notes' })
    );
    // Any completed exchange surfaces as {ok,status,bodyJson}; the fake core
    // answered 200 with its list envelope.
    expect(result).toEqual({ ok: true, status: 200, bodyJson: { results: [] } });

    // Main stamped the Bearer id_token (the renderer never sees a token).
    const meReq = server.requests.find(
      r => r.method === 'GET' && r.path === '/apps/v1/me/notes'
    );
    expect(meReq).toBeDefined();
    expect(meReq?.headers['authorization']).toBe(`Bearer ${server.minted[0].idToken}`);
    // A fresh desktop sign-in has no active org yet, so
    // x-active-org-id is correctly OMITTED — core resolves the user's default.
    expect(meReq?.headers['x-active-org-id']).toBeUndefined();
  });

  test('nav push replays a cold-start backlog on shell mount, then a live push navigates', async () => {
    // Main→renderer nav:push (deep-link / tray / menu) is wired into the
    // hash router. Two paths, one test: the preload nav buffer replays a push that
    // arrived BEFORE the signed-in shell subscribed, and a push that arrives after
    // navigates live.
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    // Cold-start backlog: deliver a Navigate deep link while SIGNED OUT. The shell
    // — and its nav.onPush subscription — has not mounted (the plain-DOM gate owns
    // the surface), so the preload nav buffer holds the push. Wait for main to
    // dispatch it: that pins the "before the shell subscribes" precondition.
    const profileDir = launched.userDataDir;
    await deliverNav(launched.app, '/settings/about');
    await expect.poll(() => readMainLog(profileDir)).toContain('nav push dispatched');

    // Sign in → the shared shell mounts, subscribes to nav.onPush, and the buffered
    // push replays onto the hash router: we land on /settings/about, NOT the /home
    // the index route redirects to on a plain mount.
    await completeSignIn(page, launched.app);
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    await expect.poll(() => routerHash(page)).toBe('#/settings/about');

    // A LIVE push (the shell is subscribed now) navigates straight through.
    await deliverNav(launched.app, '/settings/preferences');
    await expect.poll(() => routerHash(page)).toBe('#/settings/preferences');
  });

  test('collab token channel returns the id_token signed-in and null signed-out', async () => {
    // use-note-collab's token callback reaches main-owned id_token via
    // auth:getCollabToken — the ONE sanctioned full-token crossing to the
    // renderer (the Hocuspocus WSS bearer). A full round-trip needs the note
    // server; here we assert the token PLUMBING (fresh id_token; null when out).
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    const getCollabToken = (): Promise<string | null> =>
      page.evaluate(() =>
        (
          window as never as {
            desktop: { auth: { getCollabToken: () => Promise<string | null> } };
          }
        ).desktop.auth.getCollabToken()
      );

    // Signed OUT before the flow: no live session ⇒ null (never throws).
    expect(await getCollabToken()).toBeNull();

    await completeSignIn(page, launched.app);

    // Signed in: the channel serves the CURRENT main-owned id_token — the SAME
    // token the transport lane stamps as its Bearer (the one sanctioned
    // crossing). The renderer never learns the refresh/access token.
    const collabToken = await getCollabToken();
    expect(collabToken).toBe(server.minted[0].idToken);
    expect(collabToken).not.toContain(server.minted[0].refreshToken);
    expect(collabToken).not.toContain(server.minted[0].accessToken);

    // Sign out tears the SignedInRuntime down ⇒ the accessor clears ⇒ null again.
    // Sign-out lives in the account-switcher dropdown — open it, then click.
    await page.getByTestId('desktop-account-switcher').click();
    await page.getByTestId('desktop-sign-out').click();
    const gate = page.getByTestId('auth-gate');
    await expect(gate).toHaveAttribute('data-gate-state', 'signed-out');
    await expect.poll(() => getCollabToken()).toBeNull();
  });

  test('org switch re-scopes the SignedInRuntime and rejects a non-membership org', async () => {
    // The fake id_token carries TWO org memberships so a switch is
    // meaningful. `window.desktop.auth.switchOrg(<id>)` mutates main's active
    // org (validated against the verified org_users claim) and re-broadcasts the
    // session — identity is (sub, activeOrgId), so the SignedInRuntime tears down
    // and rebuilds under the new org (the e2e:sessionProbe acquire count is the
    // observable proof), and a non-membership org is a logged no-op.
    server = await startFakeOAuthServer({
      orgUsers: [
        { id: 'org_user_e2e_1', org_id: 'org_e2e_1' },
        { id: 'org_user_e2e_2', org_id: 'org_e2e_2' },
      ],
    });
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    await completeSignIn(page, launched.app);

    // A fresh sign-in has no org pick yet: one runtime, pinned org null.
    await expect.poll(() => sessionProbe(page).then(probe => probe.acquires)).toBe(1);
    expect((await sessionProbe(page)).pinned?.orgId).toBeNull();

    const switchOrg = (orgId: string): Promise<void> =>
      page.evaluate(
        id =>
          (
            window as never as {
              desktop: { auth: { switchOrg: (r: { orgId: string }) => Promise<void> } };
            }
          ).desktop.auth.switchOrg({ orgId: id }),
        orgId
      );

    const activeOrgId = async (): Promise<string | null> => {
      const view = (await getSession(page)) as {
        activeSub?: string;
        accounts: ReadonlyArray<{ sub: string; activeOrgId?: string }>;
      };
      const active = view.accounts.find(account => account.sub === view.activeSub);
      return active?.activeOrgId ?? null;
    };

    // Switch into the SECOND membership: (sub, activeOrgId) changes, so the
    // lifecycle closes the old scope and acquires a new one under the new org —
    // the acquire count increments and the pin follows.
    const second = server.orgIds[1];
    await switchOrg(second);
    await expect.poll(() => sessionProbe(page).then(probe => probe.acquires)).toBe(2);
    await expect.poll(() => sessionProbe(page).then(probe => probe.pinned?.orgId)).toBe(second);
    await expect.poll(() => activeOrgId()).toBe(second);
    // Exactly one runtime is ever live: the old scope released before the rebuild
    // (no late fiber from the old scope can snap the org back).
    expect((await sessionProbe(page)).releases).toBe(1);

    // An org NOT in the verified org_users claim is rejected in main
    // (setActiveOrg validates membership) — a logged no-op. Deterministic settle:
    // the rejection lands in the per-run log; the runtime + session are untouched.
    const profileDir = launched.userDataDir;
    await switchOrg('org_not_a_member');
    await expect
      .poll(() => readMainLog(profileDir))
      .toContain('auth:switchOrg ignored — org not a membership');
    const afterInvalid = await sessionProbe(page);
    expect(afterInvalid.acquires).toBe(2);
    expect(afterInvalid.pinned?.orgId).toBe(second);
    expect(await activeOrgId()).toBe(second);

    // A subsequent VALID switch still re-scopes (the channel stayed live through
    // the rejection) — back to the first org, a third acquisition.
    const first = server.orgIds[0];
    await switchOrg(first);
    await expect.poll(() => sessionProbe(page).then(probe => probe.acquires)).toBe(3);
    await expect.poll(() => sessionProbe(page).then(probe => probe.pinned?.orgId)).toBe(first);
    await expect.poll(() => activeOrgId()).toBe(first);

    // The switch args are IDS, never tokens: the session view stays token-free
    // across every switch (contract/sentinel invariant holds — no SENTINEL leak).
    expect(JSON.stringify(await getSession(page))).not.toContain('SENTINEL');
  });

  test('wrong state: no token request ever, the parked attempt survives', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    const state = await startSignIn(page);
    await deliverOpenUrl(
      launched.app,
      `${REDIRECT_URI}?code=C1&state=${encodeURIComponent(`not-${state}`)}`
    );

    // Deterministic settle signal: the rejection lands in the per-run log.
    const profileDir = launched.userDataDir;
    await expect
      .poll(() => readMainLog(profileDir))
      .toContain('oauth callback rejected — no matching attempt');

    expect(server.tokenRequests()).toHaveLength(0);
    // The attempt was NOT consumed — the flow stays recoverable.
    expect(await pendingState(page)).toBe(state);
    await expect(page.getByTestId('auth-gate')).toHaveAttribute('data-mode', 'pending');
    await expect(page.getByTestId('auth-retry')).toBeVisible();
  });

  test('duplicate callback: the attempt is consumed exactly once', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    const state = await completeSignIn(page, launched.app);
    // Same valid callback again — the slot is empty, so it must be rejected.
    await deliverOpenUrl(
      launched.app,
      `${REDIRECT_URI}?code=C1&state=${encodeURIComponent(state)}`
    );
    const profileDir = launched.userDataDir;
    await expect
      .poll(() => readMainLog(profileDir))
      .toContain('oauth callback rejected — no matching attempt');

    expect(server.exchangeRequests()).toHaveLength(1);
    expect(server.tokenRequests()).toHaveLength(1);
    // The session survives the replay untouched.
    await expect(page.getByTestId('auth-gate')).toHaveAttribute('data-mode', 'session');
    // …and the duplicate never re-acquired (or tore down) the SignedInRuntime.
    const probe = await sessionProbe(page);
    expect(probe.acquires).toBe(1);
    expect(probe.releases).toBe(0);
    expect(probe.pinned?.sub).toBe(server.sub);
  });

  test('provider error (access_denied): no exchange, gate returns with the retry affordance', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    const state = await startSignIn(page);
    await deliverOpenUrl(
      launched.app,
      `${REDIRECT_URI}?error=access_denied&state=${encodeURIComponent(state)}`
    );

    // Definitive flow failure: back to the sign-in gate (never a wedged
    // pending surface), attempt slot cleared, and nothing was exchanged.
    const gate = page.getByTestId('auth-gate');
    await expect(gate).toHaveAttribute('data-mode', 'gate');
    await expect(gate).toHaveAttribute('data-gate-state', 'signed-out');
    await expect(page.getByTestId('auth-sign-in')).toBeVisible();
    expect(await pendingState(page)).toBeNull();
    expect(server.tokenRequests()).toHaveLength(0);
  });

  test('second-instance argv delivery signs in (Win/Linux deep-link path)', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    const state = await startSignIn(page);
    await deliverSecondInstance(
      launched.app,
      `${REDIRECT_URI}?code=C2&state=${encodeURIComponent(state)}`
    );

    const gate = page.getByTestId('auth-gate');
    await expect(gate).toHaveAttribute('data-mode', 'session');
    await expect(gate).toHaveAttribute('data-gate-state', 'signed-in');
    await expect(page.getByTestId('auth-account-email')).toHaveText(server.email);
    expect(server.exchangeRequests()).toHaveLength(1);
    expect(server.exchangeRequests()[0].body?.['code']).toBe('C2');
  });

  test('restart restores the session from the secure store via the refresh grant', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;

    await completeSignIn(opened.page, launched.app);
    const profileDir = launched.userDataDir;
    keptProfile = profileDir;
    await closePrismical(launched, { keepProfile: true });
    launched = undefined;

    // Same profile, same fake server — NO sign-in click this run.
    const reopened = await openApp({
      ...authEnv(server),
      PRISMICAL_E2E_USER_DATA_DIR: profileDir,
    });
    second = reopened.launch;
    const gate = reopened.page.getByTestId('auth-gate');
    await expect(gate).toHaveAttribute('data-mode', 'session');
    // 'signed-in' (not just 'refreshing') ⇒ the restore refresh COMPLETED.
    await expect(gate).toHaveAttribute('data-gate-state', 'signed-in');
    await expect(reopened.page.getByTestId('auth-account-email')).toHaveText(server.email);

    // The boot presented the persisted refresh token; codes were NOT re-used.
    const refreshes = server.refreshRequests();
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body?.['grant_type']).toBe('refresh_token');
    expect(refreshes[0].body?.['refresh_token']).toBe(server.minted[0].refreshToken);
    expect(refreshes[0].body?.['client_id']).toBe(CLIENT_ID);
    expect(refreshes[0].body).not.toHaveProperty('client_secret');
    expect(server.exchangeRequests()).toHaveLength(1);

    // Restart-restore acquired a fresh SignedInRuntime (new process — the
    // counters start at zero) pinned to the restored identity.
    await expect.poll(() => sessionProbe(reopened.page).then(probe => probe.acquires)).toBe(1);
    const probe = await sessionProbe(reopened.page);
    expect(probe.releases).toBe(0);
    expect(probe.pinned?.sub).toBe(server.sub);
  });

  test('revoked refresh on restart drops the account and returns to the gate cleanly', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;

    await completeSignIn(opened.page, launched.app);
    const profileDir = launched.userDataDir;
    keptProfile = profileDir;
    await closePrismical(launched, { keepProfile: true });
    launched = undefined;

    server.refreshBehavior = 'revoked';
    const reopened = await openApp({
      ...authEnv(server),
      PRISMICAL_E2E_USER_DATA_DIR: profileDir,
    });
    second = reopened.launch;

    // Definitive 401 ⇒ account dropped; the gate lands signed-out — no crash,
    // no wedged 'offline' shell, and the renderer stays fully responsive.
    const gate = reopened.page.getByTestId('auth-gate');
    await expect(gate).toHaveAttribute('data-mode', 'gate');
    await expect(gate).toHaveAttribute('data-gate-state', 'signed-out');
    await expect(reopened.page.getByTestId('auth-sign-in')).toBeVisible();
    expect(await getSession(reopened.page)).toEqual({ state: 'signed-out', accounts: [] });
    // EXACTLY one boot refresh, presenting exactly the persisted sentinel —
    // any second presentation of the 401-rejected token would trip
    // server-side refresh-family invalidation (>=1 was blind to
    // precisely that replay).
    const refreshes = server.refreshRequests();
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body?.['refresh_token']).toBe(server.minted[0].refreshToken);
  });

  test('sign-out revokes server-side and a relaunch does NOT restore', async () => {
    server = await startFakeOAuthServer();
    const opened = await openApp(authEnv(server));
    launched = opened.launch;
    const page = opened.page;

    await completeSignIn(page, launched.app);
    // The shared shell owns the signed-in surface (it covers the gate
    // placeholder), and sign-out now lives in the account-switcher dropdown, so
    // open it before signing out. Every auth-protocol assertion below (runtime
    // release, server revocation, no restore on relaunch) is unchanged — only the
    // UI trigger moved.
    await page.getByTestId('desktop-account-switcher').click();
    await page.getByTestId('desktop-sign-out').click();
    const gate = page.getByTestId('auth-gate');
    await expect(gate).toHaveAttribute('data-mode', 'gate');
    await expect(gate).toHaveAttribute('data-gate-state', 'signed-out');

    // Sign-out released the one SignedInRuntime; nothing stays pinned.
    await expect.poll(() => sessionProbe(page).then(probe => probe.releases)).toBe(1);
    const probe = await sessionProbe(page);
    expect(probe.acquires).toBe(1);
    expect(probe.acquireFailures).toBe(0);
    expect(probe.pinned).toBeNull();

    // Revocation is fired after local state drops — poll it in.
    await expect.poll(() => server?.revokeRequests().length).toBe(1);
    const revoke = server.revokeRequests()[0];
    expect(revoke.body?.['token']).toBe(server.minted[0].refreshToken);
    expect(revoke.body?.['client_id']).toBe(CLIENT_ID);
    expect(revoke.body).not.toHaveProperty('client_secret');

    const profileDir = launched.userDataDir;
    keptProfile = profileDir;
    await closePrismical(launched, { keepProfile: true });
    launched = undefined;

    // Secret wiped ⇒ the relaunch boots straight to the gate and never even
    // attempts a refresh grant.
    const reopened = await openApp({
      ...authEnv(server),
      PRISMICAL_E2E_USER_DATA_DIR: profileDir,
    });
    second = reopened.launch;
    const gate2 = reopened.page.getByTestId('auth-gate');
    await expect(gate2).toHaveAttribute('data-mode', 'gate');
    await expect(gate2).toHaveAttribute('data-gate-state', 'signed-out');
    // A chosen-cloud profile that signs out lands on the GATE — never back on
    // the first-run chooser.
    await expect(reopened.page.getByTestId('mode-chooser')).toHaveCount(0);
    expect(server.refreshRequests()).toHaveLength(0);
  });
});
