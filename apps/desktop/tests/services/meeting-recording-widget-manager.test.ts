import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MeetingRecordingWidgetManager } from "../../src/main/managers/meeting-recording-widget-manager";
import type { MeetingStartNotificationPayload } from "../../src/types/meeting-start-notifications";
import type { MeetingWidgetSettings } from "../../src/services/settings-service";

class FakeMeetingManager extends EventEmitter {
  state = { state: "idle" as const, noteId: null as number | null };
  getState() {
    return this.state;
  }
}

class FakeSettingsService extends EventEmitter {
  async getMeetingWidgetSettings(): Promise<MeetingWidgetSettings> {
    return { visibility: "always", normalizedY: 0.5 };
  }
}

function createManager() {
  const meetingManager = new FakeMeetingManager();
  const settingsService = new FakeSettingsService();
  const windowManager = {
    createOrShowMeetingWidgetWindow: vi.fn(async () => undefined),
    setMeetingWidgetWindowIgnoreMouseEvents: vi.fn(),
    hideMeetingWidgetWindow: vi.fn(),
    getMainWindow: vi.fn(() => null),
    getMeetingWidgetWindow: vi.fn(() => null),
    updateMeetingWidgetWindowPosition: vi.fn(),
  };
  const manager = new MeetingRecordingWidgetManager({
    settingsService: settingsService as any,
    windowManager: windowManager as any,
    meetingManager: meetingManager as any,
  });
  return { manager, meetingManager, settingsService, windowManager };
}

const samplePayload: MeetingStartNotificationPayload = {
  id: "test-id",
  bundleId: "us.zoom.xos",
  displayName: "Zoom",
  category: "native",
  title: "Meeting detected in Zoom",
  subtitle: "Zoom is using your microphone",
  detectedAtMs: 1_700_000_000_000,
};

describe("MeetingRecordingWidgetManager.setMeetingDetection", () => {
  it("starts with meetingDetection: null", () => {
    const { manager } = createManager();
    expect(manager.getState().meetingDetection).toBeNull();
  });

  it("sets the detection payload and emits state-changed", () => {
    const { manager } = createManager();
    const listener = vi.fn();
    manager.on("state-changed", listener);

    manager.setMeetingDetection(samplePayload);

    expect(manager.getState().meetingDetection).toEqual(samplePayload);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].meetingDetection).toEqual(samplePayload);
  });

  it("does not re-emit when called with the same id", () => {
    const { manager } = createManager();
    manager.setMeetingDetection(samplePayload);
    const listener = vi.fn();
    manager.on("state-changed", listener);

    manager.setMeetingDetection(samplePayload);

    expect(listener).not.toHaveBeenCalled();
  });

  it("clears the detection when called with null", () => {
    const { manager } = createManager();
    manager.setMeetingDetection(samplePayload);
    const listener = vi.fn();
    manager.on("state-changed", listener);

    manager.setMeetingDetection(null);

    expect(manager.getState().meetingDetection).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("MeetingRecordingWidgetManager visibility with detection", () => {
  it("keeps the widget visible when visibility=while-recording and a detection is active", async () => {
    const { manager, settingsService } = createManager();
    settingsService.getMeetingWidgetSettings = async () => ({
      visibility: "while-recording" as const,
      normalizedY: 0.5,
    });
    await manager.start();

    expect(manager.getState().visible).toBe(false);

    manager.setMeetingDetection(samplePayload);
    expect(manager.getState().visible).toBe(true);

    manager.setMeetingDetection(null);
    expect(manager.getState().visible).toBe(false);

    await manager.cleanup();
  });
});
