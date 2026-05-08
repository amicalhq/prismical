import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MeetingStartNotificationManager } from "../../src/main/managers/meeting-start-notification-manager";

vi.mock("../../src/services/notes-service", () => {
  return {
    default: {
      getInstance: () => ({
        createNote: vi.fn(async ({ title }: { title: string }) => ({
          id: 42,
          title,
        })),
      }),
    },
  };
});

vi.mock("../../src/main/notifications/native-mic-activity-client", async () => {
  const { EventEmitter: NodeEventEmitter } = await import("node:events");
  class FakeClient extends NodeEventEmitter {
    async start() {}
    async stop() {}
  }
  return { NativeMicActivityClient: FakeClient };
});

class FakeMeetingManager extends EventEmitter {
  getState() {
    return { state: "idle" as const, noteId: null };
  }
}

function createManager() {
  const widgetManager = {
    setMeetingDetection: vi.fn(),
  };
  const windowManager = {
    navigateMainWindow: vi.fn(async () => undefined),
  };
  const settingsService = {
    async getMeetingNotificationSettings() {
      return {
        enabled: true,
        impromptuEnabled: true,
        detectionDelayMs: 4000,
        cooldownMs: 300_000,
        blockedBundleIds: [],
      };
    },
  };
  const onboardingService = { isInProgress: () => false };
  const telemetryService = { trackNoteCreated: vi.fn() };
  const meetingManager = new FakeMeetingManager();
  const manager = new MeetingStartNotificationManager({
    settingsService: settingsService as any,
    windowManager: windowManager as any,
    meetingManager: meetingManager as any,
    meetingRecordingWidgetManager: widgetManager as any,
    onboardingService: onboardingService as any,
    telemetryService: telemetryService as any,
  });
  return { manager, widgetManager, windowManager, telemetryService };
}

describe("MeetingStartNotificationManager.startNoteFromIdle", () => {
  it("creates a note with a generic title and navigates to it", async () => {
    const { manager, windowManager } = createManager();

    const result = await manager.startNoteFromIdle();

    expect(result).toEqual({ noteId: 42 });
    expect(windowManager.navigateMainWindow).toHaveBeenCalledWith(
      "/notes/42?autoRecord=true",
    );
  });

  it("clears any active detection after starting", async () => {
    const { manager, widgetManager } = createManager();
    await manager.startNoteFromIdle();
    expect(widgetManager.setMeetingDetection).toHaveBeenCalledWith(null);
  });
});
