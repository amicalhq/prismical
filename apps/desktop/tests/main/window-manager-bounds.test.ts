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

function attachFakeWindow(
  mgr: WindowManager,
  initial: { x: number; y: number } = { x: 0, y: 0 },
) {
  const fakeBounds = { ...initial, width: 380, height: 240 };
  (mgr as any).meetingWidgetWindow = {
    isDestroyed: () => false,
    getBounds: () => fakeBounds,
    setBounds: (next: any) => Object.assign(fakeBounds, next),
  };
  return fakeBounds;
}

describe("WindowManager.snapMeetingWidgetToEdge", () => {
  it("snaps to right edge when window center is near the right side", () => {
    const mgr = makeManager();
    // Window top-left at (1200, 200) → center ≈ (1390, 320) on 1440×900 area.
    // distanceToRight ≈ 50, distanceToBottom ≈ 580 → right.
    attachFakeWindow(mgr, { x: 1200, y: 200 });
    const result = mgr.snapMeetingWidgetToEdge(0, 0);
    expect(result?.edge).toBe("right");
    expect(result?.normalizedPosition).toBeGreaterThanOrEqual(0);
    expect(result?.normalizedPosition).toBeLessThanOrEqual(1);
  });

  it("snaps to bottom edge when window center is near the bottom", () => {
    const mgr = makeManager();
    // Window top-left at (400, 700) → centerY ≈ 820. distanceToBottom ≈ 80,
    // distanceToRight ≈ 850 → bottom.
    attachFakeWindow(mgr, { x: 400, y: 700 });
    const result = mgr.snapMeetingWidgetToEdge(0, 0);
    expect(result?.edge).toBe("bottom");
  });

  it("normalizedPosition reflects window X when snapped to bottom", () => {
    const leftMgr = makeManager();
    attachFakeWindow(leftMgr, { x: 10, y: 700 });
    const left = leftMgr.snapMeetingWidgetToEdge(0, 0);

    const rightMgr = makeManager();
    attachFakeWindow(rightMgr, { x: 1000, y: 700 });
    const right = rightMgr.snapMeetingWidgetToEdge(0, 0);

    expect(left?.edge).toBe("bottom");
    expect(right?.edge).toBe("bottom");
    expect(left?.normalizedPosition).toBeLessThan(right!.normalizedPosition);
  });

  it("returns null when the widget window is absent", () => {
    const mgr = makeManager();
    (mgr as any).meetingWidgetWindow = null;
    expect(mgr.snapMeetingWidgetToEdge(100, 100)).toBeNull();
  });
});

describe("WindowManager.updateMeetingWidgetWindowPositionFree", () => {
  it("places the window so the grip point stays under the cursor", () => {
    // Window starts at (100, 100). User grabbed the handle at clientX=370,
    // clientY=20 inside the window (so the grip was at screen (470, 120)).
    // They now drag the cursor to screen (800, 400). Expected window
    // top-left: (800 - 370, 400 - 20) = (430, 380), so the grip lands
    // back under the cursor.
    const mgr = makeManager();
    attachFakeWindow(mgr, { x: 100, y: 100 });
    const next = mgr.updateMeetingWidgetWindowPositionFree(800, 400, 370, 20);
    expect(next).not.toBeNull();
    expect(next?.x).toBe(430);
    expect(next?.y).toBe(380);
  });

  it("clamps the window to the work area", () => {
    // Cursor + grip would put the window at (-200, -200); clamp keeps the
    // window inside the 1440×900 work area at (0, 0).
    const mgr = makeManager();
    attachFakeWindow(mgr, { x: 100, y: 100 });
    const next = mgr.updateMeetingWidgetWindowPositionFree(170, 170, 370, 370);
    expect(next?.x).toBe(0);
    expect(next?.y).toBe(0);
  });

  it("clamps against the bottom-right when dragged past the edge", () => {
    // 380×240 window. Work area 1440×900. Max x = 1440-380 = 1060,
    // max y = 900-240 = 660. screen (2000, 1500) with no grip offset
    // would land at (2000, 1500); clamp pins to (1060, 660).
    const mgr = makeManager();
    attachFakeWindow(mgr, { x: 100, y: 100 });
    const next = mgr.updateMeetingWidgetWindowPositionFree(2000, 1500, 0, 0);
    expect(next?.x).toBe(1060);
    expect(next?.y).toBe(660);
  });

  it("returns null when the widget window is absent", () => {
    const mgr = makeManager();
    (mgr as any).meetingWidgetWindow = null;
    expect(
      mgr.updateMeetingWidgetWindowPositionFree(100, 100, 0, 0),
    ).toBeNull();
  });
});
