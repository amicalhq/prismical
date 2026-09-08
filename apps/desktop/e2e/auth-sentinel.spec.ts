import { readFile, rm } from 'node:fs/promises';
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
 * Sentinel refresh/access/id tokens appear NOWHERE outside the one sanctioned
 * custody location. Regressions such as plaintext tokens in the operational DB
 * and token responses in logs are asserted here against the REAL app.
 *
 * Scanned surfaces after a full sign-in with sentinel-valued tokens:
 *  (a) the per-run main log file — the test seam pins electron-log under the
 *      e2e profile dir, so this scan is hermetic to THIS run;
 *  (b) the operational DB file bytes (plus WAL/SHM leftovers);
 *  (c) the IPC surfaces: getSession result + captured auth:sessionChanged
 *      pushes (JSON scan);
 *  (d) renderer storage + DOM: localStorage/sessionStorage stay EMPTY,
 *      document carries no token material.
 *
 * Then AGAIN for the refresh path: a restart into the same
 * profile drives the real refresh grant — zero-grace rotation mints the
 * generation-2 sentinel set through DISTINCT code (runRefresh's own persist +
 * log sites) — and every surface is re-scanned for BOTH generations.
 *
 * The sanctioned exception: the secure store. It is not a separate file — it
 * is settings rows inside the operational DB, wrapped by the e2e-fake codec
 * as base64('e2e:<secret>') (secure-store/live.ts; real builds hold OS
 * safeStorage ciphertext instead). The wrapping means RAW sentinel bytes are
 * never legitimately present in the DB, so the DB is scanned in full rather
 * than excluded — and the encoded custody payload is asserted PRESENT, which
 * proves the scan reads the very file that holds the secret.
 *
 * The ONE renderer-facing exception: `auth:getCollabToken` hands
 * the renderer the CURRENT id_token for the Hocuspocus WSS bearer. It is
 * whitelisted EXACTLY here — asserted to return precisely the id_token (and
 * NEVER the refresh/access sentinel) — while every OTHER renderer surface
 * (getSession, the sessionChanged pushes, the DOM, storage) stays token-free.
 */

const CLIENT_ID = 'desktop-e2e-client';
// Both targets currently use the production scheme; see config/live.ts readAuth.
const REDIRECT_URI = 'prismical://oauth/callback';

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

const readOptional = (file: string): Promise<Buffer> =>
  readFile(file).then(
    bytes => bytes,
    () => Buffer.alloc(0)
  );

/**
 * The sync store persists a partition registry in localStorage
 * (`prismical-sync-partition-registry` → { <opaque db-name hash>: <account sub> },
 * see packages/app-client/src/sync/purge.ts). That is by-design product state,
 * NOT token material — the account sub already crosses in the sanitized
 * SessionView. So the renderer-storage scan is keyed on the real invariant:
 * every localStorage key is on this allowlist AND no sentinel appears anywhere
 * in the stored keys/values. A rogue write to a new key still fails the test.
 */
const ALLOWED_LOCAL_STORAGE_KEYS = new Set(['prismical-sync-partition-registry']);

/** (d) renderer storage carries only allowlisted, token-free state, and the
 *  signed-in DOM carries no token material. */
const scanRendererSurfaces = async (
  page: Page,
  email: string,
  sentinels: ReadonlyArray<string>
): Promise<void> => {
  const renderer = await page.evaluate(() => {
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      entries.push([key, localStorage.getItem(key) ?? '']);
    }
    return {
      localStorageEntries: entries,
      sessionStorageLength: sessionStorage.length,
      dom: document.documentElement.outerHTML,
    };
  });
  // No unexpected localStorage keys (a new persistence site must be reviewed).
  for (const [key] of renderer.localStorageEntries) {
    expect(ALLOWED_LOCAL_STORAGE_KEYS.has(key), `unexpected localStorage key: ${key}`).toBe(true);
  }
  // No token material in any stored key OR value.
  const storageBlob = JSON.stringify(renderer.localStorageEntries);
  for (const sentinel of sentinels) {
    expect(storageBlob).not.toContain(sentinel);
  }
  expect(renderer.sessionStorageLength).toBe(0);
  expect(renderer.dom).toContain(email); // the scan saw a real signed-in DOM
  for (const sentinel of sentinels) {
    expect(renderer.dom).not.toContain(sentinel);
  }
};

/** (c) IPC surfaces: getSession + a captured sessionChanged view. The preload
 *  session buffer is multi-subscriber — attaching the capture
 *  never detaches the gate, and the capture is seeded with the LATEST view
 *  synchronously on attach, so no extra push needs to be provoked. */
const scanIpcSurfaces = async (
  page: Page,
  email: string,
  sentinels: ReadonlyArray<string>
): Promise<void> => {
  const captured = await page.evaluate(async () => {
    const w = window as never as {
      desktop: {
        auth: {
          getSession: () => Promise<unknown>;
          onSessionChanged: (cb: (view: unknown) => void) => () => void;
        };
      };
    };
    const pushes: unknown[] = [];
    const off = w.desktop.auth.onSessionChanged(view => pushes.push(view));
    const session = await w.desktop.auth.getSession();
    off();
    return { json: JSON.stringify({ session, pushes }), pushCount: pushes.length };
  });
  expect(captured.pushCount).toBeGreaterThanOrEqual(1); // a real pushed view was scanned
  expect(captured.json).toContain(email);
  expect(captured.json).toContain('signed-in');
  for (const sentinel of sentinels) {
    expect(captured.json).not.toContain(sentinel);
  }
};

/**
 * The WHITELIST: auth:getCollabToken is the ONE renderer channel
 * allowed to carry a full token. Asserted to return EXACTLY the current
 * id_token, and NEVER the refresh/access sentinels (or any other-generation
 * token). Every other surface above is scanned token-free — this is the single
 * bounded exception, not a widening of the scan.
 */
const scanCollabTokenWhitelist = async (
  page: Page,
  idToken: string,
  forbidden: ReadonlyArray<string>
): Promise<void> => {
  const readCollabToken = () =>
    page.evaluate(() =>
      (
        window as never as {
          desktop: { auth: { getCollabToken: () => Promise<string | null> } };
        }
      ).desktop.auth.getCollabToken()
    );
  // The collab token is minted per (re)connect and, by contract, folds to null
  // while a refresh is in flight (e.g. the restore-time rotation) — the real
  // consumer re-fetches on the next connect. Poll for the sanctioned crossing to
  // settle rather than asserting on the first racy read.
  await expect.poll(readCollabToken).toBe(idToken); // the sanctioned crossing IS present…
  const collabToken = await readCollabToken();
  for (const sentinel of forbidden) {
    expect(collabToken).not.toContain(sentinel); // …and carries ONLY the id_token.
  }
};

test.describe('auth sentinel-token scans', () => {
  let server: FakeOAuthServer | undefined;
  let launched: PrismicalLaunch | undefined;
  let second: PrismicalLaunch | undefined;
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

  test('sentinel tokens leak into no log, DB, IPC snapshot, or renderer surface', async () => {
    server = await startFakeOAuthServer();
    launched = await launchPrismical({
      PRISMICAL_CORE_API_URL: server.origin,
      PRISMICAL_CLIENT_ID: CLIENT_ID,
    });
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await page.waitForLoadState('domcontentloaded');

    // Full sign-in with sentinel-valued tokens, driven through the real gate.
    const gate = page.getByTestId('auth-gate');
    await expect(gate).toHaveAttribute('data-mode', 'gate');
    await page.getByTestId('auth-sign-in').click();
    await expect.poll(() => pendingState(page)).not.toBeNull();
    const state = String(await pendingState(page));
    await deliverOpenUrl(
      launched.app,
      `${REDIRECT_URI}?code=SENTINEL-CODE-1&state=${encodeURIComponent(state)}`
    );
    await expect(gate).toHaveAttribute('data-mode', 'session');
    await expect(gate).toHaveAttribute('data-gate-state', 'signed-in');

    expect(server.minted).toHaveLength(1);
    const minted = server.minted[0];
    // The EXACT strings the app received: refresh + access sentinels and the
    // compact signed JWT id_token.
    const sentinels = [minted.refreshToken, minted.accessToken, minted.idToken];

    // (d) + (c) live surfaces for generation 1 (exchange path).
    await scanRendererSurfaces(page, server.email, sentinels);
    await scanIpcSurfaces(page, server.email, sentinels);
    // The one sanctioned crossing: getCollabToken IS the id_token, never the
    // refresh/access sentinel (everything else above stayed token-free).
    await scanCollabTokenWhitelist(page, minted.idToken, [
      minted.refreshToken,
      minted.accessToken,
    ]);

    // Close the app first: DB checkpointed + log flushed; keep the profile
    // for the on-disk scans below.
    const profileDir = launched.userDataDir;
    keptProfile = profileDir;
    await closePrismical(launched, { keepProfile: true });
    launched = undefined;

    // (a) the per-run main log. 'sign-in complete' proves this file is THIS
    // run's auth log (the scan is not vacuous).
    const logText = await readFile(path.join(profileDir, 'logs', 'main.jsonl'), 'utf8');
    expect(logText).toContain('sign-in complete');
    for (const sentinel of sentinels) {
      expect(logText).not.toContain(sentinel);
    }

    // (b) operational DB bytes — NOT excluded (see the header comment): raw
    // sentinels must be absent everywhere in the file…
    const dbBytes = Buffer.concat(
      await Promise.all([
        readFile(path.join(profileDir, 'operational.db')),
        readOptional(path.join(profileDir, 'operational.db-wal')),
        readOptional(path.join(profileDir, 'operational.db-shm')),
      ])
    );
    expect(dbBytes.length).toBeGreaterThan(0);
    for (const sentinel of sentinels) {
      expect(dbBytes.includes(sentinel, 0, 'utf8')).toBe(false);
    }
    // …while the e2e-fake-codec custody payload (base64('e2e:<refresh>')) IS
    // present — the sanctioned location holds the secret, and this scan is
    // reading the very file it lives in.
    const custody = Buffer.from(`e2e:${minted.refreshToken}`, 'utf8').toString('base64');
    expect(dbBytes.includes(custody, 0, 'utf8')).toBe(true);

    // ---------------------------------------------------------------------
    // Generation 2: restart into the same profile — the restore
    // refresh presents the persisted sentinel and the zero-grace rotation
    // mints generation-2 sentinels through runRefresh's OWN persist and log
    // sites. Re-scan every surface for BOTH generations.
    // ---------------------------------------------------------------------
    second = await launchPrismical({
      PRISMICAL_CORE_API_URL: server.origin,
      PRISMICAL_CLIENT_ID: CLIENT_ID,
      PRISMICAL_E2E_USER_DATA_DIR: profileDir,
    });
    const page2 = await second.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page2.url());
    await page2.waitForLoadState('domcontentloaded');
    const gate2 = page2.getByTestId('auth-gate');
    await expect(gate2).toHaveAttribute('data-mode', 'session');
    // 'signed-in' (not 'refreshing') ⇒ the rotation COMPLETED before scanning.
    await expect(gate2).toHaveAttribute('data-gate-state', 'signed-in');

    expect(server.minted).toHaveLength(2);
    const rotated = server.minted[1];
    const bothGenerations = [
      ...sentinels,
      rotated.refreshToken,
      rotated.accessToken,
      rotated.idToken,
    ];

    // (d) + (c) live surfaces again, now against BOTH generations.
    await scanRendererSurfaces(page2, server.email, bothGenerations);
    await scanIpcSurfaces(page2, server.email, bothGenerations);
    // The sanctioned crossing now serves the ROTATED id_token (the restore
    // refresh advanced the active token); still NEVER any refresh/access sentinel.
    await scanCollabTokenWhitelist(page2, rotated.idToken, [
      minted.refreshToken,
      minted.accessToken,
      rotated.refreshToken,
      rotated.accessToken,
    ]);

    await closePrismical(second, { keepProfile: true });
    second = undefined;

    // (a) the log now covers both runs (electron-log appends): 'refresh
    // complete' proves the rotation path logged into THIS file.
    const logText2 = await readFile(path.join(profileDir, 'logs', 'main.jsonl'), 'utf8');
    expect(logText2).toContain('refresh complete');
    for (const sentinel of bothGenerations) {
      expect(logText2).not.toContain(sentinel);
    }

    // (b) DB bytes: no raw sentinel of EITHER generation anywhere…
    const dbBytes2 = Buffer.concat(
      await Promise.all([
        readFile(path.join(profileDir, 'operational.db')),
        readOptional(path.join(profileDir, 'operational.db-wal')),
        readOptional(path.join(profileDir, 'operational.db-shm')),
      ])
    );
    expect(dbBytes2.length).toBeGreaterThan(0);
    for (const sentinel of bothGenerations) {
      expect(dbBytes2.includes(sentinel, 0, 'utf8')).toBe(false);
    }
    // …and the ROTATION write went through the custody codec too: the
    // generation-2 encoded payload is present. (Generation 1's encoded row
    // was overwritten; stale copies may linger in SQLite free pages, which is
    // fine — it was always ciphertext-shaped, never a raw sentinel.)
    const custody2 = Buffer.from(`e2e:${rotated.refreshToken}`, 'utf8').toString('base64');
    expect(dbBytes2.includes(custody2, 0, 'utf8')).toBe(true);
  });
});
