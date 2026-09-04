import { describe, expect, it } from "vitest";
import { SnapshotMessageSchema } from "../../src/main/infra/mic-detector/native-mic-activity-client";

/**
 * Golden NDJSON fixtures for the mic-detector snapshot contract
 * One JSON object per line, 1 Hz:
 *   { "type": "snapshot", "timestampMs": <number>, "apps": [ { "bundleId",
 *     "pid" (int), "detectedAtMs", "applicationName"? } ] }
 */

const validLine = JSON.stringify({
  type: "snapshot",
  timestampMs: 1_730_000_000_000,
  apps: [
    {
      bundleId: "us.zoom.xos",
      pid: 4242,
      detectedAtMs: 1_729_999_999_000,
      applicationName: "zoom.us",
      inputDevices: [{ uid: "mic-1", name: "Studio Display Microphone" }],
    },
  ],
});

describe("mic-detector NDJSON snapshot schema", () => {
  it("accepts a valid snapshot line", () => {
    const parsed = SnapshotMessageSchema.safeParse(JSON.parse(validLine));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.type).toBe("snapshot");
    expect(parsed.data?.apps[0].bundleId).toBe("us.zoom.xos");
    expect(parsed.data?.apps[0].applicationName).toBe("zoom.us");
    expect(parsed.data?.apps[0].inputDevices).toEqual([
      { uid: "mic-1", name: "Studio Display Microphone" },
    ]);
  });

  it("accepts a snapshot with no active apps and no applicationName", () => {
    expect(
      SnapshotMessageSchema.safeParse({
        type: "snapshot",
        timestampMs: 1,
        apps: [],
      }).success,
    ).toBe(true);
    expect(
      SnapshotMessageSchema.safeParse({
        type: "snapshot",
        timestampMs: 1,
        apps: [{ bundleId: "com.apple.Safari", pid: 1, detectedAtMs: 1 }],
      }).success,
    ).toBe(true);
  });

  it("rejects malformed snapshot lines", () => {
    const malformed: unknown[] = [
      // wrong discriminator
      { type: "heartbeat", timestampMs: 1, apps: [] },
      // missing timestamp
      { type: "snapshot", apps: [] },
      // timestamp of the wrong type
      { type: "snapshot", timestampMs: "now", apps: [] },
      // apps not an array
      { type: "snapshot", timestampMs: 1, apps: {} },
      // non-integer pid
      {
        type: "snapshot",
        timestampMs: 1,
        apps: [{ bundleId: "a", pid: 1.5, detectedAtMs: 1 }],
      },
      // missing bundleId
      {
        type: "snapshot",
        timestampMs: 1,
        apps: [{ pid: 1, detectedAtMs: 1 }],
      },
      // incomplete input-device identity
      {
        type: "snapshot",
        timestampMs: 1,
        apps: [
          {
            bundleId: "a",
            pid: 1,
            detectedAtMs: 1,
            inputDevices: [{ uid: "mic-1" }],
          },
        ],
      },
      // stderr noise that reached stdout
      "PrismicalMicDetector started",
      null,
    ];

    for (const message of malformed) {
      expect(SnapshotMessageSchema.safeParse(message).success).toBe(false);
    }
  });

  it("rejects a line that is not valid JSON (parse layer contract)", () => {
    expect(() => JSON.parse("{not json")).toThrow();
  });
});
