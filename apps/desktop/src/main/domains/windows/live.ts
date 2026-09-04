/**
 * WindowRegistry Live.
 *
 * Owns, as scoped resources:
 *  - session-level controls: permission-request allowlist, CSP injection via
 *    onHeadersReceived, and the privileged custom scheme's protocol.handle
 *    serving the built renderer (packaged/bundle mode);
 *  - per-window resources: BrowserWindow with secure defaults, deny-all
 *    window-open handler + shell.openExternal allowlist, will-navigate
 *    confinement, closed/focus event streams, identity registration.
 *
 * Every acquire has a matching release; the boot-layer leak test asserts the
 * session handlers and window listeners are gone after scope close.
 *
 * Identity state is a layer-scoped Map mutated ONLY inside acquire/release
 * effects — Electron callback edges (permission handler) read it
 * synchronously, business logic stays out of callbacks.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, nativeTheme, net, screen, session, shell } from 'electron';
import { Effect, Fiber, Layer, Option, Queue, Runtime, SubscriptionRef } from 'effect';
import { AppConfig } from '../../infra/config/service';
import { ElectronApp } from '../../infra/electron/service';
import { MainLogger } from '../../infra/logging/service';
import { mainWindowViteName } from '../../infra/electron/vite-constants';
import { SettingsService } from '../settings/service';
import {
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
  anchorForDisplay,
  computeDockBounds,
  computeNotifyBounds,
  dragToDockAnchor,
  defaultFloatRectNearDock,
  floatBoundsToRect,
  rectToFloatBounds,
  resolveDockDisplay,
} from './dock-geometry';
import {
  APP_INDEX_URL,
  APP_SCHEME,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  NOTIFY_INDEX_URL,
  WIDGET_INDEX_URL,
  buildCsp,
  computeMainWindowSize,
  isAllowedExternalUrl,
  isAppNavigationUrl,
  isPermissionAllowed,
  resolveRendererAssetPath,
  type WindowKind,
} from './policy';
import {
  WindowError,
  WindowRegistry,
  type WindowEvent,
  type WindowIdentity,
  type WindowRegistryService,
} from './service';

const WINDOW_EVENT_CAPACITY = 64;

const rendererDir = (): string => path.join(__dirname, `../renderer/${mainWindowViteName()}`);

// Dock geometry (constants + bounds/drag/snap math) is the pure, electron-free
// `./dock-geometry` module:
// a 2-axis per-display anchor seeded from `dockAnchors[displayId]` (legacy
// `widgetNormalizedY` fallback) and driven by `dragDockWindow`.

interface RegisteredWindow {
  readonly identity: WindowIdentity;
  readonly window: BrowserWindow;
}

export const WindowRegistryLive: Layer.Layer<
  WindowRegistry,
  WindowError,
  AppConfig | ElectronApp | MainLogger | SettingsService
> = Layer.scoped(
  WindowRegistry,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const electronApp = yield* ElectronApp;
    const logger = yield* MainLogger;
    // Device settings (boot-scoped): seeds the widget's initial vertical anchor
    // from the persisted `widgetNormalizedY` at open.
    const settings = yield* SettingsService;
    const log = logger.scoped('windows');
    const unsafeLog = logger.scopedUnsafe('windows');

    // Session APIs are only available once the app is ready.
    yield* electronApp.whenReady;

    // E2E: never take over the developer's screen. Every BrowserWindow stays
    // hidden and opts out of Chromium background throttling, so timers/rAF keep
    // production cadence while Playwright drives the renderer over CDP. On
    // macOS the accessory policy is defence-in-depth: no dock tile and no
    // process activation even if a future test accidentally calls show().
    if (config.isE2E && process.platform === 'darwin') {
      yield* Effect.sync(() => app.setActivationPolicy('accessory'));
    }

    const registered = new Map<number, RegisteredWindow>(); // keyed by webContents id
    const windowEvents = yield* Queue.sliding<WindowEvent>(WINDOW_EVENT_CAPACITY);
    // Reactive main-window focus signal: the widget push projection reads
    // it to suppress the pill over the focused main window. The main window's
    // focus/blur callbacks (below) set it synchronously through this runtime —
    // SubscriptionRef.set completes synchronously, so runSync is safe on the edge.
    const mainWindowFocused = yield* SubscriptionRef.make(false);
    const runtime = yield* Effect.runtime<never>();

    const identityKindFor = (webContentsId: number): WindowKind | 'unknown' =>
      registered.get(webContentsId)?.identity.kind ?? 'unknown';

    // --- Session-level controls (scoped) -----------------------------------
    const ses = session.defaultSession;

    // Permission allowlist: media, main window only; deny everything else.
    // Both the async request handler AND the synchronous check handler are
    // wired — the check path (e.g. permissions.query, getUserMedia's pre-check)
    // otherwise falls back to Electron defaults. The check handler's signature
    // differs (webContents may be null; returns a boolean synchronously); an
    // unresolvable sender maps to 'unknown' and is denied.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        ses.setPermissionRequestHandler((webContents, permission, callback) => {
          const kind = webContents ? identityKindFor(webContents.id) : 'unknown';
          const allowed = isPermissionAllowed(permission, kind);
          if (!allowed) unsafeLog.warn('permission denied', { permission, kind });
          callback(allowed);
        });
        ses.setPermissionCheckHandler((webContents, permission) => {
          const kind = webContents ? identityKindFor(webContents.id) : 'unknown';
          const allowed = isPermissionAllowed(permission, kind);
          if (!allowed) unsafeLog.warn('permission check denied', { permission, kind });
          return allowed;
        });
      }).pipe(Effect.tap(() => log.info('permission allowlist installed'))),
      () =>
        Effect.sync(() => {
          ses.setPermissionRequestHandler(null);
          ses.setPermissionCheckHandler(null);
        })
    );

    // CSP injection — applies to dev-server responses AND custom-scheme loads.
    const csp = buildCsp({
      devServerUrl: config.rendererDevServerUrl,
      noteWsUrl: config.endpoints.noteWsUrl,
      analyticsKey: config.endpoints.analyticsKey,
      analyticsOrigin: config.endpoints.analyticsHost,
    });
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        ses.webRequest.onHeadersReceived((details, callback) => {
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              'Content-Security-Policy': [csp],
            },
          });
        });
      }).pipe(Effect.tap(() => log.info('csp injector installed'))),
      () =>
        Effect.sync(() => {
          ses.webRequest.onHeadersReceived(null);
        })
    );

    // Custom scheme serving the built renderer (root-absolute assets work).
    // Under `forge start` the vite dev server serves the renderer instead.
    if (config.rendererDevServerUrl === null) {
      const dir = rendererDir();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          ses.protocol.handle(APP_SCHEME, async request => {
            const filePath = resolveRendererAssetPath(dir, new URL(request.url).pathname);
            if (filePath === null || !existsSync(filePath)) {
              return new Response('Not Found', { status: 404 });
            }
            // Set the CSP explicitly on the served document/asset. Packaged
            // renderer loads come through protocol.handle, so relying on
            // webRequest.onHeadersReceived to decorate the internal net.fetch
            // is version-dependent; attach it here as the primary membrane and
            // keep the webRequest injector above for dev-server responses.
            const fetched = await net.fetch(pathToFileURL(filePath).toString());
            const headers = new Headers(fetched.headers);
            headers.set('Content-Security-Policy', csp);
            return new Response(fetched.body, {
              status: fetched.status,
              statusText: fetched.statusText,
              headers,
            });
          });
        }).pipe(Effect.tap(() => log.info('renderer scheme handler installed', { dir }))),
        () =>
          Effect.sync(() => {
            ses.protocol.unhandle(APP_SCHEME);
          })
      );
    }

    // Windows titleBarOverlay colors; the values mirror tokens.css
    // --sidebar/--sidebar-foreground so the native strip blends with the shell.
    // `shouldUseDarkColors` now tracks the IN-APP theme rather than the OS,
    // because setThemeSource mirrors the renderer's preference onto
    // themeSource — this closes the forced-theme divergence noted here before.
    const titleBarOverlayColors = () =>
      nativeTheme.shouldUseDarkColors
        ? { color: '#1d1d20', symbolColor: '#cfd0d1', height: 32 }
        : { color: '#fafafa', symbolColor: '#4d4d4d', height: 32 };

    // --- Per-window acquisition ---------------------------------------------
    const openMainWindow = Effect.acquireRelease(
      Effect.try({
        try: () => {
          // Sized from the display (policy.computeMainWindowSize) rather than a
          // fixed 1100x720, which opened small on every modern screen. The main
          // window has no persisted bounds, so this runs on every launch.
          const { width, height } = computeMainWindowSize(screen.getPrimaryDisplay().workArea);
          const window = new BrowserWindow({
            width,
            height,
            // Measured, not assumed. Without this the window opens near the TOP
            // of the screen — y=33 on a 1728x1117 display, i.e. just under the
            // menu bar. `center: true` routes through NSWindow.center(), which
            // AppKit defines as horizontally centred and "somewhat above center
            // vertically", giving y=69 rather than the true middle at 88. That
            // above-centre bias is the native macOS convention, so it is left
            // alone rather than forced with explicit x/y.
            center: true,
            // E2E stays truly hidden; Playwright reaches it over CDP.
            ...(config.isE2E ? { show: false } : {}),
            // Rationale lives on the constants (windows/policy.ts) so the
            // opening floor and this resize limit cannot explain themselves
            // differently.
            minWidth: MAIN_WINDOW_MIN_WIDTH,
            minHeight: MAIN_WINDOW_MIN_HEIGHT,
            // Frameless chrome:
            // the native titlebar goes away — macOS keeps inset traffic lights
            // over the renderer's sidebar spacer; Windows draws min/max/close
            // via the native overlay. The renderer carries the drag regions
            // (app-ui, capability-gated). Other platforms keep the stock frame.
            ...(process.platform === 'darwin'
              ? {
                  titleBarStyle: 'hiddenInset' as const,
                  trafficLightPosition: { x: 16, y: 16 },
                  // macOS vibrancy: mounts an NSVisualEffectView behind the web
                  // contents; the renderer's `html.vibrancy` rules
                  // (app/globals.css) are the other half. `#00000000` — NOT
                  // `transparent: true`, which also drops the window shadow and
                  // rounded corners — keeps Electron off the material.
                  backgroundColor: '#00000000',
                  vibrancy: 'menu' as const,
                }
              : process.platform === 'win32'
                ? {
                    titleBarStyle: 'hidden' as const,
                    titleBarOverlay: titleBarOverlayColors(),
                  }
                : {}),
            webPreferences: {
              preload: path.join(__dirname, 'preload.js'),
              // Secure defaults, explicit from day one.
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              ...(config.isE2E ? { backgroundThrottling: false } : {}),
              // Sandboxed preloads can't read process.env; the E2E flag rides
              // process.argv (the documented additionalArguments mechanism).
              // Gates ONLY the test-only e2e surface in the preload.
              additionalArguments: config.isE2E ? ['--prismical-e2e'] : [],
            },
          });

          // Deny all window.open calls; allowlisted protocols go to the OS browser.
          window.webContents.setWindowOpenHandler(({ url }) => {
            if (isAllowedExternalUrl(url)) {
              shell.openExternal(url).catch((error: unknown) => {
                unsafeLog.warn('shell.openExternal failed', { url, error: String(error) });
              });
            }
            return { action: 'deny' };
          });

          // In-window navigation may never leave the app origin.
          const onWillNavigate = (event: Electron.Event, url: string) => {
            if (!isAppNavigationUrl(url, config.rendererDevServerUrl)) {
              event.preventDefault();
              unsafeLog.warn('blocked navigation', { url });
            }
          };
          window.webContents.on('will-navigate', onWillNavigate);

          const windowId = window.id;
          const onClosed = () => {
            Queue.unsafeOffer(windowEvents, { _tag: 'closed', windowId });
          };
          const onFocus = () => {
            Queue.unsafeOffer(windowEvents, { _tag: 'focused', windowId });
            Runtime.runSync(runtime)(SubscriptionRef.set(mainWindowFocused, true));
          };
          const onBlur = () => {
            Queue.unsafeOffer(windowEvents, { _tag: 'blurred', windowId });
            Runtime.runSync(runtime)(SubscriptionRef.set(mainWindowFocused, false));
          };
          window.on('closed', onClosed);
          window.on('focus', onFocus);
          window.on('blur', onBlur);

          // Windows: re-skin the native overlay when the OS theme flips.
          const onNativeThemeUpdated = () => {
            if (!window.isDestroyed()) {
              window.setTitleBarOverlay(titleBarOverlayColors());
            }
          };
          if (process.platform === 'win32') {
            nativeTheme.on('updated', onNativeThemeUpdated);
          }

          const identity: WindowIdentity = {
            windowId,
            webContentsId: window.webContents.id,
            kind: 'main',
          };
          registered.set(identity.webContentsId, { identity, window });
          return {
            window,
            identity,
            onWillNavigate,
            onClosed,
            onFocus,
            onBlur,
            onNativeThemeUpdated,
          };
        },
        catch: cause => new WindowError({ stage: 'create-main-window', cause }),
      }),
      acquired =>
        Effect.sync(() => {
          const { window, identity } = acquired;
          registered.delete(identity.webContentsId);
          if (process.platform === 'win32') {
            nativeTheme.removeListener('updated', acquired.onNativeThemeUpdated);
          }
          window.removeListener('closed', acquired.onClosed);
          window.removeListener('focus', acquired.onFocus);
          window.removeListener('blur', acquired.onBlur);
          if (!window.isDestroyed()) {
            window.webContents.removeListener('will-navigate', acquired.onWillNavigate);
            window.destroy();
          }
        }).pipe(
          Effect.zipRight(log.info('main window released', { windowId: acquired.identity.windowId }))
        )
    ).pipe(
      Effect.tap(({ window }) =>
        Effect.tryPromise({
          try: () =>
            config.rendererDevServerUrl !== null
              ? window.loadURL(config.rendererDevServerUrl)
              : window.loadURL(APP_INDEX_URL),
          catch: cause => new WindowError({ stage: 'load-main-window', cause }),
        })
      ),
      Effect.tap(({ identity }) => log.info('main window opened', { windowId: identity.windowId })),
      Effect.map(({ window }) => window)
    );

    const liveMainWindow: Effect.Effect<Option.Option<BrowserWindow>> = Effect.sync(() => {
      for (const entry of registered.values()) {
        if (entry.identity.kind === 'main' && !entry.window.isDestroyed()) {
          return Option.some(entry.window);
        }
      }
      return Option.none<BrowserWindow>();
    });

    // --- Sanitized floating panels ------------------------------------------
    // The widget (dock pill) and notify (card stack) windows share one shape:
    // frameless/transparent/always-on-top/click-through panels with the darwin
    // float tweaks, shown WITHOUT focus (showInactive) so they never steal focus
    // from the app the user is in, starting click-through (the per-window
    // setIgnoreMouse re-enables the pointer while a hit-zone/card is hovered).
    const openPanelWindow = (options: {
      readonly kind: WindowKind;
      readonly preloadFile: string;
      readonly devPage: string;
      readonly indexUrl: string;
      readonly computeBounds: () => Electron.Rectangle;
    }) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            const darwin = process.platform === 'darwin';
            const bounds = options.computeBounds();
            const window = new BrowserWindow({
              ...bounds,
              show: false,
              frame: false,
              transparent: true,
              backgroundColor: '#00000000',
              resizable: false,
              minimizable: false,
              maximizable: false,
              fullscreenable: false,
              skipTaskbar: true,
              hasShadow: false,
              alwaysOnTop: true,
              acceptFirstMouse: true,
              ...(darwin ? { type: 'panel' } : {}),
              webPreferences: {
                preload: path.join(__dirname, options.preloadFile),
                // Secure defaults, identical to the main window.
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                ...(config.isE2E ? { backgroundThrottling: false } : {}),
                additionalArguments: config.isE2E ? ['--prismical-e2e'] : [],
              },
            });

            // Float above full-screen apps + across spaces, and stay out of Mission
            // Control (a floating panel, not a window the user manages).
            if (darwin) {
              window.setAlwaysOnTop(true, 'floating', 2);
              window.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
                // Skip Electron's UIElement↔Foreground TransformProcessType
                // round-trip: every call demotes the
                // frontmost app to a UI-element, macOS re-activates the
                // previously-active app, and when that app lives on another
                // Space the workspace visibly switches at boot / session
                // re-scope (observed on-device). A panel window floats over
                // fullscreen via its collection behavior alone — the transform
                // is only needed for non-panel windows.
                skipTransformProcessType: true,
              });
              window.setHiddenInMissionControl(true);
            }
            // Click-through until the renderer hovers a hit-zone; `forward` keeps
            // hover events flowing so the renderer can detect the enter/leave.
            window.setIgnoreMouseEvents(true, { forward: true });
            // Screen-share privacy: self-apply the current setting at create.
            window.setContentProtection(
              Runtime.runSync(runtime)(settings.get).dockContentProtection
            );
            // Production panels paint without activation. E2E panels remain
            // hidden and unthrottled so they never overlay the developer's apps.
            if (!config.isE2E) {
              window.once('ready-to-show', () => {
                window.showInactive();
              });
            }

            // Deny all window.open calls; allowlisted protocols go to the OS browser.
            window.webContents.setWindowOpenHandler(({ url }) => {
              if (isAllowedExternalUrl(url)) {
                shell.openExternal(url).catch((error: unknown) => {
                  unsafeLog.warn('shell.openExternal failed', { url, error: String(error) });
                });
              }
              return { action: 'deny' };
            });

            // In-window navigation may never leave the app origin.
            const onWillNavigate = (event: Electron.Event, url: string) => {
              if (!isAppNavigationUrl(url, config.rendererDevServerUrl)) {
                event.preventDefault();
                unsafeLog.warn(`blocked ${options.kind} navigation`, { url });
              }
            };
            window.webContents.on('will-navigate', onWillNavigate);

            const windowId = window.id;
            const onClosed = () => {
              Queue.unsafeOffer(windowEvents, { _tag: 'closed', windowId });
            };
            const onFocus = () => {
              Queue.unsafeOffer(windowEvents, { _tag: 'focused', windowId });
            };
            const onBlur = () => {
              Queue.unsafeOffer(windowEvents, { _tag: 'blurred', windowId });
            };
            window.on('closed', onClosed);
            window.on('focus', onFocus);
            window.on('blur', onBlur);

            const identity: WindowIdentity = {
              windowId,
              webContentsId: window.webContents.id,
              kind: options.kind,
            };
            registered.set(identity.webContentsId, { identity, window });
            return { window, identity, onWillNavigate, onClosed, onFocus, onBlur };
          },
          catch: cause => new WindowError({ stage: `create-${options.kind}-window`, cause }),
        }),
        acquired =>
          Effect.sync(() => {
            const { window, identity } = acquired;
            registered.delete(identity.webContentsId);
            window.removeListener('closed', acquired.onClosed);
            window.removeListener('focus', acquired.onFocus);
            window.removeListener('blur', acquired.onBlur);
            if (!window.isDestroyed()) {
              window.webContents.removeListener('will-navigate', acquired.onWillNavigate);
              window.destroy();
            }
          }).pipe(
            Effect.zipRight(
              log.info(`${options.kind} window released`, { windowId: acquired.identity.windowId })
            )
          )
      ).pipe(
        Effect.tap(({ window }) =>
          Effect.tryPromise({
            try: () =>
              config.rendererDevServerUrl !== null
                ? window.loadURL(new URL(options.devPage, config.rendererDevServerUrl).toString())
                : window.loadURL(options.indexUrl),
            catch: cause => new WindowError({ stage: `load-${options.kind}-window`, cause }),
          })
        ),
        Effect.tap(({ identity }) =>
          log.info(`${options.kind} window opened`, { windowId: identity.windowId })
        ),
        Effect.map(({ window }) => window)
      );

    const openWidgetWindow = Effect.suspend(() =>
      openPanelWindow({
        kind: 'widget',
        preloadFile: 'widget-preload.js',
        devPage: 'widget.html',
        indexUrl: WIDGET_INDEX_URL,
        // Seed the 2-axis anchor from the persisted per-display settings
        // using the saved display if still connected (else the
        // primary — display-vanish fallback), then its saved anchor (else the
        // legacy `widgetNormalizedY` right-edge seed used by the migration).
        // SubscriptionRef.get completes synchronously, so runSync is safe on
        // this edge — the same rationale as the focus callbacks below.
        computeBounds: () => {
          const seeded = Runtime.runSync(runtime)(settings.get);
          const display = resolveDockDisplay(
            screen.getAllDisplays(),
            screen.getPrimaryDisplay(),
            seeded.dockDisplayId
          );
          const anchor = anchorForDisplay(
            seeded.dockAnchors,
            String(display.id),
            seeded.widgetNormalizedY
          );
          return computeDockBounds(display.workArea, anchor);
        },
      })
    );

    // The notify window follows the dock's display (top-right corner).
    const notifyBoundsFromSettings = (): Electron.Rectangle => {
      const seeded = Runtime.runSync(runtime)(settings.get);
      const display = resolveDockDisplay(
        screen.getAllDisplays(),
        screen.getPrimaryDisplay(),
        seeded.dockDisplayId
      );
      return computeNotifyBounds(display.workArea);
    };
    const openNotifyWindow = Effect.suspend(() =>
      openPanelWindow({
        kind: 'notify',
        preloadFile: 'notify-preload.js',
        devPage: 'notify.html',
        indexUrl: NOTIFY_INDEX_URL,
        computeBounds: notifyBoundsFromSettings,
      })
    );

    const livePanelWindow = (kind: WindowKind): Effect.Effect<Option.Option<BrowserWindow>> =>
      Effect.sync(() => {
        for (const entry of registered.values()) {
          if (entry.identity.kind === kind && !entry.window.isDestroyed()) {
            return Option.some(entry.window);
          }
        }
        return Option.none<BrowserWindow>();
      });

    const liveWidgetWindow = livePanelWindow('widget');
    const liveNotifyWindow = livePanelWindow('notify');
    const liveFloatNoteWindow = livePanelWindow('float-note');

    // --- Floating note window -----------------------------------------------
    // The dock's expanded mode: a focusable, resizable always-on-top window
    // that loads the MAIN renderer bundle at #/float[/:noteId] with the MAIN
    // preload — same origin, same membrane, sender kind 'float-note'. MANUAL
    // lifecycle: created on demand by the float coordinator, destroyed by
    // closeFloatNoteWindow / the OS; the 'closed' listener deregisters the
    // identity and notifies the coordinator on EVERY close path.
    const openFloatNoteWindow = (options: {
      readonly noteId: string | null;
      readonly search?: string;
      readonly onClosed: () => void;
    }): Effect.Effect<void, WindowError> =>
      liveFloatNoteWindow.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.try({
                try: () => {
                  const darwin = process.platform === 'darwin';
                  const seeded = Runtime.runSync(runtime)(settings.get);
                  const display = resolveDockDisplay(
                    screen.getAllDisplays(),
                    screen.getPrimaryDisplay(),
                    seeded.dockDisplayId
                  );
                  const displayId = String(display.id);
                  const saved = seeded.floatNoteBounds[displayId];
                  // First open on a display: land BESIDE the pill (its inner
                  // side, vertically centred on it) rather than mid-screen —
                  // the float is the pill's expanded mode, so it appears where
                  // the intent was expressed. A move/resize persists real
                  // bounds and wins from then on.
                  const bounds =
                    saved === undefined
                      ? defaultFloatRectNearDock(
                          display.workArea,
                          anchorForDisplay(seeded.dockAnchors, displayId, seeded.widgetNormalizedY)
                        )
                      : floatBoundsToRect(display.workArea, saved);
                  const window = new BrowserWindow({
                    ...bounds,
                    minWidth: FLOAT_MIN_WIDTH,
                    minHeight: FLOAT_MIN_HEIGHT,
                    show: false,
                    frame: false,
                    // darwin: a NON-transparent frameless window so macOS
                    // rounds+clips the corners AND the `vibrancy` material
                    // (same 'menu' recipe as the main window's sidebar frost)
                    // shows through the renderer's translucent card — a
                    // transparent window would paint square frosted corners
                    // around the rounded card. Other platforms keep the
                    // transparent window + the renderer's own rounded chrome.
                    ...(darwin
                      ? { vibrancy: 'menu' as const, roundedCorners: true }
                      : { transparent: true }),
                    backgroundColor: '#00000000',
                    // Focusable + native edge RESIZE (no drawn affordance —
                    // the header strip is the app-region drag surface).
                    resizable: true,
                    minimizable: false,
                    maximizable: false,
                    fullscreenable: false,
                    skipTaskbar: true,
                    hasShadow: true,
                    alwaysOnTop: true,
                    acceptFirstMouse: true,
                    ...(darwin ? { type: 'panel' } : {}),
                    webPreferences: {
                      // The MAIN preload — the float renders the same app.
                      preload: path.join(__dirname, 'preload.js'),
                      nodeIntegration: false,
                      contextIsolation: true,
                      sandbox: true,
                      ...(config.isE2E ? { backgroundThrottling: false } : {}),
                      additionalArguments: config.isE2E ? ['--prismical-e2e'] : [],
                    },
                  });
                  if (darwin) {
                    window.setAlwaysOnTop(true, 'floating', 2);
                    window.setVisibleOnAllWorkspaces(true, {
                      visibleOnFullScreen: true,
                      skipTransformProcessType: true,
                    });
                    window.setHiddenInMissionControl(true);
                  }
                  // Screen-share privacy: self-apply the current setting.
                  window.setContentProtection(seeded.dockContentProtection);
                  // User-summoned production floats show WITH focus (typing
                  // needs the key window). E2E keeps the renderer hidden and
                  // reaches it over CDP, just like the boot windows.
                  if (!config.isE2E) {
                    window.once('ready-to-show', () => {
                      window.show();
                      // macOS: a 'panel' window is NONACTIVATING — clicking it
                      // never activates the app, so explicitly activate for
                      // real user-summoned note editing.
                      if (darwin) app.focus({ steal: true });
                    });
                  }

                  // Same window-open/navigation confinement as every window.
                  window.webContents.setWindowOpenHandler(({ url }) => {
                    if (isAllowedExternalUrl(url)) {
                      shell.openExternal(url).catch((error: unknown) => {
                        unsafeLog.warn('shell.openExternal failed', { url, error: String(error) });
                      });
                    }
                    return { action: 'deny' };
                  });
                  const onWillNavigate = (event: Electron.Event, url: string) => {
                    if (!isAppNavigationUrl(url, config.rendererDevServerUrl)) {
                      event.preventDefault();
                      unsafeLog.warn('blocked float-note navigation', { url });
                    }
                  };
                  window.webContents.on('will-navigate', onWillNavigate);

                  // Persist size/position per display, debounced — high-frequency
                  // during a drag/resize, one write on settle. Effect-native
                  // debounce with no raw timers: each event
                  // interrupts the pending sleep+persist fiber and forks anew.
                  const persistEffect = Effect.sleep('500 millis').pipe(
                    Effect.zipRight(
                      Effect.suspend(() => {
                        if (window.isDestroyed()) return Effect.void;
                        const rect = window.getBounds();
                        const onDisplay = screen.getDisplayNearestPoint({
                          x: rect.x + Math.round(rect.width / 2),
                          y: rect.y + Math.round(rect.height / 2),
                        });
                        const normalized = rectToFloatBounds(onDisplay.workArea, rect);
                        return settings.get.pipe(
                          Effect.flatMap(current =>
                            settings.set({
                              floatNoteBounds: {
                                ...current.floatNoteBounds,
                                [String(onDisplay.id)]: normalized,
                              },
                            })
                          ),
                          Effect.catchAll(() => Effect.void)
                        );
                      })
                    )
                  );
                  let persistFiber: Fiber.RuntimeFiber<void> | null = null;
                  const persistBounds = () => {
                    persistFiber?.unsafeInterruptAsFork(persistFiber.id());
                    persistFiber = Runtime.runFork(runtime)(persistEffect);
                  };
                  window.on('moved', persistBounds);
                  window.on('resized', persistBounds);

                  const windowId = window.id;
                  const webContentsId = window.webContents.id;
                  window.on('closed', () => {
                    persistFiber?.unsafeInterruptAsFork(persistFiber.id());
                    registered.delete(webContentsId);
                    Queue.unsafeOffer(windowEvents, { _tag: 'closed', windowId });
                    // A stale window's late 'closed' (rapid close+reopen) must
                    // not clobber the coordinator's state for its SUCCESSOR:
                    // only report the close when no newer float window lives.
                    for (const entry of registered.values()) {
                      if (entry.identity.kind === 'float-note' && !entry.window.isDestroyed()) {
                        return;
                      }
                    }
                    options.onClosed();
                  });
                  const identity: WindowIdentity = {
                    windowId,
                    webContentsId,
                    kind: 'float-note',
                  };
                  registered.set(webContentsId, { identity, window });

                  const hash =
                    (options.noteId === null ? '#/float' : `#/float/${options.noteId}`) +
                    (options.search ?? '');
                  const target =
                    config.rendererDevServerUrl !== null
                      ? new URL(`index.html${hash}`, config.rendererDevServerUrl).toString()
                      : `${APP_INDEX_URL}${hash}`;
                  window.loadURL(target).catch((error: unknown) => {
                    unsafeLog.warn('float-note load failed', { error: String(error) });
                  });
                  return windowId;
                },
                catch: cause => new WindowError({ stage: 'create-float-note-window', cause }),
              }).pipe(
                Effect.flatMap(windowId => log.info('float-note window opened', { windowId }))
              ),
            // Already live: bring it forward (the coordinator navs separately).
            onSome: window =>
              Effect.sync(() => {
                if (config.isE2E) return;
                if (window.isMinimized()) window.restore();
                window.show();
                window.focus();
                // Same nonactivating-panel keystroke fix as the create path.
                if (process.platform === 'darwin') app.focus({ steal: true });
              }),
          })
        )
      );


    const service: WindowRegistryService = {
      openMainWindow,
      setThemeSource: source =>
        // Idempotent: the renderer re-pushes on every theme apply (boot, OS
        // flip, toggle), and assigning themeSource re-emits nativeTheme
        // 'updated' — which the renderer answers with another apply.
        Effect.sync(() => {
          if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
        }),
      identityForWebContents: webContentsId =>
        Effect.sync(() => Option.fromNullable(registered.get(webContentsId)?.identity)),
      mainWindow: liveMainWindow,
      focusMainWindow: liveMainWindow.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => log.warn('focusMainWindow: no live main window'),
            onSome: window =>
              Effect.sync(() => {
                if (config.isE2E) return;
                if (window.isMinimized()) window.restore();
                window.show();
                window.focus();
              }),
          })
        )
      ),
      sendToMainWindow: (channel, payload) =>
        liveMainWindow.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: window =>
                Effect.sync(() => {
                  window.webContents.send(channel, payload);
                  return true;
                }),
            })
          )
        ),
      windowEvents,
      openWidgetWindow,
      widgetWindow: liveWidgetWindow,
      sendToWidgetWindow: (channel, payload) =>
        liveWidgetWindow.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: window =>
                Effect.sync(() => {
                  window.webContents.send(channel, payload);
                  return true;
                }),
            })
          )
        ),
      setWidgetIgnoreMouse: ignore =>
        liveWidgetWindow.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: window =>
                Effect.sync(() => {
                  window.setIgnoreMouseEvents(ignore, { forward: true });
                }),
            })
          )
        ),
      openNotifyWindow,
      notifyWindow: liveNotifyWindow,
      sendToNotifyWindow: (channel, payload) =>
        liveNotifyWindow.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: window =>
                Effect.sync(() => {
                  window.webContents.send(channel, payload);
                  return true;
                }),
            })
          )
        ),
      setNotifyIgnoreMouse: ignore =>
        liveNotifyWindow.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: window =>
                Effect.sync(() => {
                  window.setIgnoreMouseEvents(ignore, { forward: true });
                }),
            })
          )
        ),
      repositionNotifyWindow: liveNotifyWindow.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: window =>
              Effect.sync(() => {
                window.setBounds(notifyBoundsFromSettings());
              }),
          })
        )
      ),
      repositionDockWindow: liveWidgetWindow.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: window =>
              Effect.sync(() => {
                const seeded = Runtime.runSync(runtime)(settings.get);
                const display = resolveDockDisplay(
                  screen.getAllDisplays(),
                  screen.getPrimaryDisplay(),
                  seeded.dockDisplayId
                );
                const anchor = anchorForDisplay(
                  seeded.dockAnchors,
                  String(display.id),
                  seeded.widgetNormalizedY
                );
                window.setBounds(computeDockBounds(display.workArea, anchor));
              }),
          })
        )
      ),
      repositionFloatNoteWindow: liveFloatNoteWindow.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: window =>
              Effect.sync(() => {
                const seeded = Runtime.runSync(runtime)(settings.get);
                const display = resolveDockDisplay(
                  screen.getAllDisplays(),
                  screen.getPrimaryDisplay(),
                  seeded.dockDisplayId
                );
                const displayId = String(display.id);
                const saved = seeded.floatNoteBounds[displayId];
                window.setBounds(
                  saved === undefined
                    ? defaultFloatRectNearDock(
                        display.workArea,
                        anchorForDisplay(seeded.dockAnchors, displayId, seeded.widgetNormalizedY)
                      )
                    : floatBoundsToRect(display.workArea, saved)
                );
              }),
          })
        )
      ),
      setDockContentProtection: enabled =>
        Effect.sync(() => {
          for (const entry of registered.values()) {
            if (entry.identity.kind === 'main' || entry.window.isDestroyed()) continue;
            entry.window.setContentProtection(enabled);
          }
        }),
      openFloatNoteWindow,
      floatNoteWindow: liveFloatNoteWindow,
      closeFloatNoteWindow: liveFloatNoteWindow.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: window =>
              Effect.sync(() => {
                window.destroy();
              }),
          })
        )
      ),
      hideFloatNoteWindow: liveFloatNoteWindow.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: window =>
              Effect.sync(() => {
                window.hide();
              }),
          })
        )
      ),
      sendToFloatNoteWindow: (channel, payload) =>
        liveFloatNoteWindow.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: window =>
                Effect.sync(() => {
                  window.webContents.send(channel, payload);
                  return true;
                }),
            })
          )
        ),
      sendToAppWindows: (channel, payload) =>
        Effect.sync(() => {
          for (const entry of registered.values()) {
            if (
              (entry.identity.kind === 'main' || entry.identity.kind === 'float-note') &&
              !entry.window.isDestroyed()
            ) {
              entry.window.webContents.send(channel, payload);
            }
          }
        }),
      // The drag resolves the display under the POINTER (not the window) so a
      // drag can carry the dock across displays: as the pointer crosses, bounds
      // clamp into the new display's bands and the window follows it there.
      // Side effects live in Effect.sync (file idiom) so a destroyed-window
      // race surfaces as a handled fiber error path, not an unhandled defect.
      dragDockWindow: sample =>
        liveWidgetWindow.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: window =>
                Effect.sync(() => {
                  const display = screen.getDisplayNearestPoint({
                    x: sample.screenX,
                    y: sample.screenY,
                  });
                  const anchor = dragToDockAnchor(display.workArea, sample);
                  window.setBounds(computeDockBounds(display.workArea, anchor));
                  return Option.some({ anchor, displayId: String(display.id) });
                }),
            })
          )
        ),
      mainWindowFocused,
    };
    return service;
  })
);
