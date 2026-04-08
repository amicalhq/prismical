import { EventEmitter } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { logger } from "../logger";
import type {
  AudioFrame,
  AudioSource,
  MeetingCaptureMode,
} from "@/types/meeting";

const PACKET_HEADER_SIZE = 32;
const PACKET_VERSION = 1;
const PACKET_FORMAT_FLOAT32 = 1;

interface NativeAudioCaptureEvents {
  frame: (frame: AudioFrame) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class NativeAudioCaptureClient extends EventEmitter {
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private pending = Buffer.alloc(0);

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
    },
  ): Promise<void> {
    if (this.process) {
      throw new Error("Native audio capture is already running.");
    }

    const binaryPath = this.resolveBinaryPath();
    if (!fs.existsSync(binaryPath)) {
      throw new Error(
        `Native capture binary not found at ${binaryPath}. Run the desktop build dependencies first.`,
      );
    }

    logger.audio.info("Starting native audio capture", {
      binaryPath,
      mode,
      debugArtifactsDir: options?.debugArtifactsDir,
    });

    this.pending = Buffer.alloc(0);
    const args = ["--mode", mode];
    if (options?.debugArtifactsDir) {
      args.push("--debug-artifacts-dir", options.debugArtifactsDir);
    }

    const captureProcess = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = captureProcess;

    captureProcess.stdout.on("data", (data: Buffer) => {
      this.handleStdoutData(data);
    });

    captureProcess.stderr.on("data", (data: Buffer) => {
      logger.swift.info(data.toString("utf8").trim());
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

      captureProcess.kill("SIGTERM");
    });
  }

  private handleStdoutData(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);

    while (this.pending.length >= PACKET_HEADER_SIZE) {
      const header = this.pending.subarray(0, PACKET_HEADER_SIZE);
      const frameBytes = header.readUInt32LE(24);
      const packetSize = PACKET_HEADER_SIZE + frameBytes;

      if (this.pending.length < packetSize) {
        break;
      }

      const payload = this.pending.subarray(PACKET_HEADER_SIZE, packetSize);
      this.pending = this.pending.subarray(packetSize);
      const frame = this.parseFrame(header, payload);
      this.emit("frame", frame);
    }
  }

  private parseFrame(header: Buffer, payload: Buffer): AudioFrame {
    const version = header.readUInt8(0);
    const sourceId = header.readUInt8(1);
    const format = header.readUInt8(2);
    const channels = header.readUInt8(3);
    const sampleRate = header.readUInt32LE(4);
    const sequenceNum = header.readUInt32LE(8);
    const durationMs = header.readUInt32LE(12);
    const timestampMs = Number(header.readBigUInt64LE(16));

    if (version !== PACKET_VERSION) {
      throw new Error(`Unsupported audio packet version: ${version}`);
    }

    if (format !== PACKET_FORMAT_FLOAT32) {
      throw new Error(`Unsupported audio packet format: ${format}`);
    }

    if (channels !== 1 || sampleRate !== 48000) {
      throw new Error(
        `Unexpected audio packet format: sampleRate=${sampleRate} channels=${channels}`,
      );
    }

    return {
      source: sourceId === 1 ? "mic" : "system",
      samples: this.parseSamples(payload),
      sampleRate,
      channels,
      timestampMs,
      durationMs,
      sequenceNum,
    };
  }

  private parseSamples(payload: Buffer): Float32Array {
    const arrayBuffer = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength,
    );
    return new Float32Array(arrayBuffer);
  }

  private resolveBinaryPath(): string {
    const binaryName =
      process.platform === "win32"
        ? "prismical-audio-capture.exe"
        : "prismical-audio-capture";

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
}
