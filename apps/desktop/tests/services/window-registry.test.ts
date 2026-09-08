import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Option, Queue, Scope } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron } from '../helpers/fake-electron';
import { FakeBrowserWindow, FakeEvent } from '../helpers/fake-electron';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { ElectronAppLive } from '../../src/main/infra/electron/live';
import { APP_INDEX_URL } from '../../src/main/domains/windows/policy';
import { WindowRegistry } from '../../src/main/domains/windows/service';
import { WindowRegistryLive } from '../../src/main/domains/windows/live';
import { SettingsServiceLive } from '../../src/main/domains/settings/live';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

const build = (overrides: Parameters<typeof testConfigLayer>[0] = {}) => {
  const logger = makeTestLogger();
  const settings = SettingsServiceLive.pipe(
    Layer.provide(makeFakeOperationalDb().layer),
    Layer.provide(logger.layer)
  );
  return {
    logger,
    layer: WindowRegistryLive.pipe(
      Layer.provide(testConfigLayer(overrides)),
      Layer.provide(ElectronAppLive.pipe(Layer.provide(logger.layer))),
      Layer.provide(settings),
      Layer.provide(logger.layer)
    ),
  };
};

const ses = () => fake.session.defaultSession;

describe('WindowRegistry (session controls)', () => {
  it.effect('focusing after the main window closes recreates one window', () =>
    Effect.gen(function* () {
      const { layer } = build({ isE2E: false });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const original = Option.getOrThrow(yield* registry.mainWindow);
      original.destroy();
      const before = fake.__windowInstances().length;

      yield* Effect.all([registry.focusMainWindow, registry.focusMainWindow], { concurrency: 'unbounded' });
      const reopened = Option.getOrThrow(yield* registry.mainWindow);
      assert.notStrictEqual(reopened.id, original.id);
      assert.strictEqual(fake.__windowInstances().length, before + 1);
      assert.isTrue(reopened.isVisible());
      reopened.destroy();
      yield* Effect.yieldNow();
      assert.isTrue(Option.isNone(yield* registry.identityForWebContents(reopened.webContents.id)));
      assert.strictEqual(reopened.listenerCount('closed'), 0);
      yield* registry.focusMainWindow;
      const last = Option.getOrThrow(yield* registry.mainWindow);
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(last.isDestroyed());
    })
  );

  it.effect('a failed reopen releases the window and allows the next launch to retry', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      const load = vi.spyOn(FakeBrowserWindow.prototype, 'loadURL');
      load.mockRejectedValueOnce(new Error('renderer load failed'));
      yield* registry.focusMainWindow;
      load.mockRestore();
      const failed = fake.__windowInstances().at(-1)!;
      assert.isTrue(failed.isDestroyed());
      assert.isTrue(Option.isNone(yield* registry.identityForWebContents(failed.webContents.id)));

      yield* registry.focusMainWindow;
      assert.isTrue(Option.isSome(yield* registry.mainWindow));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('installs and removes permission handler, CSP injector and scheme handler', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      yield* Layer.build(layer).pipe(Scope.extend(scope));

      assert.isNotNull(ses().permissionRequestHandler);
      assert.isNotNull(ses().permissionCheckHandler);
      assert.isNotNull(ses().headersReceivedHandler);
      assert.isNotNull(ses().beforeSendHeadersHandler);
      assert.isTrue(ses().protocol.isProtocolHandled('prismical-app'));

      yield* Scope.close(scope, Exit.void);
      assert.isNull(ses().permissionRequestHandler);
      assert.isNull(ses().permissionCheckHandler);
      assert.isNull(ses().headersReceivedHandler);
      assert.isNull(ses().beforeSendHeadersHandler);
      assert.isFalse(ses().protocol.isProtocolHandled('prismical-app'));
    })
  );

  it.effect('identifies renderer HTTP and WebSocket requests without losing existing headers', () =>
    Effect.gen(function* () {
      const { layer } = build({ appVersion: '1.2.3', platform: 'darwin' });
      const scope = yield* Scope.make();
      yield* Layer.build(layer).pipe(Scope.extend(scope));
      assert.deepStrictEqual(ses().beforeSendHeadersFilter?.urls, [
        'http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*',
      ]);
      for (const url of ['https://core.test/me', 'wss://note.test/collaboration']) {
        const callback = vi.fn();
        ses().beforeSendHeadersHandler!(
          { url, requestHeaders: { Authorization: 'Bearer token', 'User-Agent': 'Chromium', 'Sec-WebSocket-Protocol': 'test' } },
          callback
        );
        const headers = new Headers(callback.mock.calls[0][0].requestHeaders);
        assert.strictEqual(headers.get('prismical-client'), 'desktop');
        assert.strictEqual(headers.get('prismical-version'), '1.2.3');
        assert.strictEqual(headers.get('prismical-platform'), 'darwin');
        assert.strictEqual(headers.get('user-agent'), 'prismical-desktop/1.2.3 (macOS)');
        assert.strictEqual(headers.get('authorization'), 'Bearer token');
        assert.strictEqual(headers.get('sec-websocket-protocol'), 'test');
      }
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('CSP header lands on every response', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      yield* Layer.build(layer).pipe(Scope.extend(scope));

      let received: Record<string, string[]> | undefined;
      ses().headersReceivedHandler?.({ responseHeaders: { 'X-Keep': ['1'] }, url: APP_INDEX_URL }, response => {
        received = response.responseHeaders;
      });
      const csp = received?.['Content-Security-Policy']?.[0] ?? '';
      assert.include(csp, "default-src 'self'");
      assert.include(csp, 'wss://note.test');
      assert.deepStrictEqual(received?.['X-Keep'], ['1']);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('permission handler: media for the main window only', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);

      const windowScope = yield* Scope.make();
      yield* registry.openMainWindow.pipe(Scope.extend(windowScope));
      const mainWc = fake.__windowInstances().at(-1)?.webContents;
      assert.isDefined(mainWc);

      const decide = (wc: typeof mainWc | undefined, permission: string) => {
        let granted: boolean | undefined;
        ses().permissionRequestHandler?.(wc ?? null, permission, value => {
          granted = value;
        });
        return granted;
      };

      assert.strictEqual(decide(mainWc, 'media'), true);
      assert.strictEqual(decide(mainWc, 'geolocation'), false);
      assert.strictEqual(decide(mainWc, 'notifications'), false);
      assert.strictEqual(decide(undefined, 'media'), false); // no sender

      // The synchronous check handler mirrors the same policy (returns a bool).
      const check = (wc: typeof mainWc | undefined, permission: string) =>
        ses().permissionCheckHandler?.(wc ?? null, permission, 'https://origin', {});
      assert.strictEqual(check(mainWc, 'media'), true);
      assert.strictEqual(check(mainWc, 'geolocation'), false);
      assert.strictEqual(check(mainWc, 'notifications'), false);
      assert.strictEqual(check(undefined, 'media'), false); // sender unresolvable → deny

      yield* Scope.close(windowScope, Exit.void);
      // Window released → its webContents is no longer a valid sender.
      assert.strictEqual(decide(mainWc, 'media'), false);
      assert.strictEqual(check(mainWc, 'media'), false);
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('WindowRegistry (main window resource)', () => {
  it.effect('E2E keeps main and float windows hidden, unthrottled, and unfocused', () =>
    Effect.gen(function* () {
      const { layer } = build({ isE2E: true });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      const appFocusCallsBefore = fake.app.focusCalls.length;

      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const main = fake.__windowInstances().at(-1);
      assert.isDefined(main);
      if (!main) return;
      const mainOptions = main.options as {
        show?: boolean;
        webPreferences: Record<string, unknown>;
      };
      assert.strictEqual(mainOptions.show, false);
      assert.strictEqual(mainOptions.webPreferences.backgroundThrottling, false);
      main.emit('ready-to-show');
      yield* registry.focusMainWindow;
      assert.strictEqual(main.showInactiveCount, 0);
      assert.strictEqual(main.showCount, 0);
      assert.strictEqual(main.focusCount, 0);

      yield* registry.openFloatNoteWindow({
        noteId: null,
        onClosed: () => undefined,
      });
      const float = fake.__windowInstances().at(-1);
      assert.isDefined(float);
      if (!float) return;
      const floatOptions = float.options as {
        show?: boolean;
        webPreferences: Record<string, unknown>;
      };
      assert.strictEqual(floatOptions.show, false);
      assert.strictEqual(floatOptions.webPreferences.backgroundThrottling, false);
      float.emit('ready-to-show');
      yield* registry.openFloatNoteWindow({
        noteId: null,
        onClosed: () => undefined,
      });
      assert.strictEqual(float.showCount, 0);
      assert.strictEqual(float.focusCount, 0);
      assert.strictEqual(fake.app.focusCalls.length, appFocusCallsBefore);

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('acquires with secure prefs, loads the scheme URL, releases everything', () =>
    Effect.gen(function* () {
      const { layer, logger } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);

      const windowScope = yield* Scope.make();
      yield* registry.openMainWindow.pipe(Scope.extend(windowScope));
      const window = fake.__windowInstances().at(-1);
      assert.isDefined(window);
      if (!window) return;

      const prefs = (window.options as { webPreferences: Record<string, unknown> }).webPreferences;
      assert.strictEqual(prefs.sandbox, true);
      assert.strictEqual(prefs.contextIsolation, true);
      assert.strictEqual(prefs.nodeIntegration, false);
      assert.deepStrictEqual(window.loadedUrls, [APP_INDEX_URL]);

      // Identity registered for IPC sender validation.
      const identity = yield* registry.identityForWebContents(window.webContents.id);
      assert.isTrue(Option.isSome(identity));
      if (Option.isSome(identity)) assert.strictEqual(identity.value.kind, 'main');

      // Event streams flow.
      window.emit('focus');
      const event = yield* Queue.take(registry.windowEvents);
      assert.deepStrictEqual(event, { _tag: 'focused', windowId: window.id });

      // Listeners attached.
      assert.strictEqual(window.listenerCount('closed'), 2); // event stream + window scope release
      assert.strictEqual(window.webContents.listenerCount('will-navigate'), 1);
      assert.isNotNull(window.webContents.windowOpenHandler);

      yield* Scope.close(windowScope, Exit.void);
      assert.isTrue(window.isDestroyed());
      assert.strictEqual(window.listenerCount('closed'), 0);
      assert.strictEqual(window.listenerCount('focus'), 0);
      assert.strictEqual(window.webContents.listenerCount('will-navigate'), 0);
      assert.isTrue(
        Option.isNone(yield* registry.identityForWebContents(window.webContents.id)),
        'identity dropped on release'
      );
      assert.isDefined(logger.find(e => e.message === 'main window released'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('window-open handler denies all; allowlisted urls go to the OS browser', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const window = fake.__windowInstances().at(-1);
      const handler = window?.webContents.windowOpenHandler;
      assert.isDefined(handler);
      if (!handler) return;

      assert.deepStrictEqual(handler({ url: 'https://prismical.ai/docs' }), { action: 'deny' });
      assert.deepStrictEqual(handler({ url: 'file:///etc/passwd' }), { action: 'deny' });
      assert.deepStrictEqual(fake.shell.openExternalCalls, ['https://prismical.ai/docs']);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('will-navigate is confined to the app origin', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const wc = fake.__windowInstances().at(-1)?.webContents;
      assert.isDefined(wc);
      if (!wc) return;

      const foreign = new FakeEvent();
      wc.emit('will-navigate', foreign, 'https://evil.example');
      assert.isTrue(foreign.defaultPrevented);

      const inApp = new FakeEvent();
      wc.emit('will-navigate', inApp, 'prismical-app://bundle/notes');
      assert.isFalse(inApp.defaultPrevented);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('dev mode loads the dev server and skips the scheme handler', () =>
    Effect.gen(function* () {
      const { layer } = build({ rendererDevServerUrl: 'http://localhost:5173' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      assert.isFalse(ses().protocol.isProtocolHandled('prismical-app'));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      assert.deepStrictEqual(fake.__windowInstances().at(-1)?.loadedUrls, ['http://localhost:5173']);
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('WindowRegistry (custom-scheme CSP membrane)', () => {
  // The handler derives its dir from live.ts's __dirname (src/main/domains/
  // windows → ../renderer/main_window). Materialize assets there so existsSync
  // passes and the fake net.fetch serves them; the response must carry the CSP
  // explicitly (packaged loads are served by protocol.handle, not webRequest).
  const rendererDir = path.resolve(__dirname, '../../src/main/domains/renderer/main_window');
  const rendererRoot = path.resolve(__dirname, '../../src/main/domains/renderer');

  it.effect('protocol.handle attaches the CSP to served document + asset responses', () =>
    Effect.gen(function* () {
      mkdirSync(rendererDir, { recursive: true });
      writeFileSync(path.join(rendererDir, 'index.html'), '<!doctype html><h1>hi</h1>');
      writeFileSync(path.join(rendererDir, 'app.js'), 'console.log(1)');
      const { layer } = build();
      const scope = yield* Scope.make();
      try {
        yield* Layer.build(layer).pipe(Scope.extend(scope));
        const handler = ses().protocol.handlers.get('prismical-app');
        assert.isDefined(handler);
        if (!handler) return;

        for (const asset of ['index.html', 'app.js']) {
          const response = (yield* Effect.promise(() =>
            Promise.resolve(handler({ url: `prismical-app://bundle/${asset}` }))
          )) as Response;
          assert.strictEqual(response.status, 200, `${asset} served`);
          const csp = response.headers.get('Content-Security-Policy') ?? '';
          assert.include(csp, "default-src 'self'", `${asset} carries CSP`);
          assert.include(csp, "script-src 'self'", `${asset} script-src`);
          assert.include(csp, 'wss://note.test', `${asset} connect-src`);
        }
      } finally {
        yield* Scope.close(scope, Exit.void);
        rmSync(rendererRoot, { recursive: true, force: true });
      }
    })
  );
});
