import { describe, expect, it, vi } from "vitest";

// Mock electron before importing WindowManager
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  screen: {
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    getCursorScreenPoint: () => ({ x: 720, y: 450 }),
  },
  nativeTheme: { shouldUseDarkColors: false, themeSource: "system" },
  shell: {},
}));
vi.mock("../../src/main/logger", () => ({
  logger: { main: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { WindowManager } from "../../src/main/core/window-manager";

function makeManager() {
  // The constructor signature requires settingsService + trpcHandler;
  // both are unused by snap/bounds and can be mocked.
  return new WindowManager({} as any, {
    attachWindow: vi.fn(),
    detachWindow: vi.fn(),
  } as any);
}

function attachFakeWindow(mgr: WindowManager) {
  const fakeBounds = { x: 0, y: 0, width: 380, height: 240 };
  (mgr as any).meetingWidgetWindow = {
    isDestroyed: () => false,
    getBounds: () => fakeBounds,
    setBounds: (next: any) => Object.assign(fakeBounds, next),
  };
  return fakeBounds;
}

describe("WindowManager.snapMeetingWidgetToEdge", () => {
  it("snaps to right edge when cursor is near the right side", () => {
    const mgr = makeManager();
    attachFakeWindow(mgr);
    const result = mgr.snapMeetingWidgetToEdge(1400, 200);
    expect(result?.edge).toBe("right");
    expect(result?.normalizedPosition).toBeGreaterThanOrEqual(0);
    expect(result?.normalizedPosition).toBeLessThanOrEqual(1);
  });

  it("snaps to bottom edge when cursor is near the bottom", () => {
    const mgr = makeManager();
    attachFakeWindow(mgr);
    const result = mgr.snapMeetingWidgetToEdge(400, 880);
    expect(result?.edge).toBe("bottom");
  });

  it("normalizedPosition reflects cursor X when snapped to bottom", () => {
    const mgr = makeManager();
    attachFakeWindow(mgr);
    // Cursor near far-left should map to a low normalizedPosition.
    const left = mgr.snapMeetingWidgetToEdge(40, 880);
    const right = mgr.snapMeetingWidgetToEdge(1300, 880);
    expect(left?.normalizedPosition).toBeLessThan(right!.normalizedPosition);
  });

  it("returns null when the widget window is absent", () => {
    const mgr = makeManager();
    (mgr as any).meetingWidgetWindow = null;
    expect(mgr.snapMeetingWidgetToEdge(100, 100)).toBeNull();
  });
});
