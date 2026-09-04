import { Context, type Effect } from 'effect';

/**
 * The thin electron edge for native OS side-effects the settings + diagnostics
 * surfaces drive. One injectable boundary — the Live
 * layer touches `app` / `app.dock` / `shell` / electron-log, unit tests provide
 * a fake that records the calls — so the OS-sync consumer and capability IPC
 * handlers stay headless-testable and the domains that
 * use them (SettingsService et al.) stay electron-free.
 *
 * The implementation uses these exact Electron calls:
 * `setLoginItemSettings({ openAtLogin, openAsHidden: false })` and the darwin
 * `app.dock` show/hide (a no-op off macOS where `app.dock` is undefined).
 */
export interface NativeOsApi {
  /** `app.setLoginItemSettings({ openAtLogin, openAsHidden: false })`. */
  readonly setLoginItem: (openAtLogin: boolean) => Effect.Effect<void>;
  /** `app.dock` show/hide — macOS only; a true no-op elsewhere. */
  readonly setDockVisible: (visible: boolean) => Effect.Effect<void>;
  /** `shell.openExternal(url)` — the System Settings deep-link lane. */
  readonly openExternal: (url: string) => Effect.Effect<void>;
  /** `shell.showItemInFolder(<electron-log file>)` — reveal the log. */
  readonly revealLogs: Effect.Effect<void>;
  /** `app.relaunch(); app.exit(0)` — the post-reset restart. */
  readonly relaunch: Effect.Effect<void>;
}

export class NativeOs extends Context.Tag('desktop/NativeOs')<NativeOs, NativeOsApi>() {}
