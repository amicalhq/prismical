import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, type Page } from '@playwright/test';
import type { TransportResponse } from '@prismical/desktop-contracts';
import { createLocalModeProfile } from './helpers/local-profile';
import {
  launchPrismical,
  closePrismical,
  assertNotStaleDevBundle,
  type PrismicalLaunch,
} from './helpers/launch';

/**
 * Local-mode data plane, end to end: a profile seeded with
 * the `app:mode = 'local'` operational KV row boots straight into the product
 * shell — no auth gate, no sign-in, and NO server of any kind (unlike every
 * other spec, nothing here starts a fake OAuth/core). Notes are served by the
 * in-main local backend over the same transport lane cloud mode proxies to
 * core, and note bodies ride the collab:open log/relay through local.db.
 *
 * Fresh profiles stay cloud (the KV row is simply absent), which is what keeps
 * smoke/contract/auth pinning the cloud invariants untouched — these specs are
 * the local twins, each on its own seeded profile and its own full app boot
 * per the harness discipline.
 */

/** e2e:sessionProbe — workspace acquire/release counters + pinned identity. */
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

/** One GET through the renderer transport lane (settled envelope, never throws). */
const transportGet = (
  page: Page,
  request: { path: string; query?: Record<string, string> }
): Promise<TransportResponse> =>
  page.evaluate(req => window.desktop.transport.request({ method: 'GET', ...req }), request);

/** The `ai` device-settings record as the renderer reads it (never a key). */
interface AiSettingSnapshot {
  provider: string;
  model: string | null;
  baseUrl: string | null;
}
const aiSetting = (page: Page): Promise<AiSettingSnapshot> =>
  page.evaluate(() =>
    (
      window as never as {
        desktop: { settings: { get: () => Promise<{ ai: AiSettingSnapshot }> } };
      }
    ).desktop.settings
      .get()
      .then(settings => settings.ai)
  );
const deviceSettingsJson = (page: Page): Promise<string> =>
  page.evaluate(() =>
    (window as never as { desktop: { settings: { get: () => Promise<unknown> } } }).desktop.settings
      .get()
      .then(settings => JSON.stringify(settings))
  );
const readOptional = (file: string): Promise<Buffer> =>
  readFile(file).catch(() => Buffer.alloc(0));

/** A key that could only be in the DB/log because THIS test put it there. */
const AI_KEY = 'sk-e2e-local-sentinel-7b2e41';

/** Launch into a seeded local profile and wait for the shell to own the surface. */
const openLocalApp = async (
  profileDir: string,
  extraEnv: Record<string, string> = {}
): Promise<{ launch: PrismicalLaunch; page: Page }> => {
  const launch = await launchPrismical({ PRISMICAL_E2E_USER_DATA_DIR: profileDir, ...extraEnv });
  const page = await launch.app.firstWindow({ timeout: 60_000 });
  assertNotStaleDevBundle(page.url());
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('desktop-shell')).toBeVisible();
  return { launch, page };
};

/** Create a note through the UI (the dock's New-note face) and land on it. */
const createNoteViaUi = async (page: Page): Promise<string> => {
  const newNote = page.getByRole('button', { name: 'New note' });
  // Enabled when the initial sync settled against the local
  // backend — the first real proof the whole pull lane works serverless.
  await expect(newNote).toBeEnabled();
  await newNote.click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/notes\/nt_/);
  const hash = await page.evaluate(() => window.location.hash);
  return hash.replace('#/notes/', '');
};

/** The ProseMirror body surface, hydrated and editable (ready to type into). */
const editorSurface = async (page: Page) => {
  const editor = page.locator('.note-prose');
  await expect(editor).toBeVisible();
  // Editable ⇔ the log hydration settled (local mode: hydration IS the sync point).
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  return editor;
};

test.describe('local mode (seeded app:mode profile, no servers)', () => {
  let launched: PrismicalLaunch | undefined;
  /** Profile kept alive across a relaunch; reaped here even on mid-test failure. */
  let keptProfile: string | undefined;

  test.afterEach(async () => {
    await closePrismical(launched);
    launched = undefined;
    await Promise.all(
      [keptProfile]
        .filter((dir): dir is string => dir !== undefined)
        .map(dir => rm(dir, { recursive: true, force: true }))
    );
    keptProfile = undefined;
  });

  test('boots into the shell with no auth gate and one accountless workspace', async () => {
    const profileDir = await createLocalModeProfile();
    launched = await launchPrismical({ PRISMICAL_E2E_USER_DATA_DIR: profileDir });
    const page = await launched.app.firstWindow({ timeout: 60_000 });
    assertNotStaleDevBundle(page.url());
    await page.waitForLoadState('domcontentloaded');

    // The inversion of smoke.spec's cloud invariant: the product shell IS the
    // boot surface. The gate root is never mounted at all (count 0, not merely
    // hidden) — its drag strip would swallow the shell's top-strip clicks.
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    await expect(page.getByTestId('auth-gate')).toHaveCount(0);

    // Exactly one workspace mounted at boot, accountless: local workspaces
    // count with pinned null (workspace-lifecycle probe contract).
    await expect.poll(() => sessionProbe(page).then(probe => probe.acquires)).toBe(1);
    expect(await sessionProbe(page)).toEqual({
      acquires: 1,
      releases: 0,
      acquireFailures: 0,
      pinned: null,
    });
  });

  test('transport:request is served by the local backend — no server, no INTERNAL', async () => {
    const profileDir = await createLocalModeProfile();
    const opened = await openLocalApp(profileDir);
    launched = opened.launch;
    const page = opened.page;

    // The inversion of contract.spec's signed-out pin: there, an allowlisted
    // GET settles {error:{code:'INTERNAL'}} because no backend is registered.
    // Here the local workspace registers its backend at mount — poll past the
    // (legitimate) pre-registration beat, then pin the served envelope.
    await expect
      .poll(async () => 'ok' in (await transportGet(page, { path: '/apps/v1/me/notes' })))
      .toBe(true);

    const res = (await transportGet(page, { path: '/apps/v1/me/notes' })) as {
      ok: true;
      status: number;
      bodyJson: { results: unknown[] };
    };
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.bodyJson).not.toHaveProperty('success');
    expect(Array.isArray(res.bodyJson.results)).toBe(true);

    // The pre-dispatch gates are mode-independent — foreign paths still never
    // reach a backend (same pin as contract.spec, now with a backend mounted).
    const foreign = await page.evaluate(() =>
      window.desktop.transport.request({ method: 'GET', path: '/v1/other' })
    );
    expect(foreign).toEqual({ error: { code: 'PATH_NOT_ALLOWED' } });
  });

  test('a note and its typed body survive an offline relaunch (log replay)', async () => {
    const bodyLine = `Local round-trip proof ${Date.now()}`;
    const profileDir = await createLocalModeProfile();
    keptProfile = profileDir;
    const first = await openLocalApp(profileDir);
    launched = first.launch;

    const noteId = await createNoteViaUi(first.page);
    const editor = await editorSurface(first.page);
    await editor.click();
    await editor.pressSequentially(bodyLine);
    await expect(editor).toContainText(bodyLine);

    // Persisted signal, not a bare timeout: the debounced flush projects the
    // body into the note row (contentText) in local.db — poll the local
    // backend itself until the projection landed, THEN close.
    await expect
      .poll(async () => {
        const res = await transportGet(first.page, {
          path: '/apps/v1/me/notes',
          query: { includeBody: '1' },
        });
        const body = ('ok' in res ? res.bodyJson : {}) as {
          results?: { id: string; contentText?: string | null }[];
        };
        return (body.results ?? []).find(row => row.id === noteId)?.contentText ?? '';
      })
      .toContain(bodyLine);

    // The shell's whole local request storm (boot, org/profile,
    // initial sync, home-route reads, the note lanes above) rides /apps/v1/me/*
    // — nothing tripped the transport path validator, so it needed NO
    // relaxation for local mode. Rejections are warn-logged with the path.
    const mainLog = await readFile(
      path.join(profileDir, 'logs', 'main.jsonl'),
      'utf8'
    ).catch(() => '');
    expect(mainLog.length).toBeGreaterThan(0);
    expect(mainLog).not.toContain('path not allowed');

    await closePrismical(launched, { keepProfile: true });
    launched = undefined;

    // Same profile, still no server anywhere.
    const second = await openLocalApp(profileDir);
    launched = second.launch;

    // The note is listed — the flush's title-follow renamed the placeholder to
    // the first typed line, so the list row carries the distinctive text…
    await second.page.getByRole('link', { name: 'Notes', exact: true }).click();
    const noteLink = second.page.getByRole('link', { name: bodyLine }).first();
    await expect(noteLink).toBeVisible();

    // …and opening it replays the body log out of local.db into the editor.
    await noteLink.click();
    const editorAfter = await editorSurface(second.page);
    await expect(editorAfter).toContainText(bodyLine);
  });

  test('the Local models screen lists the linked whisper catalogue offline', async () => {
    const profileDir = await createLocalModeProfile();
    const opened = await openLocalApp(profileDir);
    launched = opened.launch;
    const page = opened.page;

    // The desktop-owned screen hangs off the 'local-models' capability:
    // a nav entry in the shared sidebar, a route in desktop's router.
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Local models', exact: true }).click();
    await expect(page.getByTestId('local-models-list')).toBeVisible();

    // The whole linked catalogue, recommended entry first, nothing installed,
    // nothing in flight — and NOTHING is downloaded here (no network in e2e).
    const rows = page.getByTestId('local-model-row');
    await expect(rows).toHaveCount(7);
    await expect(rows.first()).toHaveAttribute('data-model-id', 'whisper-base-en');
    await expect(page.getByTestId('local-model-recommended')).toHaveCount(1);
    await expect(rows.first().getByTestId('local-model-recommended')).toBeVisible();
    await expect(rows.filter({ has: page.getByRole('button', { name: 'Download' }) })).toHaveCount(
      7
    );
    await expect(page.getByTestId('local-model-progress')).toHaveCount(0);
    await expect(page.getByTestId('local-model-active')).toHaveCount(0);
    // The weights dir lives inside the (isolated) profile.
    await expect(page.getByTestId('local-models-dir')).toHaveText(/models$/);

    // The engine card is slotted into the shared Transcription screen here too.
    // Local mode has no Prismical Cloud engine to offer: the stored
    // default 'cloud' is shown as the on-device engine main coerces it to.
    await page.getByRole('link', { name: 'Transcription', exact: true }).click();
    await expect(page.getByTestId('transcription-engine')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Prismical Cloud' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'On this device' })).toBeChecked();
  });

  test('two windows converge through the main relay with no server (main ↔ float)', async () => {
    const mainLine = `From the main window ${Date.now()}`;
    const floatLine = 'And back from the float window';
    const profileDir = await createLocalModeProfile();
    const opened = await openLocalApp(profileDir);
    launched = opened.launch;
    const page = opened.page;

    const noteId = await createNoteViaUi(page);
    const mainEditor = await editorSurface(page);

    // Summon the float window for the same note (float.spec drives the same
    // preload call; the UI affordance routes through it too).
    await page.evaluate(id => window.desktop.float.open(id), noteId);
    await expect
      .poll(() => launched!.app.windows().filter(w => w.url().includes('#/float')).length)
      .toBe(1);
    const floatPage = launched.app.windows().find(w => w.url().includes('#/float'));
    expect(floatPage, 'floating note renderer').toBeDefined();
    await floatPage!.waitForLoadState('domcontentloaded');
    const floatEditor = await editorSurface(floatPage!);

    // Main → float: typing relays through main's collab broker (append to
    // local.db, fan out to the other window's port) — no server involved.
    await mainEditor.click();
    await mainEditor.pressSequentially(mainLine);
    await expect(floatEditor).toContainText(mainLine);

    // Float → main: the reverse direction over the same relay.
    await floatEditor.click();
    await floatEditor.pressSequentially(floatLine);
    await expect(mainEditor).toContainText(floatLine);
  });

  for (const [provider, label] of [
    ['openai', 'OpenAI'],
    ['openrouter', 'OpenRouter'],
  ] as const) {
    test(`AI provider card round-trips settings + key custody with no server (${label})`, async () => {
      const profileDir = await createLocalModeProfile();
      const opened = await openLocalApp(profileDir);
      launched = opened.launch;
      const page = opened.page;

      // The desktop-owned provider card renders through the
      // shared AI-models screen's named slot; the stored default is OpenAI.
      await page.evaluate(() => {
        window.location.hash = '#/settings/ai-models';
      });
      await expect(page.getByTestId('ai-provider')).toBeVisible();
      await expect(page.getByRole('radio', { name: 'OpenAI', exact: true })).toBeChecked();

      if (provider === 'openai') {
        // Every supported local provider is selectable without an account or plan.
        for (const [name, kind] of [
          ['Anthropic', 'anthropic'],
          ['OpenRouter', 'openrouter'],
          ['OpenAI-compatible endpoint', 'openai-compatible'],
          ['Ollama', 'ollama'],
          ['OpenAI', 'openai'],
        ]) {
          const option = page.getByRole('radio', { name, exact: true });
          await option.click();
          await expect(option).toBeChecked();
          await expect.poll(() => aiSetting(page)).toEqual({ provider: kind, model: null, baseUrl: null });
          await expect(page.getByTestId('ai-provider-fields')).toBeVisible();
        }
      }
      await page.getByRole('radio', { name: label, exact: true }).click();
      await expect.poll(() => aiSetting(page)).toEqual({ provider, model: null, baseUrl: null });
      await page.getByLabel('Model', { exact: true }).fill('test-model');
      await page.getByLabel('Model', { exact: true }).press('Enter');
      await expect
        .poll(() => aiSetting(page))
        .toEqual({ provider, model: 'test-model', baseUrl: null });

      // The key rides the capability channel into the secure store: never
      // pre-filled, never in device settings, `has` answers a boolean.
      await expect(page.getByTestId('ai-provider-key-status')).toHaveAttribute('data-has-key', 'false');
      await page.getByLabel('API key', { exact: true }).fill(AI_KEY);
      await page.getByRole('button', { name: 'Save key' }).click();
      await expect(page.getByTestId('ai-provider-key-status')).toHaveAttribute('data-has-key', 'true');
      await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
      expect(await deviceSettingsJson(page)).not.toContain(AI_KEY);
      // Public catalogues may load with a bogus key; otherwise the card shows
      // a reason. Either result must let the user save their configuration.
      await expect(page.getByTestId('ai-provider-catalogue')).toHaveAttribute(
        'data-state',
        /^(ready|unauthorized|network)$/
      );

      // The synthetic instances lane lists the configured, enabled provider —
      // what the Ask picker groups.
      const instances = await transportGet(page, { path: '/apps/v1/me/instances' });
      expect(instances).toMatchObject({ ok: true, status: 200 });
      const providers = (
        (instances as { bodyJson: { results: Array<{ provider: string }> } }).bodyJson.results
      ).map(row => row.provider);
      // A running local Ollama runtime can also appear in the picker.
      expect(providers).toContain(provider);

      const kept = profileDir;
      keptProfile = kept;
      await closePrismical(launched, { keepProfile: true });
      launched = undefined;

      // On disk, the raw key is absent from the operational DB and
      // the main log, while the e2e-fake secure-store custody payload IS present.
      const dbBytes = Buffer.concat(
        await Promise.all([
          readFile(path.join(kept, 'operational.db')),
          readOptional(path.join(kept, 'operational.db-wal')),
          readOptional(path.join(kept, 'operational.db-shm')),
        ])
      );
      expect(dbBytes.length).toBeGreaterThan(0);
      expect(dbBytes.includes(AI_KEY, 0, 'utf8')).toBe(false);
      const custody = Buffer.from(`e2e:${AI_KEY}`, 'utf8').toString('base64');
      expect(dbBytes.includes(custody, 0, 'utf8')).toBe(true);
      const mainLog = await readFile(path.join(kept, 'logs', 'main.jsonl'), 'utf8');
      expect(mainLog.length).toBeGreaterThan(0);
      expect(mainLog).not.toContain(AI_KEY);

      const reopened = await openLocalApp(kept);
      launched = reopened.launch;
      const page2 = reopened.page;
      await page2.evaluate(() => {
        window.location.hash = '#/settings/ai-models';
      });
      await expect(page2.getByRole('radio', { name: label, exact: true })).toBeChecked();
      await expect.poll(() => aiSetting(page2)).toEqual({ provider, model: 'test-model', baseUrl: null });
      await expect(page2.getByTestId('ai-provider-key-status')).toHaveAttribute('data-has-key', 'true');
      await expect(page2.getByLabel('API key', { exact: true })).toHaveValue('');

      // Each provider keeps a separate key slot after restart.
      await page2.getByRole('radio', {
        name: provider === 'openai' ? 'OpenRouter' : 'OpenAI', exact: true,
      }).click();
      await expect(page2.getByTestId('ai-provider-key-status')).toHaveAttribute('data-has-key', 'false');
    });
  }

  test('Ask configuration errors show local recovery actions from the envelope', async () => {
    const profileDir = await createLocalModeProfile();
    const opened = await openLocalApp(profileDir);
    launched = opened.launch;
    const page = opened.page;

    await page.evaluate(() => { window.location.hash = '#/settings/ai-models'; });
    await expect(page.getByTestId('ai-provider')).toBeVisible();
    await page.getByLabel('Model', { exact: true }).fill('test-model');
    await page.getByLabel('Model', { exact: true }).press('Enter');
    await expect.poll(() => aiSetting(page)).toMatchObject({ model: 'test-model' });
    await expect(page.getByTestId('ai-provider-key-status')).toHaveAttribute('data-has-key', 'false');
    await page.evaluate(() => { window.location.hash = '#/notes'; });
    await createNoteViaUi(page);
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const composer = page.getByLabel('Ask anything — / for skills, @ to tag notes');
    await composer.fill('Hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText('AI isn’t set up for this workspace yet.')).toBeVisible();
    await expect(page.getByText('Add an API key or connect a local runtime in Settings → AI models.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use Prismical Cloud', exact: true })).toHaveCount(0);
    await expect(page.getByText('prismicalError', { exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open AI models', exact: true }).click();
    await expect(page.getByTestId('ai-provider')).toBeVisible();
  });

  test('Cleanup, Name-note and Ask run against the scripted provider with no server', async () => {
    const profileDir = await createLocalModeProfile();
    const opened = await openLocalApp(profileDir, { PRISMICAL_E2E_FAKE_AI: '1' });
    launched = opened.launch;
    const page = opened.page;

    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.log(`[renderer ${message.type()}] ${message.text()}`);
      }
    });
    const noteId = await createNoteViaUi(page);
    const editor = await editorSurface(page);
    await editor.click();
    await editor.pressSequentially('Launch plan for Q3 with the whole team');
    await expect(editor).toContainText('Launch plan for Q3');

    // The dock suggests Cleanup (a seeded system skill) — its chip reads
    // "/ Cleanup"; the run lands in the diff bar and Keep applies the fake
    // output into the live editor.
    await page.getByRole('button', { name: '/ Cleanup', exact: true }).click();
    await page.getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(editor).toContainText('This is a deterministic local test summary.');

    // The accept wrote the artifact row through the local lane.
    await expect
      .poll(async () => {
        const res = await transportGet(page, { path: '/apps/v1/me/artifacts', query: { noteId } });
        return 'ok' in res && res.ok
          ? (res.bodyJson as { results: unknown[] }).results.length
          : -1;
      })
      .toBe(1);

    // Name-note: the naming lane returns the fake title, apply lands it in the
    // title field (revision CAS through the local title lock).
    await page.getByRole('button', { name: 'Name with AI' }).click();
    await expect(page.getByLabel('Note title')).toHaveValue('Product launch planning').catch(
      async error => {
        const log = await readFile(path.join(launched!.userDataDir, 'logs', 'main.jsonl'), 'utf8');
        const lines = log.split('\n');
        const picked = new Set<number>();
        lines.forEach((line, index) => {
          if (/title|skill run|local backend/i.test(line)) {
            for (let i = index; i < Math.min(lines.length, index + 8); i += 1) picked.add(i);
          }
        });
        console.log([...picked].sort((a, b) => a - b).map(i => lines[i]).slice(-60).join('\n'));
        throw error;
      }
    );

    // Ask: the stream rides the SAME broker as cloud mode; the answer is the
    // fake's deterministic text.
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const composer = page.getByLabel('Ask anything — / for skills, @ to tag notes');
    await composer.click();
    await composer.pressSequentially('What is this note about?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('This is a deterministic local answer.')).toBeVisible();
  });

  test('cloud-only surfaces are unreachable: no nav entries, no share, hash hits bounce home, local footer', async () => {
    const profileDir = await createLocalModeProfile();
    const opened = await openLocalApp(profileDir);
    launched = opened.launch;
    const page = opened.page;

    // The sidebar footer is the local-workspace footer, not the account switcher.
    await expect(page.getByTestId('desktop-workspace-footer')).toBeVisible();
    await expect(page.getByTestId('desktop-account-switcher')).toHaveCount(0);
    // Primary nav: no People, no Shared with me; Home stays.
    await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'People', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Shared with me', exact: true })).toHaveCount(0);

    // Settings nav: the cloud-only entries are gone; the local ones remain.
    await page.evaluate(() => {
      window.location.hash = '#/settings/preferences';
    });
    await expect(page.getByRole('link', { name: 'Local models', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Advanced', exact: true })).toBeVisible();
    for (const entry of ['Members', 'Account', 'Billing', 'Calendar', 'Integrations', 'API & MCP']) {
      await expect(page.getByRole('link', { name: entry, exact: true })).toHaveCount(0);
    }

    // Route-level: a typed hash (or a main-side nav push) to a cloud-only
    // route redirects home before any screen mounts.
    for (const hash of [
      '#/settings/members',
      '#/settings/account',
      '#/settings/billing',
      '#/settings/calendar',
      '#/settings/integrations',
      '#/settings/api-keys',
      '#/people',
      '#/people/person-local',
      '#/companies',
      '#/companies/company-local',
      '#/shared',
      '#/events',
    ]) {
      await page.evaluate(target => {
        window.location.hash = target;
      }, hash);
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/home');
    }

    // The note header has no Share control (sharing is a cloud feature).
    await createNoteViaUi(page);
    await editorSurface(page);
    await expect(page.getByRole('button', { name: 'Share note', exact: true })).toHaveCount(0);

    // AI models: the provider card stands alone — no managed defaults, no
    // instance CRUD, no add-a-provider tiles.
    await page.evaluate(() => {
      window.location.hash = '#/settings/ai-models';
    });
    await expect(page.getByTestId('ai-provider')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change model', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Add a provider' })).toHaveCount(0);

    // Transcription: no Prismical Cloud engine to pick; on-device is the choice.
    await page.evaluate(() => {
      window.location.hash = '#/settings/transcription';
    });
    await expect(page.getByTestId('transcription-engine')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Prismical Cloud' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'On this device' })).toBeChecked();

    // The footer leads to the mode switch on the Advanced screen.
    await page.getByTestId('desktop-workspace-footer').click();
    await page.getByTestId('desktop-workspace-switch-mode').click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/settings/advanced');
    await expect(page.getByTestId('app-mode')).toHaveAttribute('data-mode', 'local');
  });

  test('switching to a Prismical account is a destructive reset: data, keys and identity go; the next boot is the gate', async () => {
    const profileDir = await createLocalModeProfile();
    keptProfile = profileDir;
    const opened = await openLocalApp(profileDir);
    launched = opened.launch;
    const page = opened.page;

    // State a reset must sever: a note body in local.db, an AI key in the
    // secure store, a non-default device setting.
    await createNoteViaUi(page);
    const editor = await editorSurface(page);
    await editor.click();
    await editor.pressSequentially('Erase me on switch');
    await expect(editor).toContainText('Erase me on switch');
    await page.evaluate(() => {
      window.location.hash = '#/settings/ai-models';
    });
    await expect(page.getByTestId('ai-provider')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'OpenAI', exact: true })).toBeChecked();
    await page.getByLabel('Model', { exact: true }).fill('test-model');
    await page.getByLabel('Model', { exact: true }).press('Enter');
    await expect.poll(() => aiSetting(page)).toMatchObject({ provider: 'openai', model: 'test-model' });
    await expect(page.getByTestId('ai-provider-key-status')).toHaveAttribute('data-has-key', 'false');
    await page.getByLabel('API key', { exact: true }).fill(AI_KEY);
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByTestId('ai-provider-key-status')).toHaveAttribute('data-has-key', 'true');
    expect(existsSync(path.join(profileDir, 'local.db'))).toBe(true);

    // The switch: confirm → main clears the device state, writes app:mode and
    // (under isE2E) quits instead of relaunching.
    await page.evaluate(() => {
      window.location.hash = '#/settings/advanced';
    });
    await expect(page.getByTestId('app-mode')).toHaveAttribute('data-mode', 'local');
    await page.getByTestId('app-mode-switch').click();
    await expect(page.getByTestId('app-mode-confirm')).toBeVisible();
    const exited = launched.app.waitForEvent('close');
    await page.getByTestId('app-mode-confirm-action').click();
    await exited;
    launched = undefined;

    // In-process half, on disk: mode written, device settings + secrets gone,
    // purge marker pending, product store still present (the purge is boot-time).
    const readRows = (): Record<string, string> => {
      const db = new DatabaseSync(path.join(profileDir, 'operational.db'), { readOnly: true });
      try {
        return Object.fromEntries(
          (
            db.prepare('SELECT key, value FROM settings').all() as Array<{
              key: string;
              value: string;
            }>
          ).map(row => [row.key, row.value])
        );
      } finally {
        db.close();
      }
    };
    const afterSwitch = readRows();
    expect(afterSwitch['app:mode']).toBe('cloud');
    expect(Object.keys(afterSwitch).some(key => key.startsWith('pref:'))).toBe(false);
    expect(afterSwitch['secure:ai.openai.apiKey']).toBeUndefined();
    const marker = JSON.parse(afterSwitch['app:pendingPurge'] ?? 'null') as {
      v: number;
      paths: string[];
      localModels: boolean;
    } | null;
    expect(marker).not.toBeNull();
    expect(marker!.paths).toContain(path.join(profileDir, 'local.db'));
    expect(marker!.paths).toContain(path.join(profileDir, 'models'));
    expect(marker!.localModels).toBe(true);
    const custody = Buffer.from(`e2e:${AI_KEY}`, 'utf8').toString('base64');
    const dbBytes = Buffer.concat(
      await Promise.all([
        readFile(path.join(profileDir, 'operational.db')),
        readOptional(path.join(profileDir, 'operational.db-wal')),
      ])
    );
    expect(dbBytes.includes(custody, 0, 'utf8')).toBe(false);
    expect(existsSync(path.join(profileDir, 'local.db'))).toBe(true);

    // Boot-time half: the relaunch purges the product store, models and
    // recovery trees before anything opens them, then shows the sign-in gate.
    const relaunched = await launchPrismical({ PRISMICAL_E2E_USER_DATA_DIR: profileDir });
    launched = relaunched;
    keptProfile = undefined; // closePrismical reaps it now
    const gatePage = await relaunched.app.firstWindow({ timeout: 60_000 });
    await gatePage.waitForLoadState('domcontentloaded');
    await expect(gatePage.getByTestId('auth-gate')).toHaveAttribute('data-mode', 'gate');
    await expect(gatePage.getByTestId('mode-chooser')).toHaveCount(0);
    await expect(gatePage.getByTestId('desktop-shell')).toHaveCount(0);
    await expect.poll(() => readRows()['app:pendingPurge']).toBeUndefined();
    expect(existsSync(path.join(profileDir, 'local.db'))).toBe(false);
    expect(existsSync(path.join(profileDir, 'local.db-wal'))).toBe(false);
    expect(existsSync(path.join(profileDir, 'models'))).toBe(false);
    expect(existsSync(path.join(profileDir, 'recovery'))).toBe(false);
    expect(existsSync(path.join(profileDir, 'cloud-cache'))).toBe(false);
  });
});
