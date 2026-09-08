import { app, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import { Effect, Layer } from 'effect';
import { LoggingTransport } from '../logging/service';
import { DesktopI18n } from '../../domains/i18n/service';
import { NativeOs, type NativeOsApi } from './service';

/**
 * The real Electron edge. Only ever mounted in the
 * running app — every test uses a fake NativeOs — so the electron-only APIs are
 * safe here. It implements login-item, dock, and System Settings deep-link
 * operations.
 */
export const NativeOsLive: Layer.Layer<NativeOs, never, LoggingTransport | DesktopI18n> =
  Layer.effect(
    NativeOs,
    Effect.gen(function* () {
      const logging = yield* LoggingTransport;
      const i18n = yield* DesktopI18n;
      return {
        setLoginItem: openAtLogin =>
          Effect.sync(() => {
            // Unpackaged (forge start) the OS rejects login-item registration for
            // the bare Electron binary ("Unable to set login item: Operation not
            // permitted" on stderr) — skip the call; only packaged builds can own
            // a login item anyway.
            if (!app.isPackaged) return;
            app.setLoginItemSettings({ openAtLogin, openAsHidden: false });
          }),
        // macOS only — `app.dock` is undefined off darwin, so this is a true no-op
        // there. `show()` returns a promise we deliberately fire-and-forget (the OS
        // applies it; nothing here awaits the dock animation).
        setDockVisible: visible =>
          Effect.sync(() => {
            if (!app.dock) return;
            if (visible) void app.dock.show();
            else app.dock.hide();
          }),
        openExternal: url => Effect.promise(() => shell.openExternal(url)),
        // The persistence owner snapshots current and rotated logs for the save dialog.
        revealLogs: logging.exportBundle(i18n.t),
        // `app.quit()` rides the single graceful quit path
        // (before-quit → boot scope close → runtime dispose → app.exit), so the
        // product DBs close, the whisper child dies, a live recording parks and
        // in-flight downloads drop their `.part` — the destructive reset's boot-time
        // purge then finds no open handles. In dev the runner restarts Forge after
        // this process exits, preserving Portless and recreating Vite. Packaged
        // builds let Electron perform the relaunch.
        relaunch: Effect.sync(() => {
          const restartFile = process.env.PRISMICAL_DEV_RESTART_FILE;
          if (!app.isPackaged && restartFile) {
            writeFileSync(restartFile, '');
          } else {
            app.relaunch();
          }
          app.quit();
        }),
      } satisfies NativeOsApi;
    })
  );
