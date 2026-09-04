import { app, shell } from 'electron';
import { Effect, Layer } from 'effect';
import { log } from '../../logger';
import { NativeOs, type NativeOsApi } from './service';

/**
 * The real Electron edge. Only ever mounted in the
 * running app — every test uses a fake NativeOs — so the electron-only APIs are
 * safe here. It implements login-item, dock, and System Settings deep-link
 * operations.
 */
export const NativeOsLive: Layer.Layer<NativeOs> = Layer.succeed(
  NativeOs,
  {
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
    // electron-log's current file path (the redacting logger seam owns the
    // transport); reveal it in the OS file browser for diagnostics.
    revealLogs: Effect.sync(() => {
      shell.showItemInFolder(log.transports.file.getFile().path);
    }),
    // `app.quit()` rides the single graceful quit path
    // (before-quit → boot scope close → runtime dispose → app.exit), so the
    // product DBs close, the whisper child dies, a live recording parks and
    // in-flight downloads drop their `.part` — the destructive reset's boot-time
    // purge then finds no open handles. Electron honours the queued
    // `relaunch()` when the process finally exits.
    relaunch: Effect.sync(() => {
      app.relaunch();
      app.quit();
    }),
  } satisfies NativeOsApi
);
