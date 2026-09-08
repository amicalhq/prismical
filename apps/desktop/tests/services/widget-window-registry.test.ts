/**
 * WindowRegistry widget-window tests.
 *
 * The floating widget resource: openWidgetWindow acquires the frameless/transparent/
 * always-on-top panel with the right-edge/centred bounds, registers a `widget`
 * identity and destroys it on scope close; the darwin float tweaks + click-through
 * are applied; production uses showInactive while E2E stays hidden; mainWindowFocused
 * reflects the main window's focus edges; and setWidgetIgnoreMouse /
 * sendToWidgetWindow call through to the live widget window (no-ops when absent).
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Option, Scope, SubscriptionRef } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron } from '../helpers/fake-electron';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { ElectronAppLive } from '../../src/main/infra/electron/live';
import { WIDGET_INDEX_URL } from '../../src/main/domains/windows/policy';
import { WindowRegistry } from '../../src/main/domains/windows/service';
import { AppModeService, makeAppMode } from '../../src/main/domains/app-mode/service';
import { WindowRegistryLive } from '../../src/main/domains/windows/live';
import { SettingsServiceLive } from '../../src/main/domains/settings/live';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

const build = (
  overrides: Parameters<typeof testConfigLayer>[0] = {},
  settingsSeed: Record<string, string> = {}
) => {
  const logger = makeTestLogger();
  // Real SettingsService over a fake KV so a seeded `widgetNormalizedY` drives
  // the widget's initial vertical anchor at open.
  const settings = SettingsServiceLive.pipe(
    Layer.provide(makeFakeOperationalDb(settingsSeed).layer),
    Layer.provide(logger.layer)
  );
  return {
    logger,
    layer: WindowRegistryLive.pipe(
      Layer.provide(Layer.effect(AppModeService, makeAppMode('cloud', true))),
      Layer.provide(testConfigLayer(overrides)),
      Layer.provide(ElectronAppLive.pipe(Layer.provide(logger.layer))),
      Layer.provide(settings),
      Layer.provide(logger.layer)
    ),
  };
};

describe('WindowRegistry (widget window resource)', () => {
  it.effect('E2E keeps the panel hidden and disables renderer throttling', () =>
    Effect.gen(function* () {
      const { layer } = build({ isE2E: true });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);

      yield* registry.openWidgetWindow.pipe(Scope.extend(scope));
      const win = fake.__windowInstances().at(-1);
      assert.isDefined(win);
      if (!win) return;
      const options = win.options as {
        show?: boolean;
        webPreferences: Record<string, unknown>;
      };
      assert.strictEqual(options.show, false);
      assert.strictEqual(options.webPreferences.backgroundThrottling, false);
      win.emit('ready-to-show');
      assert.strictEqual(win.showInactiveCount, 0);
      assert.strictEqual(win.showCount, 0);
      assert.strictEqual(win.focusCount, 0);

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('acquires the panel with widget options + bounds, registers widget identity, releases', () =>
    Effect.gen(function* () {
      const { layer, logger } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);

      const windowScope = yield* Scope.make();
      yield* registry.openWidgetWindow.pipe(Scope.extend(windowScope));
      const win = fake.__windowInstances().at(-1);
      assert.isDefined(win);
      if (!win) return;

      const opts = win.options as Record<string, unknown> & {
        webPreferences: Record<string, unknown>;
      };
      assert.strictEqual(opts.frame, false);
      assert.strictEqual(opts.transparent, true);
      assert.strictEqual(opts.alwaysOnTop, true);
      assert.strictEqual(opts.skipTaskbar, true);
      assert.strictEqual(opts.hasShadow, false);
      assert.strictEqual(opts.resizable, false);
      // Right-edge, vertically centred within the fake 1440x900 work area.
      assert.strictEqual(opts.width, 380);
      assert.strictEqual(opts.height, 240);
      assert.strictEqual(opts.x, 1440 - 380 - 12);
      assert.strictEqual(opts.y, 900 / 2 - 240 / 2);
      // Secure webPreferences + the widget preload.
      assert.strictEqual(opts.webPreferences.sandbox, true);
      assert.strictEqual(opts.webPreferences.contextIsolation, true);
      assert.strictEqual(opts.webPreferences.nodeIntegration, false);
      assert.match(String(opts.webPreferences.preload), /widget-preload\.js$/);

      // Loaded the widget document; click-through on create.
      assert.deepStrictEqual(win.loadedUrls, [WIDGET_INDEX_URL]);
      assert.deepStrictEqual(win.ignoreMouseCalls, [{ ignore: true, options: { forward: true } }]);

      // ready-to-show → showInactive (never steals focus).
      win.emit('ready-to-show');
      assert.strictEqual(win.showInactiveCount, 1);

      // darwin float tweaks (the test host is darwin).
      if (process.platform === 'darwin') {
        assert.strictEqual((win.options as { type?: string }).type, 'panel');
        assert.deepStrictEqual(win.alwaysOnTopCalls, [
          { flag: true, level: 'floating', relativeLevel: 2 },
        ]);
        assert.deepStrictEqual(win.visibleOnAllWorkspacesCalls, [
          // skipTransformProcessType: the widget must not demote the app to a UI-element
          // (macOS Space-switch at boot — see windows/live.ts).
          { visible: true, options: { visibleOnFullScreen: true, skipTransformProcessType: true } },
        ]);
        assert.strictEqual(win.hiddenInMissionControl, true);
      }

      // Identity registered as widget.
      const identity = yield* registry.identityForWebContents(win.webContents.id);
      assert.isTrue(Option.isSome(identity));
      if (Option.isSome(identity)) assert.strictEqual(identity.value.kind, 'widget');

      yield* Scope.close(windowScope, Exit.void);
      assert.isTrue(win.isDestroyed());
      assert.isTrue(
        Option.isNone(yield* registry.identityForWebContents(win.webContents.id)),
        'widget identity dropped on release'
      );
      assert.isDefined(logger.find(e => e.message === 'widget window released'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('mainWindowFocused reflects the main window focus/blur edges', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);

      assert.strictEqual(yield* SubscriptionRef.get(registry.mainWindowFocused), false);

      yield* registry.openMainWindow.pipe(Scope.extend(scope));
      const mainWin = fake.__windowInstances().at(-1);
      assert.isDefined(mainWin);
      if (!mainWin) return;

      mainWin.emit('focus');
      assert.strictEqual(yield* SubscriptionRef.get(registry.mainWindowFocused), true);
      mainWin.emit('blur');
      assert.strictEqual(yield* SubscriptionRef.get(registry.mainWindowFocused), false);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('setWidgetIgnoreMouse + sendToWidgetWindow call through; both no-op with no widget', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);

      // No widget yet → no-ops (never throw).
      yield* registry.setWidgetIgnoreMouse(false);
      assert.strictEqual(yield* registry.sendToWidgetWindow('widget:state', { x: 1 }), false);
      assert.isTrue(Option.isNone(yield* registry.widgetWindow));

      yield* registry.openWidgetWindow.pipe(Scope.extend(scope));
      const win = fake.__windowInstances().at(-1);
      assert.isDefined(win);
      if (!win) return;
      // Drop the create-time click-through call; assert only our toggles.
      win.ignoreMouseCalls.length = 0;

      yield* registry.setWidgetIgnoreMouse(false); // interactive
      assert.deepStrictEqual(win.ignoreMouseCalls, [{ ignore: false, options: { forward: true } }]);
      yield* registry.setWidgetIgnoreMouse(true); // click-through
      assert.deepStrictEqual(win.ignoreMouseCalls.at(-1), { ignore: true, options: { forward: true } });

      assert.strictEqual(yield* registry.sendToWidgetWindow('widget:state', { hi: true }), true);
      assert.deepStrictEqual(win.webContents.sent.at(-1), {
        channel: 'widget:state',
        payload: { hi: true },
      });
      assert.isTrue(Option.isSome(yield* registry.widgetWindow));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('dev mode loads the widget page off the dev-server origin', () =>
    Effect.gen(function* () {
      const { layer } = build({ rendererDevServerUrl: 'http://localhost:5173' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openWidgetWindow.pipe(Scope.extend(scope));
      assert.deepStrictEqual(fake.__windowInstances().at(-1)?.loadedUrls, [
        'http://localhost:5173/widget.html',
      ]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  // --- Drag and geometry -----------------------------------------------------
  // The 1440x900 fake display (id 1): x band 12..1048, y band 24..636.

  it.effect('seeds the anchor from dockAnchors[displayId] when present', () =>
    Effect.gen(function* () {
      const { layer } = build(
        {},
        {
          'pref:dockAnchors': JSON.stringify({ '1': { nx: 0, ny: 0 } }),
          'pref:dockDisplayId': JSON.stringify('1'),
          // The legacy row must be IGNORED once a per-display anchor exists.
          'pref:widgetNormalizedY': JSON.stringify(0.75),
        }
      );
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openWidgetWindow.pipe(Scope.extend(scope));
      const opts = fake.__windowInstances().at(-1)?.options as { x: number; y: number };
      assert.strictEqual(opts.x, 12);
      assert.strictEqual(opts.y, 24);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a vanished saved display falls back to the primary (its own anchor)', () =>
    Effect.gen(function* () {
      const { layer } = build(
        {},
        {
          // Display '7' is gone; the primary (id 1) has its own saved anchor.
          'pref:dockAnchors': JSON.stringify({ '1': { nx: 0.5, ny: 0.5 }, '7': { nx: 0, ny: 0 } }),
          'pref:dockDisplayId': JSON.stringify('7'),
        }
      );
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openWidgetWindow.pipe(Scope.extend(scope));
      const opts = fake.__windowInstances().at(-1)?.options as { x: number; y: number };
      assert.strictEqual(opts.x, Math.round(12 + (1048 - 12) * 0.5)); // 530
      assert.strictEqual(opts.y, 330);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('with no dockAnchors entry, seeds right-edge from legacy widgetNormalizedY', () =>
    Effect.gen(function* () {
      // Legacy-position compatibility: read-side fallback, right edge at the old row.
      const { layer } = build({}, { 'pref:widgetNormalizedY': JSON.stringify(0.25) });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);
      yield* registry.openWidgetWindow.pipe(Scope.extend(scope));
      const opts = fake.__windowInstances().at(-1)?.options as { x: number; y: number };
      assert.strictEqual(opts.x, 1440 - 380 - 12);
      assert.strictEqual(opts.y, Math.round(24 + 612 * 0.25)); // 177
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('dragDockWindow applies band-clamped + edge-snapped bounds; None with no widget', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const registry = Context.get(ctx, WindowRegistry);

      // No widget → None (never throws).
      assert.isTrue(
        Option.isNone(
          yield* registry.dragDockWindow({
            screenX: 100,
            screenY: 100,
            pointerOffsetX: 0,
            pointerOffsetY: 0,
          })
        )
      );

      yield* registry.openWidgetWindow.pipe(Scope.extend(scope));
      const win = fake.__windowInstances().at(-1);
      assert.isDefined(win);
      if (!win) return;

      // Mid-band: no snap, exact bounds, anchor + display id returned.
      const mid = yield* registry.dragDockWindow({
        screenX: 530,
        screenY: 330,
        pointerOffsetX: 0,
        pointerOffsetY: 0,
      });
      assert.isTrue(Option.isSome(mid));
      if (Option.isSome(mid)) {
        assert.deepStrictEqual(mid.value, { anchor: { nx: 0.5, ny: 0.5 }, displayId: '1' });
      }
      assert.deepStrictEqual(win.setBoundsCalls.at(-1), { x: 530, y: 330, width: 380, height: 240 });

      // Within 16px of the left band edge → magnetic snap flush to x=12.
      const snapped = yield* registry.dragDockWindow({
        screenX: 20,
        screenY: 24,
        pointerOffsetX: 0,
        pointerOffsetY: 0,
      });
      assert.isTrue(Option.isSome(snapped));
      if (Option.isSome(snapped)) {
        assert.deepStrictEqual(snapped.value.anchor, { nx: 0, ny: 0 });
      }
      assert.deepStrictEqual(win.setBoundsCalls.at(-1), { x: 12, y: 24, width: 380, height: 240 });

      // Far outside the bands clamps to the bottom-right corner.
      yield* registry.dragDockWindow({
        screenX: 10_000,
        screenY: 10_000,
        pointerOffsetX: 0,
        pointerOffsetY: 0,
      });
      assert.deepStrictEqual(win.setBoundsCalls.at(-1), {
        x: 1048,
        y: 636,
        width: 380,
        height: 240,
      });
      yield* Scope.close(scope, Exit.void);
    })
  );
});
