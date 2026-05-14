import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  return {
    BrowserWindow: { fromWebContents: vi.fn() },
    ipcMain: { handle: vi.fn() },
  };
});

describe("main/find-in-page", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers find-in-page:start and find-in-page:stop", async () => {
    const { ipcMain } = await import("electron");
    const { registerFindInPageHandlers } = await import("@/main/find-in-page");
    registerFindInPageHandlers();
    expect(ipcMain.handle).toHaveBeenCalledWith(
      "find-in-page:start",
      expect.any(Function),
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(
      "find-in-page:stop",
      expect.any(Function),
    );
  });
});
