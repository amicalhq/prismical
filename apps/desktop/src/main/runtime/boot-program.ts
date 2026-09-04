/**
 * The Boot program — everything the app does between "runtime exists" and
 * "quit signal". Runs under one Scope (start.ts wraps it in Effect.scoped):
 * closing that scope removes the window, the IPC handlers and every consumer
 * fiber. Layer-owned resources (DB, tray, session handlers, event listeners)
 * are released afterwards by runtime.dispose().
 */
import { Effect, Queue, type Scope } from 'effect';
import { runAuthConsumer } from '../domains/auth/consumer';
import {
  offerLaunchDeepLinks,
  runDeepLinkConsumer,
  runSecondInstanceConsumer,
} from '../domains/deep-link/consumer';
import { runDevLoopbackOAuthServer } from '../domains/deep-link/dev-loopback';
import { runOsSync } from '../domains/settings/os-sync';
import { ShutdownCoordinator } from '../domains/shutdown/service';
import { TelemetryService } from '../domains/telemetry/service';
import { TrayService } from '../domains/tray/service';
import { WindowRegistry, type WindowError } from '../domains/windows/service';
import { ElectronApp } from '../infra/electron/service';
import { PendingReset } from '../infra/pending-reset/service';
import { registerMainWindowHandlers } from '../infra/ipc/main-window-handlers';
import { registerNotifyWindowHandlers } from '../infra/ipc/notify-window-handlers';
import { runDockHotkey } from '../domains/windows/dock-hotkey';
import { registerWidgetWindowHandlers } from '../infra/ipc/widget-window-handlers';
import { MainLogger } from '../infra/logging/service';
import { DesktopI18n } from '../domains/i18n/service';
import { installApplicationMenu } from '../infra/electron/application-menu';
import type { BootServices } from './boot-layer';
import { runWorkspaceLifecycle } from './workspace-lifecycle';

export const bootProgram: Effect.Effect<void, WindowError, BootServices | Scope.Scope> = Effect.gen(
  function* () {
    const electronApp = yield* ElectronApp;
    const windows = yield* WindowRegistry;
    const tray = yield* TrayService;
    const shutdown = yield* ShutdownCoordinator;
    const telemetry = yield* TelemetryService;
    const i18n = yield* DesktopI18n;
    const pendingReset = yield* PendingReset;
    const log = (yield* MainLogger).scoped('main');

    yield* electronApp.whenReady;
    // A destructive reset applied at this boot: wipe the renderer storages
    // again now that the app is ready and BEFORE any window exists — the
    // in-process wipe raced the old renderers' sync polls; nothing can write
    // back now.
    if (pendingReset.applied !== null) {
      yield* electronApp.clearRendererStorage.pipe(
        Effect.catchAllDefect(defect =>
          log.error('renderer storage clear after reset failed', { defect: String(defect) })
        ),
        Effect.zipRight(log.warn('renderer storage cleared after reset'))
      );
    }
    yield* Effect.sync(() => installApplicationMenu(i18n.t));
    // First main-origin event: the app started. Disabled ⇒ a no-op.
    yield* telemetry.capture('app_launch');

    // Handlers before the window: the renderer may invoke on first paint.
    yield* registerMainWindowHandlers;
    yield* windows.openMainWindow;

    // The dock: the pill window + the notification card layer.
    // `widgetVisibility: 'never'` and the meetingNotifications
    // setting are the user-facing off-switches now. Handlers before windows:
    // the renderers may invoke on first paint.
    yield* registerWidgetWindowHandlers;
    yield* registerNotifyWindowHandlers;
    yield* windows.openWidgetWindow;
    yield* windows.openNotifyWindow;
    // The floating-note global hotkey uses settings-reactive registration.
    yield* runDockHotkey;

    // OS-preference sync: project launchAtLogin/dockVisible onto the OS
    // reactively, reconciling the current persisted values once on boot. Forks
    // its own scoped fibers (interrupted with the boot scope), like the handlers.
    yield* runOsSync;

    // Consumer fibers — all land in the program scope with a stated policy:
    // interrupted as a unit when the scope closes (quit or boot failure).
    yield* Effect.forkScoped(runDeepLinkConsumer);
    yield* Effect.forkScoped(runSecondInstanceConsumer);
    // Dev only (no-op packaged): loopback OAuth receiver — unpackaged builds
    // can't win a custom-scheme registration (bundle-id collision across every
    // electron dev checkout), so dev sign-in redirects to 127.0.0.1 instead.
    yield* Effect.forkScoped(runDevLoopbackOAuthServer);
    // Drain parked OAuth callbacks/errors into the auth domain (PKCE
    // attempt matching + token exchange live in domains/auth).
    yield* Effect.forkScoped(runAuthConsumer);
    // Workspace lifecycle — acquires/swaps/tears down
    // the per-workspace scope off (mode, auth state). Interrupting this fiber
    // (scope close on quit) closes any live workspace within its bounded
    // deadline first.
    yield* Effect.forkScoped(runWorkspaceLifecycle());
    // Cold-start deep link (Windows/Linux): the OS launched us with the link in
    // argv. darwin cold-start arrives via open-url instead (no-op there).
    yield* offerLaunchDeepLinks(process.argv);
    yield* Effect.forkScoped(
      // Tray commands: open → focus, quit → app.quit (feeds the quit signal).
      Queue.take(tray.commands).pipe(
        Effect.flatMap(command =>
          command === 'open' ? windows.focusMainWindow : electronApp.quit
        ),
        Effect.forever
      )
    );
    yield* Effect.forkScoped(
      // macOS dock activate → surface the main window.
      Queue.take(electronApp.events.activate).pipe(
        Effect.flatMap(() => windows.focusMainWindow),
        Effect.forever
      )
    );

    yield* log.info('boot complete — awaiting quit signal');
    yield* shutdown.awaitQuitSignal;
    yield* log.info('closing boot scope');
  }
);
