import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { app } from "electron";
import {
  AvailableWhisperModel,
  DownloadProgress,
  ModelManagerState,
  AVAILABLE_MODELS,
} from "../constants/models";
import {
  PROVIDER_TYPES,
  SINGLETON_INSTANCE_IDS,
} from "../constants/provider-types";
import {
  addLocalWhisperModel,
  getInstanceById,
  removeLocalWhisperModel,
} from "../db/instances";
import type {
  LocalWhisperConfig,
  LocalWhisperDownloadedModel,
} from "../db/schema";
import { SettingsService } from "./settings-service";
import { logger } from "../main/logger";
import { getUserAgent } from "../utils/http-client";

// Local whisper is a singleton system instance — its id is fixed in the
// constants registry and the bootstrap step seeds the row.
const LOCAL_WHISPER_INSTANCE_ID =
  SINGLETON_INSTANCE_IDS[PROVIDER_TYPES.localWhisper] ?? "system-local-whisper";

// Order we prefer when no explicit speech model is selected. Higher quality
// first; the picker initialization auto-selects the best one available.
const PREFERRED_WHISPER_ORDER = [
  "whisper-large-v3-turbo",
  "whisper-large-v3",
  "whisper-large-v1",
  "whisper-medium",
  "whisper-small",
  "whisper-base",
  "whisper-tiny",
];

interface ModelManagerEvents {
  "download-progress": (modelId: string, progress: DownloadProgress) => void;
  "download-complete": (
    modelId: string,
    entry: LocalWhisperDownloadedModel,
  ) => void;
  "download-error": (modelId: string, error: Error) => void;
  "download-cancelled": (modelId: string) => void;
  "model-deleted": (modelId: string) => void;
  // Speech-only since ModelService now manages only the local-whisper instance.
  // Language / embedding selection events live on the tRPC instances router.
  "selection-changed": (
    oldModelId: string | null,
    newModelId: string | null,
    reason:
      | "manual"
      | "auto-first-download"
      | "auto-after-deletion"
      | "cleared",
  ) => void;
}

/**
 * Manages the local Whisper instance: download lifecycle, on-disk file
 * tracking, and the speech-default selection.
 *
 * Hot path (every transcription chunk): WhisperProvider →
 * `getBestAvailableModelPath()` → reads the local-whisper instance row's
 * config + the user's transcription default → returns a file path.
 */
class ModelService extends EventEmitter {
  private state: ModelManagerState;
  private modelsDirectory: string;
  private settingsService: SettingsService;

  constructor(settingsService: SettingsService) {
    super();
    this.state = { activeDownloads: new Map() };
    this.settingsService = settingsService;
    this.modelsDirectory = path.join(app.getPath("userData"), "models");
    this.ensureModelsDirectory();
  }

  // Type-safe event emitter shims
  on<U extends keyof ModelManagerEvents>(
    event: U,
    listener: ModelManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }
  emit<U extends keyof ModelManagerEvents>(
    event: U,
    ...args: Parameters<ModelManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }
  off<U extends keyof ModelManagerEvents>(
    event: U,
    listener: ModelManagerEvents[U],
  ): this {
    return super.off(event, listener);
  }
  once<U extends keyof ModelManagerEvents>(
    event: U,
    listener: ModelManagerEvents[U],
  ): this {
    return super.once(event, listener);
  }

  /**
   * Validate or auto-select the speech default after bootstrap.
   * Bootstrap (`instance-bootstrap.ts`) has already reconciled the instance
   * row with the filesystem, so we only need to:
   *   1. Drop the default if its file no longer exists.
   *   2. Auto-pick the best downloaded model if no default is set yet.
   */
  async initialize(): Promise<void> {
    try {
      await this.validateSpeechDefault();
      await this.maybeAutoSelectFirstDownloaded();
      logger.main.info("Model service initialized");
    } catch (error) {
      logger.main.error("Error initializing model service", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensureModelsDirectory(): void {
    if (!fs.existsSync(this.modelsDirectory)) {
      fs.mkdirSync(this.modelsDirectory, { recursive: true });
      logger.main.info("Created models directory", {
        path: this.modelsDirectory,
      });
    }
  }

  // ---------- Static manifest ----------

  getAvailableModels(): AvailableWhisperModel[] {
    return AVAILABLE_MODELS;
  }

  getModelsDirectory(): string {
    return this.modelsDirectory;
  }

  // ---------- Downloaded model bookkeeping ----------

  /**
   * Read the local-whisper instance config and return downloaded entries
   * keyed by model id. Empty record if the instance row is missing
   * (shouldn't happen post-bootstrap, but we don't crash the renderer).
   */
  async getDownloadedModels(): Promise<
    Record<string, LocalWhisperDownloadedModel>
  > {
    const config = await this.readLocalWhisperConfig();
    const out: Record<string, LocalWhisperDownloadedModel> = {};
    for (const entry of config.downloadedModels) out[entry.id] = entry;
    return out;
  }

  /** Alias retained for callers that distinguish "downloaded" vs "valid". */
  async getValidDownloadedModels(): Promise<
    Record<string, LocalWhisperDownloadedModel>
  > {
    return this.getDownloadedModels();
  }

  async isModelDownloaded(modelId: string): Promise<boolean> {
    const downloaded = await this.getDownloadedModels();
    return Object.prototype.hasOwnProperty.call(downloaded, modelId);
  }

  async isAvailable(): Promise<boolean> {
    const downloaded = await this.getDownloadedModels();
    return Object.keys(downloaded).length > 0;
  }

  async getAvailableModelsForTranscription(): Promise<string[]> {
    const downloaded = await this.getDownloadedModels();
    return Object.keys(downloaded);
  }

  /** Resolve a downloaded entry to its on-disk path. */
  pathForEntry(entry: LocalWhisperDownloadedModel): string {
    return path.join(this.modelsDirectory, entry.filename);
  }

  // ---------- Download lifecycle ----------

  getDownloadProgress(modelId: string): DownloadProgress | null {
    return this.state.activeDownloads.get(modelId) ?? null;
  }

  getActiveDownloads(): DownloadProgress[] {
    return Array.from(this.state.activeDownloads.values());
  }

  async downloadModel(modelId: string): Promise<void> {
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (!model) throw new Error(`Model not found: ${modelId}`);

    if (await this.isModelDownloaded(modelId)) {
      throw new Error(`Model already downloaded: ${modelId}`);
    }
    if (this.state.activeDownloads.has(modelId)) {
      throw new Error(`Download already in progress: ${modelId}`);
    }

    const abortController = new AbortController();
    const downloadPath = path.join(this.modelsDirectory, model.filename);

    const progress: DownloadProgress = {
      modelId,
      progress: 0,
      status: "downloading",
      bytesDownloaded: 0,
      totalBytes: model.size,
      abortController,
    };
    this.state.activeDownloads.set(modelId, progress);
    this.emit("download-progress", modelId, progress);

    // Two-phase: phase 1 owns the file (unlink on failure); phase 2 is
    // best-effort bookkeeping (auto-select + complete event) and must NOT
    // tear down the persisted entry if it throws.
    let entryPersisted = false;
    let persistedEntry: LocalWhisperDownloadedModel | null = null;

    try {
      logger.main.info("Starting model download", {
        modelId,
        size: model.sizeFormatted,
        url: model.downloadUrl,
      });

      const response = await fetch(model.downloadUrl, {
        signal: abortController.signal,
        headers: { "User-Agent": getUserAgent() },
      });
      if (!response.ok) {
        throw new Error(
          `Failed to download: ${response.status} ${response.statusText}`,
        );
      }

      const totalBytes =
        parseInt(response.headers.get("content-length") || "0") || model.size;
      progress.totalBytes = totalBytes;

      const fileStream = fs.createWriteStream(downloadPath);
      let bytesDownloaded = 0;
      let lastProgressEmit = 0;

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Failed to get response reader");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (abortController.signal.aborted) {
          fileStream.close();
          fs.unlinkSync(downloadPath);
          throw new Error("Download cancelled");
        }

        fileStream.write(value);
        bytesDownloaded += value.length;
        progress.bytesDownloaded = bytesDownloaded;
        progress.progress = Math.round((bytesDownloaded / totalBytes) * 100);

        // Emit progress every 1% or 1MB to avoid event spam.
        if (
          progress.progress - lastProgressEmit >= 1 ||
          bytesDownloaded - (lastProgressEmit * totalBytes) / 100 >= 1024 * 1024
        ) {
          this.emit("download-progress", modelId, { ...progress });
          lastProgressEmit = progress.progress;
        }
      }

      fileStream.end();
      const stats = fs.statSync(downloadPath);
      logger.main.info("Download completed", {
        modelId,
        expectedSize: totalBytes,
        actualSize: stats.size,
      });

      // Verify checksum if the manifest provided one. Mismatch deletes the
      // file; the helper has not yet been called so nothing to undo on the
      // instance config side.
      if (model.checksum) {
        const fileChecksum = await this.calculateFileChecksum(downloadPath);
        if (fileChecksum !== model.checksum) {
          fs.unlinkSync(downloadPath);
          throw new Error(
            `Checksum mismatch. Expected: ${model.checksum}, Got: ${fileChecksum}`,
          );
        }
      }

      // Persist to the instance config. Crash-window: file is on disk; if
      // we crash before this returns, bootstrap reconciliation adopts it
      // on next start (see db/instances.ts contract).
      const entry: LocalWhisperDownloadedModel = {
        id: model.id,
        filename: model.filename,
        sizeBytes: stats.size,
        checksum: model.checksum,
        downloadedAt: new Date().toISOString(),
      };
      await addLocalWhisperModel(LOCAL_WHISPER_INSTANCE_ID, entry);
      entryPersisted = true;
      persistedEntry = entry;

      this.state.activeDownloads.delete(modelId);
      logger.main.info("Model download persisted", {
        modelId,
        path: downloadPath,
        size: stats.size,
      });
    } catch (error) {
      this.state.activeDownloads.delete(modelId);
      // Only roll back the file if we never persisted the entry. Once the
      // row points at the file, the file must stay or the row is dangling
      // until next bootstrap reconciliation.
      if (!entryPersisted && fs.existsSync(downloadPath)) {
        fs.unlinkSync(downloadPath);
      }

      const err = error instanceof Error ? error : new Error(String(error));
      if (abortController.signal.aborted) {
        logger.main.info("Model download cancelled", { modelId });
        this.emit("download-cancelled", modelId);
        return;
      }
      logger.main.error("Model download failed", {
        modelId,
        error: err.message,
      });
      this.emit("download-error", modelId, err);
      throw err;
    }

    // Phase 2 — best-effort bookkeeping. Emit complete first so the UI
    // updates even if auto-select throws. Failures are logged, not
    // surfaced as download-error since the download itself succeeded.
    if (persistedEntry) {
      this.emit("download-complete", modelId, persistedEntry);
    }

    try {
      const downloaded = await this.getDownloadedModels();
      const currentSelection = await this.getSelectedModel();
      if (Object.keys(downloaded).length === 1 && !currentSelection) {
        await this.applySpeechModelSelection(
          modelId,
          "auto-first-download",
          null,
        );
        logger.main.info("Auto-selected first downloaded model", { modelId });
      }
    } catch (error) {
      logger.main.warn("Post-download auto-select failed; download is intact", {
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  cancelDownload(modelId: string): void {
    const download = this.state.activeDownloads.get(modelId);
    if (!download) {
      throw new Error(`No active download found for model: ${modelId}`);
    }
    download.status = "cancelling";
    download.abortController?.abort();
    this.state.activeDownloads.delete(modelId);
    logger.main.info("Cancelled model download", { modelId });
    this.emit("download-cancelled", modelId);
  }

  async deleteModel(modelId: string): Promise<void> {
    const downloaded = await this.getDownloadedModels();
    const entry = downloaded[modelId];
    if (!entry) throw new Error(`Model not found: ${modelId}`);

    const wasSelected = (await this.getSelectedModel()) === modelId;

    // Unlink the file first; if the unlink fails we still want to clean
    // up the row rather than leave a phantom entry pointing at a file
    // that fs.statSync would reject.
    const filePath = this.pathForEntry(entry);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        logger.main.info("Deleted model file", { modelId, path: filePath });
      } catch (error) {
        logger.main.warn("Failed to unlink model file; removing row anyway", {
          modelId,
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await removeLocalWhisperModel(LOCAL_WHISPER_INSTANCE_ID, modelId);

    if (wasSelected) {
      // Try to fall back to the next-best downloaded model.
      const remaining = await this.getDownloadedModels();
      let autoSelected = false;
      for (const candidate of PREFERRED_WHISPER_ORDER) {
        if (remaining[candidate]) {
          await this.applySpeechModelSelection(
            candidate,
            "auto-after-deletion",
            modelId,
          );
          autoSelected = true;
          logger.main.info("Auto-selected new model after deletion", {
            oldModel: modelId,
            newModel: candidate,
          });
          break;
        }
      }
      if (!autoSelected) {
        await this.applySpeechModelSelection(null, "cleared", modelId);
        logger.main.info(
          "No models available for auto-selection after deletion",
        );
      }
    }

    this.emit("model-deleted", modelId);
  }

  private async calculateFileChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha1");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (data) => hash.update(data));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  // ---------- Selection ----------

  /**
   * Returns the user's transcription default's model id IFF that default
   * points at the local-whisper instance. Other instance types managing
   * speech (Groq's Whisper, OpenAI Whisper-1) are out of scope here —
   * those run through the catalog/pipeline layer.
   */
  async getSelectedModel(): Promise<string | null> {
    const sel = await this.settingsService.getDefault("transcription");
    if (!sel) return null;
    if (sel.instanceId !== LOCAL_WHISPER_INSTANCE_ID) return null;
    return sel.modelId;
  }

  async setSelectedModel(modelId: string | null): Promise<void> {
    if (modelId !== null) {
      // Validate the model is known and downloaded.
      const known = AVAILABLE_MODELS.find((m) => m.id === modelId);
      if (!known) throw new Error(`Model not found: ${modelId}`);

      const downloaded = await this.getDownloadedModels();
      if (!downloaded[modelId]) {
        throw new Error(`Model not downloaded: ${modelId}`);
      }
    }

    const oldModelId = await this.getSelectedModel();
    await this.applySpeechModelSelection(modelId, "manual", oldModelId);
  }

  /**
   * Hot path. Called by WhisperProvider before every initializeModel call;
   * the worker short-circuits when the path is unchanged. Returns null if
   * nothing is downloaded so the caller can surface a clear "no model"
   * error rather than passing an invalid path to the worker.
   */
  async getBestAvailableModelPath(): Promise<string | null> {
    const downloaded = await this.getDownloadedModels();
    const selectedModelId = await this.getSelectedModel();

    if (selectedModelId && downloaded[selectedModelId]) {
      return this.pathForEntry(downloaded[selectedModelId]);
    }

    for (const candidate of PREFERRED_WHISPER_ORDER) {
      if (downloaded[candidate]) {
        return this.pathForEntry(downloaded[candidate]);
      }
    }
    return null;
  }

  // ---------- Lifecycle ----------

  cleanup(): void {
    logger.main.info("Cleaning up model downloads", {
      activeDownloads: this.state.activeDownloads.size,
    });
    for (const [modelId] of this.state.activeDownloads) {
      try {
        this.cancelDownload(modelId);
      } catch (error) {
        logger.main.warn("Error cancelling download during cleanup", {
          modelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ---------- Internals ----------

  private async readLocalWhisperConfig(): Promise<LocalWhisperConfig> {
    const row = await getInstanceById(LOCAL_WHISPER_INSTANCE_ID);
    if (!row || row.provider !== PROVIDER_TYPES.localWhisper) {
      logger.main.warn(
        "Local-whisper instance row missing or wrong provider; bootstrap should have seeded it",
      );
      return { downloadedModels: [] };
    }
    const config = row.config as LocalWhisperConfig;
    return { downloadedModels: config.downloadedModels ?? [] };
  }

  private async applySpeechModelSelection(
    modelId: string | null,
    reason:
      | "manual"
      | "auto-first-download"
      | "auto-after-deletion"
      | "cleared",
    oldModelId?: string | null,
  ): Promise<void> {
    const previousModelId = oldModelId ?? (await this.getSelectedModel());
    if (previousModelId === modelId) return;

    if (modelId === null) {
      await this.settingsService.clearDefault("transcription");
    } else {
      await this.settingsService.setDefault("transcription", {
        instanceId: LOCAL_WHISPER_INSTANCE_ID,
        modelId,
      });
    }

    this.emit("selection-changed", previousModelId, modelId, reason);
    logger.main.info("Speech model selection changed", {
      from: previousModelId,
      to: modelId,
      reason,
    });
  }

  /**
   * Drop the speech default if its model file is no longer downloaded.
   * Bootstrap reconciliation can have removed an entry between launches.
   */
  private async validateSpeechDefault(): Promise<void> {
    const selectedId = await this.getSelectedModel();
    if (!selectedId) return;
    const downloaded = await this.getDownloadedModels();
    if (downloaded[selectedId]) return;

    logger.main.info("Clearing invalid speech default", {
      modelId: selectedId,
    });
    await this.applySpeechModelSelection(null, "auto-after-deletion", selectedId);
  }

  /**
   * If the user has no speech default set but downloads exist, pick the
   * best one by preferred order so first-launch isn't a dead end.
   */
  private async maybeAutoSelectFirstDownloaded(): Promise<void> {
    if (await this.getSelectedModel()) return;
    const downloaded = await this.getDownloadedModels();
    if (Object.keys(downloaded).length === 0) return;

    for (const candidate of PREFERRED_WHISPER_ORDER) {
      if (downloaded[candidate]) {
        await this.applySpeechModelSelection(
          candidate,
          "auto-first-download",
          null,
        );
        logger.main.info("Auto-selected speech model on initialization", {
          modelId: candidate,
        });
        return;
      }
    }
  }
}

export { ModelService };
