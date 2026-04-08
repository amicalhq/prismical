import { BrowserWindow, screen, nativeTheme, shell } from "electron";
import path from "node:path";
import { logger } from "../logger";
import type { SettingsService } from "../../services/settings-service";
import type { createIPCHandler } from "electron-trpc-experimental/main";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const ONBOARDING_WINDOW_VITE_NAME: string;
declare const NOTIFICATION_WINDOW_VITE_NAME: string;
declare const RECORDING_WIDGET_WINDOW_VITE_NAME: string;

export class WindowManager {
  private static readonly NOTIFICATION_WINDOW_WIDTH = 380 as const;
  private static readonly NOTIFICATION_WINDOW_HEIGHT = 120 as const;
  private static readonly NOTIFICATION_WINDOW_MARGIN = 16 as const;
  private static readonly MEETING_WIDGET_WINDOW_WIDTH = 92 as const;
  private static readonly MEETING_WIDGET_WINDOW_HEIGHT = 124 as const;
  private static readonly MEETING_WIDGET_EDGE_MARGIN = 12 as const;
  private static readonly MEETING_WIDGET_VERTICAL_MARGIN = 24 as const;
  private mainWindow: BrowserWindow | null = null;
  private onboardingWindow: BrowserWindow | null = null;
  private notificationWindow: BrowserWindow | null = null;
  private meetingWidgetWindow: BrowserWindow | null = null;
  private themeListenerSetup: boolean = false;

  /**
   * Get the correct traffic light position based on macOS version.
   * macOS Tahoe (26+) has larger, redesigned traffic light buttons as part of
   * the "Liquid Glass" design language that require a different y-offset.
   * Electron does not handle this automatically - apps must detect OS version.
   * See: https://github.com/microsoft/vscode/pull/280593
   */
  private getTrafficLightPosition(): { x: number; y: number } {
    if (process.platform !== "darwin") {
      return { x: 20, y: 16 }; // Not used on non-macOS, but return default
    }

    // process.getSystemVersion() returns marketing version (e.g., "26.0.0")
    // vs os.release() which returns Darwin kernel version (e.g., "25.1.0")
    const systemVersion = process.getSystemVersion();
    const majorVersion = parseInt(systemVersion.split(".")[0], 10);
    const isTahoeOrLater = majorVersion >= 26;

    return { x: 16, y: 16 };
  }

  private getNotificationWindowBounds(): Electron.Rectangle {
    const display = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    const workArea = display.workArea;
    const width = Math.min(
      WindowManager.NOTIFICATION_WINDOW_WIDTH,
      workArea.width,
    );
    const height = Math.min(
      WindowManager.NOTIFICATION_WINDOW_HEIGHT,
      workArea.height,
    );
    const margin = WindowManager.NOTIFICATION_WINDOW_MARGIN;

    return {
      x: workArea.x + workArea.width - width - margin,
      y: workArea.y + margin,
      width,
      height,
    };
  }

  private getMeetingWidgetWindowBounds(
    normalizedY: number = 1,
    displayPoint: Electron.Point = screen.getCursorScreenPoint(),
  ): Electron.Rectangle {
    const display = screen.getDisplayNearestPoint(displayPoint);
    const workArea = display.workArea;
    const width = Math.min(
      WindowManager.MEETING_WIDGET_WINDOW_WIDTH,
      workArea.width,
    );
    const height = Math.min(
      WindowManager.MEETING_WIDGET_WINDOW_HEIGHT,
      workArea.height,
    );
    const edgeMargin = WindowManager.MEETING_WIDGET_EDGE_MARGIN;
    const verticalMargin = WindowManager.MEETING_WIDGET_VERTICAL_MARGIN;
    const minY = workArea.y + verticalMargin;
    const maxY = workArea.y + workArea.height - height - verticalMargin;
    const clampedNormalizedY = clampNormalizedY(normalizedY);
    const y =
      maxY <= minY
        ? minY
        : Math.round(minY + (maxY - minY) * clampedNormalizedY);

    return {
      x: workArea.x + workArea.width - width - edgeMargin,
      y,
      width,
      height,
    };
  }

  constructor(
    private settingsService: SettingsService,
    private trpcHandler: ReturnType<typeof createIPCHandler>,
  ) {
    logger.main.info("WindowManager created with dependencies");
  }

  private async getThemeColors(): Promise<{
    backgroundColor: string;
    symbolColor: string;
  }> {
    const uiSettings = await this.settingsService.getUISettings();
    const theme = uiSettings?.theme || "system";

    // Determine if we should use dark colors
    let isDark = false;
    if (theme === "dark") {
      isDark = true;
    } else if (theme === "light") {
      isDark = false;
    } else if (theme === "system") {
      isDark = nativeTheme.shouldUseDarkColors;
    }

    // Return appropriate colors
    return isDark
      ? { backgroundColor: "#181818", symbolColor: "#fafafa" }
      : { backgroundColor: "#ffffff", symbolColor: "#0a0a0a" };
  }

  private async syncNativeThemeSource(): Promise<void> {
    const uiSettings = await this.settingsService.getUISettings();
    const desiredThemeSource = uiSettings?.theme ?? "system";

    if (nativeTheme.themeSource === desiredThemeSource) {
      return;
    }

    nativeTheme.themeSource = desiredThemeSource;
    logger.main.info("Synced native theme source", {
      themeSource: desiredThemeSource,
    });
  }

  async updateAllWindowThemes(): Promise<void> {
    await this.syncNativeThemeSource();
    const colors = await this.getThemeColors();

    // Update main window (macOS uses vibrancy, no title bar overlay)
    if (
      process.platform !== "darwin" &&
      this.mainWindow &&
      !this.mainWindow.isDestroyed()
    ) {
      this.mainWindow.setTitleBarOverlay({
        color: colors.backgroundColor,
        symbolColor: colors.symbolColor,
        height: 32,
      });
    }

    // Update onboarding window if it exists
    // Note: onboarding window has frame: false, so no title bar to update

    logger.main.info("Updated window themes", colors);
  }

  private setupThemeListener(): void {
    if (this.themeListenerSetup) return;

    // Listen for system theme changes
    nativeTheme.on("updated", async () => {
      const uiSettings = await this.settingsService.getUISettings();
      const theme = uiSettings?.theme || "system";

      // Only update if theme is set to "system"
      if (theme === "system") {
        await this.updateAllWindowThemes();
        logger.main.info("System theme changed, updating windows");
      }
    });

    this.themeListenerSetup = true;
    logger.main.info("Theme listener setup complete");
  }

  /**
   * Creates a new main window or shows existing one.
   * @param initialRoute - Optional route to navigate to when creating a NEW window.
   *                       This is passed as a URL hash to avoid race conditions where
   *                       the renderer isn't ready to receive IPC navigation events.
   *                       If window already exists, caller should use webContents.send()
   *                       to navigate (renderer is already loaded and listening).
   */
  async createOrShowMainWindow(initialRoute?: string): Promise<void> {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.show();
      this.mainWindow.focus();
      return;
    }

    // Setup theme listener on first window creation
    this.setupThemeListener();

    await this.syncNativeThemeSource();

    // Get theme colors before creating window
    const colors = await this.getThemeColors();

    const primaryDisplay = screen.getPrimaryDisplay();
    const windowHeight = Math.min(800, primaryDisplay.workAreaSize.height - 40);

    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: windowHeight,
      frame: true,
      backgroundColor:
        process.platform === "darwin" ? "#00000000" : colors.backgroundColor,
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset",
            vibrancy: "menu",
          }
        : {
            titleBarStyle: "hidden",
            titleBarOverlay: {
              color: colors.backgroundColor,
              symbolColor: colors.symbolColor,
              height: 32,
            },
          }),
      trafficLightPosition: this.getTrafficLightPosition(),
      useContentSize: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const shouldOpenExternally = (url: string) => {
      try {
        const parsed = new URL(url);
        return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol);
      } catch {
        return false;
      }
    };

    // Open external links in the default browser
    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (shouldOpenExternally(url)) {
        shell.openExternal(url);
      }
      return { action: "deny" };
    });

    // Intercept navigation to external URLs
    this.mainWindow.webContents.on("will-navigate", (event, url) => {
      if (shouldOpenExternally(url)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });

    // Load the window URL, appending initial route as hash if provided
    // This avoids race conditions when the renderer isn't ready for IPC events
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const url = initialRoute
        ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${initialRoute}`
        : MAIN_WINDOW_VITE_DEV_SERVER_URL;
      this.mainWindow.loadURL(url);
    } else {
      this.mainWindow.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
        initialRoute ? { hash: initialRoute } : undefined,
      );
    }

    this.mainWindow.on("close", () => {
      // Detach window before it's destroyed
      this.trpcHandler.detachWindow(this.mainWindow!);
    });

    this.mainWindow.on("closed", () => {
      // Window is already destroyed, just clean up reference
      this.mainWindow = null;
    });

    this.trpcHandler.attachWindow(this.mainWindow!);
  }

  async createOrShowOnboardingWindow(): Promise<void> {
    if (this.onboardingWindow && !this.onboardingWindow.isDestroyed()) {
      this.onboardingWindow.show();
      this.onboardingWindow.focus();
      return;
    }

    // Setup theme listener if not already done
    this.setupThemeListener();

    await this.syncNativeThemeSource();

    // Get theme colors before creating window
    const colors = await this.getThemeColors();

    const primaryDisplay = screen.getPrimaryDisplay();
    const windowHeight = Math.min(928, primaryDisplay.workAreaSize.height - 40);

    this.onboardingWindow = new BrowserWindow({
      width: 800,
      height: windowHeight,
      frame: true,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: colors.backgroundColor,
        symbolColor: colors.symbolColor,
        height: 32,
      },
      trafficLightPosition: this.getTrafficLightPosition(),
      resizable: false,
      center: true,
      modal: true,
      webPreferences: {
        preload: path.join(__dirname, "onboarding-preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const devUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      devUrl.pathname = "onboarding.html";
      this.onboardingWindow.loadURL(devUrl.toString());
    } else {
      this.onboardingWindow.loadFile(
        path.join(
          __dirname,
          `../renderer/${ONBOARDING_WINDOW_VITE_NAME}/onboarding.html`,
        ),
      );
    }

    this.onboardingWindow.on("close", () => {
      this.trpcHandler.detachWindow(this.onboardingWindow!);
    });

    this.onboardingWindow.on("closed", () => {
      this.onboardingWindow = null;
    });

    // Disable main window while onboarding is open
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setEnabled(false);
    }

    this.trpcHandler.attachWindow(this.onboardingWindow!);
    logger.main.info("Onboarding window created");
  }

  async createOrShowNotificationWindow(): Promise<void> {
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      this.notificationWindow.setBounds(this.getNotificationWindowBounds());
      this.notificationWindow.showInactive();
      return;
    }

    const bounds = this.getNotificationWindowBounds();

    this.notificationWindow = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      ...(process.platform === "darwin" && {
        type: "panel" as const,
      }),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (process.platform === "darwin") {
      this.notificationWindow.setAlwaysOnTop(true, "floating", 2);
      this.notificationWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
      this.notificationWindow.setHiddenInMissionControl(true);
    }

    this.notificationWindow.once("ready-to-show", () => {
      this.notificationWindow?.showInactive();
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const devUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      devUrl.pathname = "notification.html";
      this.notificationWindow.loadURL(devUrl.toString());
    } else {
      this.notificationWindow.loadFile(
        path.join(
          __dirname,
          `../renderer/${NOTIFICATION_WINDOW_VITE_NAME}/notification.html`,
        ),
      );
    }

    this.notificationWindow.on("close", () => {
      this.trpcHandler.detachWindow(this.notificationWindow!);
    });

    this.notificationWindow.on("closed", () => {
      this.notificationWindow = null;
    });

    this.trpcHandler.attachWindow(this.notificationWindow);

    logger.main.info("Notification window created", {
      bounds,
    });
  }

  async createOrShowMeetingWidgetWindow(
    normalizedY: number = 1,
  ): Promise<void> {
    const bounds = this.getMeetingWidgetWindowBounds(normalizedY);

    if (this.meetingWidgetWindow && !this.meetingWidgetWindow.isDestroyed()) {
      this.meetingWidgetWindow.setBounds(bounds);
      this.meetingWidgetWindow.showInactive();
      return;
    }

    this.meetingWidgetWindow = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      ...(process.platform === "darwin" && {
        type: "panel" as const,
      }),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (process.platform === "darwin") {
      this.meetingWidgetWindow.setAlwaysOnTop(true, "floating", 2);
      this.meetingWidgetWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
      this.meetingWidgetWindow.setHiddenInMissionControl(true);
    }

    this.meetingWidgetWindow.setIgnoreMouseEvents(true, { forward: true });

    this.meetingWidgetWindow.once("ready-to-show", () => {
      this.meetingWidgetWindow?.showInactive();
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const devUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      devUrl.pathname = "recording-widget.html";
      this.meetingWidgetWindow.loadURL(devUrl.toString());
    } else {
      this.meetingWidgetWindow.loadFile(
        path.join(
          __dirname,
          `../renderer/${RECORDING_WIDGET_WINDOW_VITE_NAME}/recording-widget.html`,
        ),
      );
    }

    this.meetingWidgetWindow.on("close", () => {
      this.trpcHandler.detachWindow(this.meetingWidgetWindow!);
    });

    this.meetingWidgetWindow.on("closed", () => {
      this.meetingWidgetWindow = null;
    });

    this.trpcHandler.attachWindow(this.meetingWidgetWindow);

    logger.main.info("Meeting recording widget window created", {
      bounds,
    });
  }

  hideNotificationWindow(): void {
    if (!this.notificationWindow || this.notificationWindow.isDestroyed()) {
      return;
    }

    this.notificationWindow.hide();
  }

  hideMeetingWidgetWindow(): void {
    if (!this.meetingWidgetWindow || this.meetingWidgetWindow.isDestroyed()) {
      return;
    }

    this.meetingWidgetWindow.setIgnoreMouseEvents(true, { forward: true });
    this.meetingWidgetWindow.hide();
  }

  setMeetingWidgetWindowIgnoreMouseEvents(ignore: boolean): void {
    if (!this.meetingWidgetWindow || this.meetingWidgetWindow.isDestroyed()) {
      return;
    }

    this.meetingWidgetWindow.setIgnoreMouseEvents(
      ignore,
      ignore ? { forward: true } : undefined,
    );
  }

  updateMeetingWidgetWindowPosition(
    screenY: number,
    pointerOffsetY: number,
  ): number | null {
    if (!this.meetingWidgetWindow || this.meetingWidgetWindow.isDestroyed()) {
      return null;
    }

    const currentBounds = this.meetingWidgetWindow.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width - 1,
      y: screenY,
    });
    const workArea = display.workArea;
    const edgeMargin = WindowManager.MEETING_WIDGET_EDGE_MARGIN;
    const verticalMargin = WindowManager.MEETING_WIDGET_VERTICAL_MARGIN;
    const minY = workArea.y + verticalMargin;
    const maxY =
      workArea.y + workArea.height - currentBounds.height - verticalMargin;
    const y = clamp(
      Math.round(screenY - pointerOffsetY),
      minY,
      Math.max(minY, maxY),
    );
    const x = workArea.x + workArea.width - currentBounds.width - edgeMargin;

    this.meetingWidgetWindow.setBounds({
      ...currentBounds,
      x,
      y,
    });

    if (maxY <= minY) {
      return 1;
    }

    return clampNormalizedY((y - minY) / (maxY - minY));
  }

  async navigateMainWindow(route: string): Promise<void> {
    const windowExisted = this.getMainWindow() !== null;

    await this.createOrShowMainWindow(route);

    if (windowExisted) {
      const mainWindow = this.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("navigate", route);
      }
    }
  }

  closeOnboardingWindow(): void {
    if (this.onboardingWindow && !this.onboardingWindow.isDestroyed()) {
      this.onboardingWindow.close();
    }

    // Re-enable main window
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setEnabled(true);
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  getOnboardingWindow(): BrowserWindow | null {
    return this.onboardingWindow;
  }

  getNotificationWindow(): BrowserWindow | null {
    return this.notificationWindow;
  }

  getMeetingWidgetWindow(): BrowserWindow | null {
    return this.meetingWidgetWindow;
  }

  getAllWindows(): (BrowserWindow | null)[] {
    return [
      this.mainWindow,
      this.onboardingWindow,
      this.notificationWindow,
      this.meetingWidgetWindow,
    ];
  }

  openAllDevTools(): void {
    const windows = this.getAllWindows().filter(
      (window): window is BrowserWindow =>
        window !== null && !window.isDestroyed(),
    );

    windows.forEach((window) => {
      if (window.webContents && !window.webContents.isDevToolsOpened()) {
        window.webContents.openDevTools();
      }
    });

    logger.main.info(`Opened dev tools for ${windows.length} windows`);
  }

  cleanup(): void {
    logger.main.info("Window manager cleanup complete");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampNormalizedY(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(1, Math.max(0, value));
}
