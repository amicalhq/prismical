import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

export function resolveAudioCaptureBinaryPath(): string {
  const binaryName =
    process.platform === "win32" ? "audio-capture.exe" : "audio-capture";

  if (app.isPackaged) {
    return path.join(process.resourcesPath, binaryName);
  }

  return path.join(
    process.cwd(),
    "..",
    "..",
    "packages",
    "native-helpers",
    "audio-capture",
    "bin",
    binaryName,
  );
}

export function assertAudioCaptureBinaryExists(): string {
  const binaryPath = resolveAudioCaptureBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Native capture binary not found at ${binaryPath}. Run the desktop build dependencies first.`,
    );
  }

  return binaryPath;
}
