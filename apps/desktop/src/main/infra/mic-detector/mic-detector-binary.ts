import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

export function resolveMicDetectorBinaryPath(): string {
  const binaryName =
    process.platform === "win32"
      ? "prismical-mic-detector.exe"
      : "prismical-mic-detector";

  if (app.isPackaged) {
    return path.join(process.resourcesPath, binaryName);
  }

  return path.join(
    process.cwd(),
    "..",
    "..",
    "packages",
    "native-helpers",
    "mic-detector",
    "bin",
    binaryName,
  );
}

export function assertMicDetectorBinaryExists(): string {
  const binaryPath = resolveMicDetectorBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Native mic detector binary not found at ${binaryPath}. Run the desktop build dependencies first.`,
    );
  }

  return binaryPath;
}
