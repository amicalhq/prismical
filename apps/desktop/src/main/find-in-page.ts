import { BrowserWindow, ipcMain } from "electron";

interface FindStartPayload {
  query: string;
  forward?: boolean;
  findNext?: boolean;
}

export function registerFindInPageHandlers(): void {
  ipcMain.handle(
    "find-in-page:start",
    async (event, payload: FindStartPayload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      const { query, forward = true, findNext = false } = payload;
      if (!query) {
        win.webContents.stopFindInPage("clearSelection");
        return;
      }
      win.webContents.findInPage(query, { forward, findNext });
    },
  );

  ipcMain.handle("find-in-page:stop", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.webContents.stopFindInPage("clearSelection");
  });
}
