import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotMessageSchema } from "../../src/main/infra/mic-detector/native-mic-activity-client";

/**
 * Real-binary handshake checks. These specs run against the
 * locally built helper binaries (`pnpm --filter @prismical/mic-detector build`
 * / `@prismical/audio-capture build`) and skip when the binaries are absent —
 * the desktop CI job builds both before running this suite.
 *
 * Deliberate scope limits:
 * - mic-detector is spawned for real: it only *lists* mic-using apps (no
 *   capture), so it needs no TCC permission and is safe on any machine.
 * - audio-capture is NEVER spawned in a capture mode here (that would raise
 *   macOS TCC prompts). It has no --help flag (Arguments.swift); the asserted
 *   exit behavior is: invalid invocation (no --mode) fails fast with a
 *   non-zero exit before any capture starts.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const exe = process.platform === "win32" ? ".exe" : "";
const micDetectorBin = path.join(
  repoRoot,
  "packages/native-helpers/mic-detector/bin",
  `prismical-mic-detector${exe}`,
);
const audioCaptureBin = path.join(
  repoRoot,
  "packages/native-helpers/audio-capture/bin",
  `audio-capture${exe}`,
);

const hasMicDetector = fs.existsSync(micDetectorBin);
const hasAudioCapture = fs.existsSync(audioCaptureBin);

describe("native helper handshakes", () => {
  it.skipIf(!hasMicDetector)(
    "mic-detector emits at least one valid NDJSON snapshot, then stops on SIGTERM",
    async () => {
      const child = spawn(micDetectorBin, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const firstLine = await new Promise<string>((resolve, reject) => {
        let pending = "";
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("no snapshot line within 8s"));
        }, 8000);
        child.stdout.on("data", (chunk: Buffer) => {
          pending += chunk.toString("utf8");
          const lineEnd = pending.indexOf("\n");
          if (lineEnd >= 0) {
            clearTimeout(timeout);
            resolve(pending.slice(0, lineEnd).trim());
          }
        });
        child.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      const parsed = SnapshotMessageSchema.safeParse(JSON.parse(firstLine));
      expect(parsed.success).toBe(true);
      expect(parsed.data?.type).toBe("snapshot");
      expect(parsed.data?.timestampMs).toBeGreaterThan(0);
      expect(Array.isArray(parsed.data?.apps)).toBe(true);

      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.kill("SIGTERM");
      await exited;
    },
    15_000,
  );

  it.skipIf(!hasAudioCapture)(
    "audio-capture binary exists and fails fast on an invalid invocation (no capture mode started)",
    async () => {
      expect(fs.existsSync(audioCaptureBin)).toBe(true);
      // Executable bit present (POSIX platforms).
      expect(() => fs.accessSync(audioCaptureBin, fs.constants.X_OK)).not.toThrow();

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(audioCaptureBin, [], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("audio-capture did not exit within 5s"));
        }, 5000);
        child.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on("exit", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });

      expect(exitCode).not.toBe(0);
    },
    10_000,
  );
});
