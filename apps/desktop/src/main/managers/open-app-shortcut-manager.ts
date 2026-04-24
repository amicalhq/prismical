import { app, globalShortcut } from "electron";
import type { SettingsService } from "@/services/settings-service";
import type { WindowManager } from "../core/window-manager";
import { logger } from "../logger";
import { keycodesToAccelerator } from "@/utils/keycodes-to-accelerator";

const log = logger.main;

/**
 * Registers the user-configured "open Prismical" shortcut via Electron's
 * globalShortcut module. Unlike the recording/dictation shortcuts, this
 * does not need the native helper bridge — a plain accelerator is enough
 * to bring the main window forward.
 */
export class OpenAppShortcutManager {
  private registeredAccelerator: string | null = null;

  constructor(
    private settingsService: SettingsService,
    private windowManager: WindowManager,
  ) {}

  async initialize(): Promise<void> {
    await app.whenReady();
    await this.reload();
  }

  async reload(): Promise<void> {
    this.unregister();

    const shortcuts = await this.settingsService.getShortcuts();
    const keys = shortcuts.openApp;
    if (!keys || keys.length === 0) return;

    const accelerator = keycodesToAccelerator(keys);
    if (!accelerator) {
      log.warn("openApp shortcut has unsupported key combination", { keys });
      return;
    }

    const ok = globalShortcut.register(accelerator, () => {
      this.toggleMainWindow().catch((err) =>
        log.error("Failed to toggle main window from shortcut", { err }),
      );
    });

    if (!ok) {
      log.warn("openApp shortcut could not be registered (already in use)", {
        accelerator,
      });
      return;
    }

    this.registeredAccelerator = accelerator;
    log.info("openApp shortcut registered", { accelerator });
  }

  /**
   * Temporarily unregister the global shortcut so the user can rebind it
   * from the Shortcuts settings page — otherwise the OS consumes the key
   * combo before the renderer's recording input can see it.
   */
  suspend(): void {
    this.unregister();
  }

  /**
   * Show the main window if it's hidden/unfocused, or dismiss it if it's
   * currently the focused, visible foreground window. Creates the window
   * if it doesn't exist yet (e.g. the user closed it on macOS).
   *
   * Dismissal uses platform-appropriate primitives so the user can return
   * via Cmd+Tab / Alt+Tab:
   *   - macOS: app.hide() — system auto-restores windows on re-activation.
   *   - Win/Linux: window.minimize() — app stays in the task switcher.
   */
  private async toggleMainWindow(): Promise<void> {
    const mainWindow = this.windowManager.getMainWindow();

    if (!mainWindow || mainWindow.isDestroyed()) {
      await this.windowManager.createOrShowMainWindow();
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
      mainWindow.focus();
      return;
    }

    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      if (process.platform === "darwin") {
        app.hide();
      } else {
        mainWindow.minimize();
      }
      return;
    }

    if (process.platform === "darwin") {
      app.show();
    }
    mainWindow.show();
    mainWindow.focus();
  }

  cleanup(): void {
    this.unregister();
  }

  private unregister(): void {
    if (!this.registeredAccelerator) return;
    globalShortcut.unregister(this.registeredAccelerator);
    this.registeredAccelerator = null;
  }
}
