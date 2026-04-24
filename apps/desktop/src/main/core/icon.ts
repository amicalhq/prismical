import { app } from "electron";
import path from "node:path";

// Packaged builds pick up the bundle icon from packagerConfig.icon in
// forge.config.ts, but `electron-forge start` (dev) uses Electron's default
// icon unless we set one explicitly. Set BrowserWindow({ icon }) for the
// Windows/Linux taskbar and call app.dock.setIcon on macOS at startup.
export function getAppIconPath(): string {
  // extraResource copies ./assets to Contents/Resources/assets in packaged
  // builds; in dev the same folder lives under app.getAppPath().
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(base, "assets", "icon-512x512.png");
}
