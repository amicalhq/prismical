import dotenv from "dotenv";
dotenv.config();

import { app, ipcMain } from "electron";
import { logger } from "./logger";

import started from "electron-squirrel-startup";
import { AppManager } from "./core/app-manager";
import { getAppIconPath } from "./core/icon";
import { isWindows } from "../utils/platform";
import { ServiceManager } from "./managers/service-manager";

// Setup renderer logging relay (allows renderer to send logs to main process)
ipcMain.handle(
  "log-message",
  (_event, level: string, scope: string, ...args: unknown[]) => {
    const scopedLogger =
      logger[scope as keyof typeof logger] || logger.renderer;
    const logMethod = scopedLogger[level as keyof typeof scopedLogger];
    if (typeof logMethod === "function") {
      logMethod(...args);
    }
  },
);

if (started) {
  app.quit();
}

// Set App User Model ID for Windows (required for Squirrel.Windows)
if (isWindows()) {
  app.setAppUserModelId("com.prismical.desktop");
}

// Register the prismical:// protocol
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("prismical", process.execPath, [
      process.argv[1],
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("prismical");
}

// Enforce single instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  app.quit();
}

const appManager = new AppManager();

// Track initialization state for deep link handling
let isInitialized = false;
let pendingDeepLink: string | null = null;

// Handle protocol on macOS
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (isInitialized) {
    appManager.handleDeepLink(url);
  } else {
    pendingDeepLink = url;
  }
});

// Handle when another instance tries to start (Windows/Linux deep link handling)
app.on("second-instance", (_event, commandLine) => {
  // Someone tried to run a second instance, we should focus our window instead.
  if (isInitialized) {
    appManager.handleSecondInstance();
  }

  // Check if this is a protocol launch on Windows/Linux
  const url = commandLine.find((arg) => arg.startsWith("prismical://"));
  if (url) {
    if (isInitialized) {
      appManager.handleDeepLink(url);
    } else {
      pendingDeepLink = url;
    }
  }
});

app.whenReady().then(async () => {
  try {
    // macOS dock icon in dev: packaged builds read the bundle icon from
    // packagerConfig.icon, but electron-forge start shows Electron's default
    // unless we set one explicitly.
    if (process.platform === "darwin") {
      app.dock?.setIcon(getAppIconPath());
    }
    await appManager.initialize();
    isInitialized = true;

    // Process any deep link that was received before initialization completed
    if (pendingDeepLink) {
      appManager.handleDeepLink(pendingDeepLink);
      pendingDeepLink = null;
    }
  } catch (error) {
    logger.main.error("Application failed to initialize", { error });
    const telemetryService = ServiceManager.getInstance().getTelemetryService();
    await telemetryService?.captureExceptionImmediateAndShutdown(error, {
      source: "main_process",
      stage: "app_initialize",
    });
    app.quit();
  }
});
app.on("will-quit", () => appManager.cleanup());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (!isInitialized) return;
  appManager.handleActivate();
});
