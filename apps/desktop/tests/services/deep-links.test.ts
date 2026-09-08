import { assert, describe, it } from '@effect/vitest';
import { CHANNELS } from '@prismical/desktop-contracts';
import { Context, Effect, Exit, Layer, Option, Queue, Scope, SubscriptionRef } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron } from '../helpers/fake-electron';
import { FakeEvent } from '../helpers/fake-electron';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { ElectronAppLive } from '../../src/main/infra/electron/live';
import {
  offerLaunchDeepLinks,
  runDeepLinkConsumer,
  runSecondInstanceConsumer,
} from '../../src/main/domains/deep-link/consumer';
import {
  DeepLinks,
  type PendingOAuthCallback,
  type PendingOAuthError,
} from '../../src/main/domains/deep-link/service';
import { DeepLinksLive } from '../../src/main/domains/deep-link/live';
import { WindowRegistry, type WindowRegistryService } from '../../src/main/domains/windows/service';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

interface WindowsStubState {
  sent: Array<{ channel: string; payload: unknown; focusCount: number }>;
  focusCount: number;
}

const windowsStub = (state: WindowsStubState) =>
  Layer.effect(
    WindowRegistry,
    Effect.gen(function* () {
      const events = yield* Queue.sliding<never>(1);
      const service: WindowRegistryService = {
        openMainWindow: Effect.die('unused in stub'),
        setThemeSource: () => Effect.void,
        identityForWebContents: () => Effect.succeed(Option.none()),
        mainWindow: Effect.succeed(Option.none()),
        focusMainWindow: Effect.sync(() => {
          state.focusCount += 1;
        }),
        sendToMainWindow: (channel, payload) =>
          Effect.sync(() => {
            state.sent.push({ channel, payload, focusCount: state.focusCount });
            return true;
          }),
        windowEvents: events,
        openWidgetWindow: Effect.die('unused in stub'),
        widgetWindow: Effect.succeed(Option.none()),
        sendToWidgetWindow: () => Effect.succeed(false),
        setWidgetIgnoreMouse: () => Effect.void,
        dragDockWindow: () => Effect.succeed(Option.none()),
        openNotifyWindow: Effect.never as never,
        notifyWindow: Effect.succeed(Option.none()),
        sendToNotifyWindow: () => Effect.succeed(false),
        setNotifyIgnoreMouse: () => Effect.void,
        repositionNotifyWindow: Effect.void,
        openFloatNoteWindow: () => Effect.void,
        floatNoteWindow: Effect.succeed(Option.none()),
        closeFloatNoteWindow: Effect.void,
        hideFloatNoteWindow: Effect.void,
        sendToFloatNoteWindow: () => Effect.succeed(false),
        sendToAppWindows: () => Effect.void,
        repositionDockWindow: Effect.void,
        repositionFloatNoteWindow: Effect.void,
        setDockContentProtection: () => Effect.void,
        mainWindowFocused: yield* SubscriptionRef.make(false),
      };
      return service;
    })
  );

const build = (configOverrides: Parameters<typeof testConfigLayer>[0] = {}) => {
  const logger = makeTestLogger();
  const electronApp = ElectronAppLive.pipe(Layer.provide(logger.layer));
  const state: WindowsStubState = { sent: [], focusCount: 0 };
  const layer = Layer.mergeAll(
    testConfigLayer(configOverrides),
    logger.layer,
    electronApp,
    DeepLinksLive.pipe(Layer.provide(electronApp), Layer.provide(logger.layer)),
    windowsStub(state)
  );
  return { logger, layer, state };
};

describe('DeepLinks', () => {
  it.effect('open-url events feed the bounded url queue via the layer fiber', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const deepLinks = Context.get(ctx, DeepLinks);

      fake.app.emit('open-url', new FakeEvent(), 'prismical://app/notes');
      const url = yield* Queue.take(deepLinks.urls);
      assert.strictEqual(url, 'prismical://app/notes');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('consumer: OAuthCallback + OAuthError park in pendingOAuth; Navigate pushes nav:push', () =>
    Effect.gen(function* () {
      const { layer, logger, state } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* Effect.forkScoped(runDeepLinkConsumer).pipe(
        Effect.provide(ctx),
        Scope.extend(scope)
      );

      yield* deepLinks.offerUrl('prismical://oauth/callback?code=c-1&state=s-1');
      yield* deepLinks.offerUrl('prismical://oauth/callback?error=access_denied&state=s-err');
      yield* deepLinks.offerUrl('prismical://app/notes/n_9?filter=all');
      yield* deepLinks.offerUrl('prismical://garbage/x');

      // Let the consumer drain all four urls (the warn for the last one is
      // the last observable effect).
      yield* Effect.iterate(0, {
        while: n =>
          n < 200 && logger.find(e => e.level === 'warn' && e.message === 'deep link rejected') === undefined,
        body: n => Effect.yieldNow().pipe(Effect.as(n + 1)),
      });

      const pending = yield* SubscriptionRef.get(deepLinks.pendingOAuth);
      assert.deepStrictEqual(
        pending.map(entry => entry._tag),
        ['OAuthCallback', 'OAuthError']
      );
      const callback = pending.find(
        (entry): entry is PendingOAuthCallback => entry._tag === 'OAuthCallback'
      );
      assert.strictEqual(callback?.code, 'c-1');
      assert.strictEqual(callback?.state, 's-1');
      const oauthError = pending.find(
        (entry): entry is PendingOAuthError => entry._tag === 'OAuthError'
      );
      assert.strictEqual(oauthError?.error, 'access_denied');
      assert.strictEqual(oauthError?.state, 's-err');

      assert.deepStrictEqual(state.sent, [
        { channel: CHANNELS.navPush, payload: { path: '/notes/n_9?filter=all' }, focusCount: 1 },
      ]);
      assert.isDefined(logger.find(e => e.level === 'warn' && e.message === 'deep link rejected'));
      // Secrets never hit the log payloads.
      assert.isUndefined(logger.entries.find(e => JSON.stringify(e.data ?? '').includes('c-1')));

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('macOS open-url focuses the main window before navigation and ignores rejected links', () =>
    Effect.gen(function* () {
      const { layer, logger, state } = build({ platform: 'darwin' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      yield* Effect.forkScoped(runDeepLinkConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));

      fake.app.emit('open-url', new FakeEvent(), 'prismical://app/settings/calendar');
      fake.app.emit('open-url', new FakeEvent(), 'prismical://app/float/n_1');
      fake.app.emit('open-url', new FakeEvent(), 'prismical://garbage/x');

      yield* Effect.iterate(0, {
        while: n =>
          n < 200 && logger.find(e => e.message === 'deep link rejected') === undefined,
        body: n => Effect.yieldNow().pipe(Effect.as(n + 1)),
      });

      assert.isDefined(logger.find(e => e.message === 'deep link rejected'));
      assert.strictEqual(state.focusCount, 1);
      assert.deepStrictEqual(state.sent, [
        { channel: CHANNELS.navPush, payload: { path: '/settings/calendar' }, focusCount: 1 },
      ]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // Log custody: malformed OAuth callbacks route to the Unknown
  // arm CARRYING real code/state values — the shared diagnostic sanitizer
  // removes the query; rejection reasons remain available for diagnosis.
  it.effect('consumer: a malformed callback with duplicated code/state logs NO secret values', () =>
    Effect.gen(function* () {
      const { layer, logger } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* Effect.forkScoped(runDeepLinkConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));

      // Duplicated params (param-count) — the URL contains a real code twice.
      yield* deepLinks.offerUrl(
        'prismical://oauth/callback?code=SECRET-CODE-1&code=SECRET-CODE-2&state=SECRET-STATE-1'
      );
      // error+code together (error-and-code) — also carries a real code.
      yield* deepLinks.offerUrl(
        'prismical://oauth/callback?error=access_denied&code=SECRET-CODE-3&state=SECRET-STATE-2'
      );

      yield* Effect.iterate(0, {
        while: n =>
          n < 200 &&
          logger.entries.filter(e => e.message === 'deep link rejected').length < 2,
        body: n => Effect.yieldNow().pipe(Effect.as(n + 1)),
      });

      const rejections = logger.entries.filter(e => e.message === 'deep link rejected');
      assert.strictEqual(rejections.length, 2, 'both malformed callbacks rejected+logged');
      // The route and rejection reason survive; the query is removed.
      assert.strictEqual(
        (rejections[0].data as { url?: string }).url,
        'prismical://oauth/callback[redacted]'
      );
      assert.strictEqual((rejections[0].data as { reason?: string }).reason, 'param-count');
      assert.strictEqual(
        (rejections[1].data as { url?: string }).url,
        'prismical://oauth/callback[redacted]'
      );
      // …the values never do — across EVERYTHING the logger captured.
      const dump = JSON.stringify(logger.entries);
      assert.notInclude(dump, 'SECRET-CODE-1');
      assert.notInclude(dump, 'SECRET-CODE-2');
      assert.notInclude(dump, 'SECRET-CODE-3');
      assert.notInclude(dump, 'SECRET-STATE-1');
      assert.notInclude(dump, 'SECRET-STATE-2');

      // Nothing parked — these never reach the auth domain.
      assert.strictEqual(
        (yield* SubscriptionRef.get(deepLinks.pendingOAuth)).length,
        0
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('second-instance consumer focuses the window and scans argv for links', () =>
    Effect.gen(function* () {
      const { layer, state } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* Effect.forkScoped(runSecondInstanceConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));

      fake.app.emit('second-instance', new FakeEvent(), [
        '/bin/prismical',
        '--allow-file-access',
        'prismical://oauth/callback?code=x&state=y',
      ]);

      yield* Effect.iterate(0, {
        while: n => n < 100 && state.focusCount === 0,
        body: n => Effect.yieldNow().pipe(Effect.as(n + 1)),
      });
      assert.strictEqual(state.focusCount, 1);
      const queued = yield* Queue.take(deepLinks.urls);
      assert.strictEqual(queued, 'prismical://oauth/callback?code=x&state=y');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('Squirrel second instances neither focus nor deliver deep links', () =>
    Effect.gen(function* () {
      const { layer, state } = build({ platform: 'win32' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const deepLinks = Context.get(ctx, DeepLinks);
      yield* Effect.forkScoped(runSecondInstanceConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));

      for (const hook of ['install', 'updated', 'obsolete', 'uninstall', 'firstrun']) {
        fake.app.emit('second-instance', new FakeEvent(), [
          'Prismical.exe', `--squirrel-${hook}`, 'prismical://app/unexpected',
        ]);
      }
      // A normal launch behind the hooks proves the consumer drained them.
      fake.app.emit('second-instance', new FakeEvent(), ['Prismical.exe', 'prismical://app/notes']);
      const queued = yield* Queue.take(deepLinks.urls);
      assert.strictEqual(queued, 'prismical://app/notes');
      assert.strictEqual(state.focusCount, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('cold-start: win32 argv deep link reaches the url queue', () =>
    Effect.gen(function* () {
      const { layer } = build({ platform: 'win32', isPackaged: true });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* offerLaunchDeepLinks([
        'C:\\Program Files\\Prismical\\Prismical.exe',
        '--some-flag',
        'prismical://app/notes/n_42',
      ]).pipe(Effect.provide(ctx));

      const url = yield* Queue.take(deepLinks.urls);
      assert.strictEqual(url, 'prismical://app/notes/n_42');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('cold-start: darwin does NOT offer argv links (open-url covers it)', () =>
    Effect.gen(function* () {
      const { layer } = build({ platform: 'darwin' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const deepLinks = Context.get(ctx, DeepLinks);

      yield* offerLaunchDeepLinks([
        '/Applications/Prismical.app/Contents/MacOS/Prismical',
        'prismical://app/notes/n_42',
      ]).pipe(Effect.provide(ctx));

      assert.strictEqual(yield* Queue.size(deepLinks.urls), 0);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('scope close interrupts the consumer — later urls go unprocessed', () =>
    Effect.gen(function* () {
      const { layer, state } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const deepLinks = Context.get(ctx, DeepLinks);
      yield* Effect.forkScoped(runDeepLinkConsumer).pipe(Effect.provide(ctx), Scope.extend(scope));
      yield* Scope.close(scope, Exit.void);

      yield* deepLinks.offerUrl('prismical://app/after-close');
      yield* Effect.iterate(0, {
        while: n => n < 20,
        body: n => Effect.yieldNow().pipe(Effect.as(n + 1)),
      });
      assert.deepStrictEqual(state.sent, []);
    })
  );
});
