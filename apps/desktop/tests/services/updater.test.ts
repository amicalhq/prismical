/**
 * Auto-updater tests.
 *
 * Part 1 — UpdaterMachine unit tests: the state machine driven
 * directly with a fake native updater + scripted metadata, no Effect and no
 * electron (the machine is dependency-injected by design).
 *
 * Part 2 — UpdaterServiceLive layer tests: scheduling cadence on the TestClock,
 * the settings channel subscription, the disabled lane, and the leak gate
 * (no check after scope close). The real check hops through a promise, so
 * completion is polled on REAL time after each virtual-clock advance.
 */
import { assert, describe as edescribe, it as eit } from '@effect/vitest';
import { Context, Duration, Effect, Exit, Layer, Scope, SubscriptionRef, TestClock } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAutoUpdater, type FakeElectron } from '../helpers/fake-electron';
import { testTelemetryLayer } from '../helpers/telemetry';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { UpdaterMachine, type UpdateMetadata } from '../../src/main/domains/updater/machine';
import { SettingsService } from '../../src/main/domains/settings/service';
import { SettingsServiceLive } from '../../src/main/domains/settings/live';
import { UpdaterService } from '../../src/main/domains/updater/service';
import { UpdaterServiceLive } from '../../src/main/domains/updater/live';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fakeElectron = (await import('electron')) as unknown as FakeElectron;

// ---------------------------------------------------------------------------
// Part 1 — machine unit tests
// ---------------------------------------------------------------------------

interface Harness {
  machine: UpdaterMachine;
  native: FakeAutoUpdater;
  setMetadata: (value: UpdateMetadata | 'fail' | Promise<UpdateMetadata>) => void;
  logs: Array<{ level: string; message: string }>;
}

const DOWNLOAD_CYCLE: Array<[string, ...unknown[]]> = [
  ['checking-for-update'],
  ['update-available'],
  ['update-downloaded', {}, 'release notes', '0.2.0'],
];

function makeHarness(): Harness {
  const native = new FakeAutoUpdater();
  const logs: Array<{ level: string; message: string }> = [];
  let metadata: UpdateMetadata | 'fail' | Promise<UpdateMetadata> = {
    action: 'silent',
    version: '0.2.0',
  };
  const machine = new UpdaterMachine({
    updateServerUrl: 'https://core.test',
    getDeviceId: async () => 'test-device-id',
    appVersion: '0.1.0',
    platform: 'darwin',
    arch: 'arm64',
    native,
    fetchFn: async () => {
      if (metadata === 'fail') return new Response('down', { status: 500 });
      return Response.json(await metadata);
    },
    log: (level, message) => logs.push({ level, message }),
    onChanged: () => undefined,
  });
  machine.initialize('stable');
  return { machine, native, setMetadata: value => (metadata = value), logs };
}

describe('UpdaterMachine', () => {
  it('identifies metadata and native feed requests with the running version', async () => {
    const native = new FakeAutoUpdater();
    const fetchFn = vi.fn(async () => Response.json({ action: 'none' }));
    const machine = new UpdaterMachine({
      updateServerUrl: 'https://core.test',
      getDeviceId: async () => 'test-device-id',
      appVersion: '1.2.3', platform: 'darwin', arch: 'arm64', native, fetchFn,
      log: () => {}, onChanged: () => {},
    });
    machine.initialize('stable');
    await machine.checkForUpdates();
    const metadata = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    for (const headers of [new Headers(metadata.headers), new Headers(native.feedURLs[0].headers)]) {
      expect(headers.get('prismical-client')).toBe('desktop');
      expect(headers.get('prismical-version')).toBe('1.2.3');
      expect(headers.get('prismical-platform')).toBe('darwin');
      expect(headers.get('prismical-arch')).toBeNull();
      expect(headers.get('user-agent')).toBe('prismical-desktop/1.2.3 (macOS)');
    }
    machine.dispose();
  });

  it('sends the installation fallback on metadata requests only', async () => {
    const native = new FakeAutoUpdater();
    const fetchFn = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) =>
      Response.json({ action: 'none' })
    );
    const machine = new UpdaterMachine({
      updateServerUrl: 'https://core.test',
      appVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      getDeviceId: async () => 'persisted-installation-id',
      native,
      fetchFn,
      log: () => {},
      onChanged: () => {},
    });
    machine.initialize('stable');
    await machine.checkForUpdates();
    await machine.checkForUpdates();
    for (const [url, init] of fetchFn.mock.calls) {
      expect(url).toBe('https://core.test/update-meta/stable/darwin-arm64/1.2.3');
      const headers = new Headers(init.headers);
      expect(headers.get('prismical-device-id')).toBe('persisted-installation-id');
      expect(headers.get('prismical-version')).toBe('1.2.3');
    }
    expect(native.feedURLs.every(feed => !new Headers(feed.headers).has('prismical-device-id'))).toBe(true);
    machine.dispose();
  });

  it('downloads and stages: view downloaded, effective version advanced, feed pinned to target', async () => {
    const h = makeHarness();
    h.native.nextCycle = DOWNLOAD_CYCLE;

    await h.machine.checkForUpdates();

    const view = h.machine.getStateView();
    expect(view.status).toBe('downloaded');
    expect(view.staged).toBe(true);
    expect(view.stagedVersion).toBe('0.2.0');
    // Pre-check pin: metadata version rides targetVersion; post-download the
    // feed advances to the downloaded version.
    const urls = h.native.feedURLs.map(f => f.url);
    expect(
      urls.some(u =>
        u.includes('/update/stable/darwin-arm64/0.1.0?runningVersion=0.1.0&targetVersion=0.2.0')
      )
    ).toBe(true);
    expect(urls.at(-1)).toContain('/update/stable/darwin-arm64/0.2.0?runningVersion=0.1.0');
  });

  it('metadata action none skips the native check entirely', async () => {
    const h = makeHarness();
    h.setMetadata({ action: 'none' });

    await h.machine.checkForUpdates();

    expect(h.native.checkCalls).toBe(0);
    expect(h.machine.getStateView().status).toBe('not-available');
  });

  it('a manual check while staged is skipped (native untouched, still downloaded)', async () => {
    const h = makeHarness();
    h.native.nextCycle = DOWNLOAD_CYCLE;
    await h.machine.checkForUpdates();
    expect(h.native.checkCalls).toBe(1);

    await h.machine.checkForUpdates(true);

    expect(h.native.checkCalls).toBe(1);
    expect(h.machine.getStateView().status).toBe('downloaded');
  });

  it('staged-prune guard: background checks skip the native feed unless metadata is newer than staged', async () => {
    const h = makeHarness();
    h.native.nextCycle = DOWNLOAD_CYCLE;
    await h.machine.checkForUpdates();
    expect(h.native.checkCalls).toBe(1);

    // Same version as staged → native NOT hit (a 204 would let Squirrel
    // housekeeping prune the staged install with no re-download).
    await h.machine.checkForUpdates();
    expect(h.native.checkCalls).toBe(1);
    // Metadata fetch failure while staged → also protected.
    h.setMetadata('fail');
    await h.machine.checkForUpdates();
    expect(h.native.checkCalls).toBe(1);
    // A genuinely newer version → native check proceeds.
    h.setMetadata({ action: 'silent', version: '0.3.0' });
    h.native.nextCycle = [['checking-for-update'], ['update-not-available']];
    await h.machine.checkForUpdates();
    expect(h.native.checkCalls).toBe(2);
    // Staged install survived the no-op native cycle.
    expect(h.machine.getStateView().status).toBe('downloaded');
  });

  it('a native error without a staged install surfaces the error state', async () => {
    const h = makeHarness();
    h.native.nextCycle = [['checking-for-update'], ['error', new Error('boom')]];

    await h.machine.checkForUpdates();

    expect(h.machine.getStateView().status).toBe('error');
  });

  it('a native error AFTER an install is staged preserves the staged install', async () => {
    const h = makeHarness();
    h.native.nextCycle = DOWNLOAD_CYCLE;
    await h.machine.checkForUpdates();

    h.setMetadata({ action: 'silent', version: '0.3.0' });
    h.native.nextCycle = [['checking-for-update'], ['error', new Error('boom')]];
    await h.machine.checkForUpdates();

    const view = h.machine.getStateView();
    expect(view.status).toBe('downloaded');
    expect(view.staged).toBe(true);
  });

  it('read-only-volume errors settle to idle, not error (running from DMG)', async () => {
    const h = makeHarness();
    h.native.nextCycle = [
      ['checking-for-update'],
      ['error', new Error('Cannot update while running on a read-only volume')],
    ];

    await h.machine.checkForUpdates();

    expect(h.machine.getStateView().status).toBe('not-available');
  });

  it('a channel change during an in-flight metadata fetch defers, then supersedes the cycle', async () => {
    const h = makeHarness();
    let releaseFetch: (value: UpdateMetadata) => void = () => undefined;
    h.setMetadata(new Promise<UpdateMetadata>(resolve => (releaseFetch = resolve)));

    const inFlight = h.machine.checkForUpdates();
    expect(h.machine.getStateView().status).toBe('checking');
    h.machine.onChannelChanged('beta');

    releaseFetch({ action: 'silent', version: '0.2.0' });
    await inFlight;

    // The superseded cycle never hit the native feed; the channel applied.
    expect(h.native.checkCalls).toBe(0);
    expect(h.native.feedURLs.at(-1)?.url).toContain('/update/beta/');
    expect(h.machine.getStateView().status).toBe('not-available');
  });

  it('prompt lifecycle: surfaces on download, dismiss hides it, force is non-dismissable', async () => {
    const h = makeHarness();
    h.setMetadata({ action: 'prompt', version: '0.2.0', releaseNotes: 'notes' });
    h.native.nextCycle = DOWNLOAD_CYCLE;
    await h.machine.checkForUpdates();

    expect(h.machine.getStateView().prompt).toEqual({
      action: 'prompt',
      version: '0.2.0',
      releaseNotes: 'notes',
    });
    h.machine.dismissUpdatePrompt();
    expect(h.machine.getStateView().prompt).toBeNull();

    const forced = makeHarness();
    forced.setMetadata({ action: 'force', version: '0.2.0' });
    forced.native.nextCycle = DOWNLOAD_CYCLE;
    await forced.machine.checkForUpdates();
    forced.machine.dismissUpdatePrompt();
    expect(forced.machine.getStateView().prompt?.action).toBe('force');
  });

  it('quitAndInstall is guarded by staged', async () => {
    const h = makeHarness();
    expect(h.machine.quitAndInstall()).toBe(false);
    expect(h.native.quitAndInstallCalls).toBe(0);

    h.native.nextCycle = DOWNLOAD_CYCLE;
    await h.machine.checkForUpdates();
    expect(h.machine.quitAndInstall()).toBe(true);
    expect(h.native.quitAndInstallCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — layer tests
// ---------------------------------------------------------------------------

const build = (overrides: Parameters<typeof testConfigLayer>[0]) => {
  const logger = makeTestLogger();
  const config = testConfigLayer(overrides);
  const db = makeFakeOperationalDb();
  const settings = SettingsServiceLive.pipe(Layer.provide(db.layer), Layer.provide(logger.layer));
  return {
    logger,
    layer: Layer.mergeAll(
      settings,
      UpdaterServiceLive.pipe(
        Layer.provide(testTelemetryLayer),
        Layer.provide(config),
        Layer.provide(settings),
        Layer.provide(logger.layer)
      )
    ),
  };
};

const realDelay = (ms: number) => Effect.promise(() => new Promise(r => setTimeout(r, ms)));

const awaitReal = (label: string, predicate: () => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      if (yield* predicate()) return;
      yield* realDelay(2);
    }
    assert.fail(`condition never met: ${label}`);
  });

beforeEach(() => {
  fakeElectron.autoUpdater.feedURLs = [];
  fakeElectron.autoUpdater.checkCalls = 0;
  fakeElectron.autoUpdater.quitAndInstallCalls = 0;
  fakeElectron.autoUpdater.nextCycle = [['checking-for-update'], ['update-not-available']];
  fakeElectron.autoUpdater.removeAllListeners();
});

edescribe('UpdaterServiceLive', () => {
  eit.effect('disabled lane: explicit disabled status, no checks ever', () =>
    Effect.gen(function* () {
      const { layer } = build({ updaterEnabled: false });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const updater = Context.get(ctx, UpdaterService);
      assert.isFalse(updater.enabled);

      assert.strictEqual(yield* updater.checkForUpdates, 'disabled');
      assert.strictEqual(
        (yield* SubscriptionRef.get(updater.state)).status,
        'disabled'
      );
      yield* TestClock.adjust(Duration.hours(24));
      yield* realDelay(10);
      assert.strictEqual(yield* updater.checkCount, 0);
      assert.strictEqual(fakeElectron.autoUpdater.checkCalls, 0);
      yield* Scope.close(scope, Exit.void);
    })
  );

  eit.effect('enabled: initial-delay check, 60-min cadence, dead after scope close (leak gate)', () =>
    Effect.gen(function* () {
      const { layer } = build({ updaterEnabled: true });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const updater = Context.get(ctx, UpdaterService);
      assert.isTrue(updater.enabled);

      yield* TestClock.adjust(Duration.minutes(1));
      yield* awaitReal('first check', () => Effect.map(updater.checkCount, n => n >= 1));
      yield* TestClock.adjust(Duration.minutes(60));
      yield* awaitReal('second check', () => Effect.map(updater.checkCount, n => n >= 2));

      yield* Scope.close(scope, Exit.void);
      const settled = yield* updater.checkCount;
      yield* TestClock.adjust(Duration.hours(24));
      yield* realDelay(10);
      assert.strictEqual(yield* updater.checkCount, settled);
    })
  );

  eit.effect('a settings update-channel change re-points the feed and re-checks', () =>
    Effect.gen(function* () {
      const { layer } = build({ updaterEnabled: true });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const updater = Context.get(ctx, UpdaterService);
      const settings = Context.get(ctx, SettingsService);

      // Settle the initial check first so the switch isn't deferred.
      yield* TestClock.adjust(Duration.minutes(1));
      yield* awaitReal('initial check', () => Effect.map(updater.checkCount, n => n >= 1));

      yield* settings.set({ updateChannel: 'beta' });
      yield* awaitReal('beta feed', () =>
        Effect.sync(() =>
          fakeElectron.autoUpdater.feedURLs.some(f => f.url.includes('/update/beta/'))
        )
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  eit.effect('one-shot checkForUpdates resolves the settled status and publishes the view', () =>
    Effect.gen(function* () {
      const { layer } = build({ updaterEnabled: true });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const updater = Context.get(ctx, UpdaterService);

      const status = yield* updater.checkForUpdates;
      assert.strictEqual(status, 'not-available');
      const view = yield* SubscriptionRef.get(updater.state);
      assert.strictEqual(view.status, 'not-available');
      assert.isFalse(view.staged);
      yield* Scope.close(scope, Exit.void);
    })
  );
});
