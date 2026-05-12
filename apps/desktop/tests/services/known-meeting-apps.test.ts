import { describe, expect, it } from "vitest";
import { findKnownMeetingApp } from "../../src/main/notifications/known-meeting-apps";

describe("findKnownMeetingApp", () => {
  it("matches Windows executable aliases for native meeting apps", () => {
    expect(findKnownMeetingApp("zoom.exe")?.bundleId).toBe("us.zoom.xos");
    expect(findKnownMeetingApp("ms-teams.exe")?.bundleId).toBe(
      "com.microsoft.teams2",
    );
    expect(findKnownMeetingApp("slack.exe")?.bundleId).toBe(
      "com.tinyspeck.slackmacgap",
    );
  });

  it("matches Windows executable aliases for browsers", () => {
    expect(findKnownMeetingApp("chrome.exe")?.bundleId).toBe(
      "com.google.Chrome",
    );
    expect(findKnownMeetingApp("msedge.exe")?.bundleId).toBe(
      "com.microsoft.edgemac",
    );
    expect(findKnownMeetingApp("firefox.exe")?.bundleId).toBe(
      "org.mozilla.firefox",
    );
  });
});
