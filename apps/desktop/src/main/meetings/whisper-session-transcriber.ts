import { app } from "electron";
import * as path from "node:path";
import { logger } from "../logger";
import { AppError, ErrorCodes } from "@/types/error";
import type { ModelService } from "@/services/model-service";
import { SimpleForkWrapper } from "@/pipeline/providers/transcription/simple-fork-wrapper";

interface TranscribeOptions {
  language?: string;
  initialPrompt?: string;
}

export class WhisperSessionTranscriber {
  private workerWrapper: SimpleForkWrapper | null = null;
  private currentModelPath: string | null = null;

  constructor(private readonly modelService: ModelService) {}

  async transcribeAudio(
    audio: Float32Array,
    options: TranscribeOptions = {},
  ): Promise<{ text: string; modelPath: string }> {
    const modelPath = await this.modelService.getBestAvailableModelPath();
    if (!modelPath) {
      throw new AppError(
        "No local Whisper model is available for meeting transcription.",
        ErrorCodes.MODEL_MISSING,
      );
    }

    await this.ensureWorker();
    await this.ensureModel(modelPath);

    if (!this.workerWrapper) {
      throw new AppError(
        "Whisper worker failed to initialize.",
        ErrorCodes.WORKER_INITIALIZATION_FAILED,
      );
    }

    const text = await this.workerWrapper.exec<string>("transcribeAudio", [
      audio,
      {
        language: options.language ?? "auto",
        initial_prompt: options.initialPrompt ?? "",
        suppress_blank: true,
        suppress_non_speech_tokens: true,
        no_timestamps: true,
      },
    ]);

    return {
      text,
      modelPath,
    };
  }

  async dispose(): Promise<void> {
    if (this.workerWrapper) {
      await this.workerWrapper.terminate();
      this.workerWrapper = null;
      this.currentModelPath = null;
    }
  }

  private async ensureWorker(): Promise<void> {
    if (this.workerWrapper) {
      return;
    }

    const workerPath = app.isPackaged
      ? path.join(__dirname, "whisper-worker-fork.js")
      : path.join(process.cwd(), ".vite/build/whisper-worker-fork.js");

    this.workerWrapper = new SimpleForkWrapper(
      workerPath,
      this.getNodeBinaryPath(),
    );

    await this.workerWrapper.initialize();
  }

  private async ensureModel(modelPath: string): Promise<void> {
    if (this.currentModelPath === modelPath) {
      return;
    }

    if (!this.workerWrapper) {
      throw new AppError(
        "Whisper worker is not available.",
        ErrorCodes.WORKER_INITIALIZATION_FAILED,
      );
    }

    logger.transcription.info("Initializing meeting Whisper model", {
      modelPath,
    });
    await this.workerWrapper.exec<void>("initializeModel", [modelPath]);
    this.currentModelPath = modelPath;
  }

  private getNodeBinaryPath(): string {
    const platform = process.platform;
    const arch = process.arch;
    const binaryName = platform === "win32" ? "node.exe" : "node";

    if (app.isPackaged) {
      return path.join(process.resourcesPath, binaryName);
    }

    return path.join(
      process.cwd(),
      "node-binaries",
      `${platform}-${arch}`,
      binaryName,
    );
  }
}
