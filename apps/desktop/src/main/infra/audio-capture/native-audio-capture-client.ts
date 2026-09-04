import { EventEmitter } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { logger } from "../../logger";
import type { AudioFrame, MeetingCaptureMode } from "@/types/meeting";
import { assertAudioCaptureBinaryExists } from "./audio-capture-binary";
import {
  createPacketReader,
  parseAecMode,
  type PacketReader,
} from "./packet-protocol";

interface NativeAudioCaptureEvents {
  frame: (frame: AudioFrame) => void;
  "aec-mode": (mode: string) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class NativeAudioCaptureClient extends EventEmitter {
  private process: ChildProcessByStdio<Writable, Readable, Readable> | null =
    null;
  private reader: PacketReader = createPacketReader();
  private stderrPending = "";

  on<U extends keyof NativeAudioCaptureEvents>(
    event: U,
    listener: NativeAudioCaptureEvents[U],
  ): this {
    return super.on(event, listener);
  }

  off<U extends keyof NativeAudioCaptureEvents>(
    event: U,
    listener: NativeAudioCaptureEvents[U],
  ): this {
    return super.off(event, listener);
  }

  emit<U extends keyof NativeAudioCaptureEvents>(
    event: U,
    ...args: Parameters<NativeAudioCaptureEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  async start(
    mode: MeetingCaptureMode,
    options?: {
      debugArtifactsDir?: string;
      aecRenderHoldbackMs?: number;
      aecRenderWaitTimeoutMs?: number;
    },
  ): Promise<void> {
    if (this.process) {
      throw new Error("Native audio capture is already running.");
    }

    const binaryPath = assertAudioCaptureBinaryExists();

    logger.audio.info("Starting native audio capture", {
      binaryPath,
      mode,
      debugArtifactsDir: options?.debugArtifactsDir,
      aecRenderHoldbackMs: options?.aecRenderHoldbackMs,
      aecRenderWaitTimeoutMs: options?.aecRenderWaitTimeoutMs,
    });

    this.reader = createPacketReader();
    this.stderrPending = "";
    const args = ["--mode", mode];
    if (options?.debugArtifactsDir) {
      args.push("--debug-artifacts-dir", options.debugArtifactsDir);
    }
    if (options?.aecRenderHoldbackMs != null) {
      args.push(
        "--aec-render-holdback-ms",
        String(options.aecRenderHoldbackMs),
      );
    }
    if (options?.aecRenderWaitTimeoutMs != null) {
      args.push(
        "--aec-render-wait-timeout-ms",
        String(options.aecRenderWaitTimeoutMs),
      );
    }

    const captureProcess = spawn(binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = captureProcess;

    captureProcess.stdin.on("error", (error) => {
      logger.audio.warn("Native audio capture stdin error", {
        error: error.message,
      });
    });

    captureProcess.stdout.on("data", (data: Buffer) => {
      this.handleStdoutData(data);
    });

    captureProcess.stderr.on("data", (data: Buffer) => {
      this.handleStderrData(data);
    });

    captureProcess.on("error", (error) => {
      this.emit("error", error);
    });

    captureProcess.on("exit", (code, signal) => {
      logger.audio.info("Native audio capture exited", { code, signal });
      this.process = null;
      this.emit("exit", code, signal);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    const captureProcess = this.process;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        captureProcess.kill("SIGKILL");
      }, 1500);

      captureProcess.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      if (process.platform === "win32") {
        captureProcess.stdin.end("stop\n");
      } else {
        captureProcess.kill("SIGTERM");
      }
    });
  }

  private handleStdoutData(chunk: Buffer): void {
    for (const frame of this.reader.push(chunk)) {
      this.emit("frame", frame);
    }
  }

  private handleStderrData(chunk: Buffer): void {
    this.stderrPending += chunk.toString("utf8");
    const lines = this.stderrPending.split(/\r?\n/);
    this.stderrPending = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      logger.audio.info(trimmed);
      this.maybeEmitAecMode(trimmed);
    }
  }

  private maybeEmitAecMode(line: string): void {
    const mode = parseAecMode(line);
    if (mode) {
      this.emit("aec-mode", mode);
    }
  }
}
