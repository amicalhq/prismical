import { EventEmitter } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import split2 from "split2";
import { app } from "electron";
import { z } from "zod";
import { createScopedLogger } from "../logger";
import type { MicActivitySnapshotEvent } from "@/types/meeting-start-notifications";

const logger = createScopedLogger("notifications");

const SnapshotMessageSchema = z.object({
  type: z.literal("snapshot"),
  timestampMs: z.number(),
  apps: z.array(
    z.object({
      bundleId: z.string(),
      pid: z.number().int(),
      detectedAtMs: z.number(),
      applicationName: z.string().optional(),
    }),
  ),
});

interface NativeMicActivityClientEvents {
  snapshot: (event: MicActivitySnapshotEvent) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class NativeMicActivityClient extends EventEmitter {
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;

  on<U extends keyof NativeMicActivityClientEvents>(
    event: U,
    listener: NativeMicActivityClientEvents[U],
  ): this {
    return super.on(event, listener);
  }

  off<U extends keyof NativeMicActivityClientEvents>(
    event: U,
    listener: NativeMicActivityClientEvents[U],
  ): this {
    return super.off(event, listener);
  }

  emit<U extends keyof NativeMicActivityClientEvents>(
    event: U,
    ...args: Parameters<NativeMicActivityClientEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("Native mic activity detector is already running.");
    }

    const binaryPath = this.resolveBinaryPath();
    if (!fs.existsSync(binaryPath)) {
      throw new Error(
        `Native mic detector binary not found at ${binaryPath}. Run the desktop build dependencies first.`,
      );
    }

    logger.info("Starting native mic detector", { binaryPath });
    const child = spawn(binaryPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;

    child.stdout.pipe(split2()).on("data", (line: string) => {
      if (!line.trim()) {
        return;
      }

      try {
        const message = JSON.parse(line) as unknown;
        const parsed = SnapshotMessageSchema.safeParse(message);
        if (!parsed.success) {
          logger.warn("Ignoring invalid mic detector message", {
            line,
            issues: parsed.error.issues,
          });
          return;
        }

        this.emit("snapshot", parsed.data);
      } catch (error) {
        logger.warn("Failed to parse mic detector output", {
          line,
          error,
        });
      }
    });

    child.stderr.pipe(split2()).on("data", (line: string) => {
      if (!line.trim()) {
        return;
      }
      logger.info(line);
    });

    child.on("error", (error) => {
      this.emit("error", error);
    });

    child.on("exit", (code, signal) => {
      logger.info("Native mic detector exited", { code, signal });
      this.process = null;
      this.emit("exit", code, signal);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    const child = this.process;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1500);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      child.kill("SIGTERM");
    });
  }

  private resolveBinaryPath(): string {
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
}
