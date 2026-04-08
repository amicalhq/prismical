import {
  TranscriptionProvider,
  TranscribeParams,
  TranscribeContext,
} from "../../core/pipeline-types";
import { logger } from "../../../main/logger";
import { ModelService } from "../../../services/model-service";
import { VADService } from "../../../services/vad-service";
import { SimpleForkWrapper } from "./simple-fork-wrapper";
import * as path from "path";
import { app } from "electron";
import { AppError, ErrorCodes } from "../../../types/error";
import { extractSpeechFromVad } from "../../utils/vad-audio-filter";
import { StreamingLinearResampler } from "../../utils/streaming-linear-resampler";

export class WhisperProvider implements TranscriptionProvider {
  readonly name = "whisper-local";

  private modelService: ModelService;
  private workerWrapper: SimpleForkWrapper | null = null;
  private vadService: VADService | null = null;
  private vadInitializationPromise: Promise<void> | null = null;
  private vadInitializationFailed = false;
  private loggedVadFallback = false;

  // Frame aggregation state
  private frameBuffer: Float32Array[] = [];
  private frameBufferSpeechProbabilities: number[] = [];
  private currentSilenceFrameCount = 0;
  private bufferedSpeechSamples = 0;
  private vadRemainder = new Float32Array(0);
  private inputResampler: StreamingLinearResampler | null = null;
  private inputSampleRate: number | null = null;

  private getNodeBinaryPath(): string {
    const platform = process.platform;
    const arch = process.arch;
    const binaryName = platform === "win32" ? "node.exe" : "node";

    if (app.isPackaged) {
      // In production, use the binary from resources
      return path.join(process.resourcesPath, binaryName);
    } else {
      // In development, use the local binary
      return path.join(
        __dirname,
        "../../node-binaries",
        `${platform}-${arch}`,
        binaryName,
      );
    }
  }

  // Configuration
  private readonly FRAME_SIZE = 512; // 32ms at 16kHz
  private readonly MIN_AUDIO_DURATION_MS = 500; // Minimum buffered audio duration before silence-based transcription
  private readonly MAX_SILENCE_DURATION_MS = 1500; // Max silence before cutting
  private readonly MAX_BUFFER_DURATION_MS = 7000; // Force a flush even without silence so meetings feel responsive
  private readonly SAMPLE_RATE = 16000;
  private readonly SPEECH_PROBABILITY_THRESHOLD = 0.4; // Threshold for speech detection

  constructor(modelService: ModelService) {
    this.modelService = modelService;
  }

  /**
   * Preload the Whisper model into memory
   */
  async preloadModel(): Promise<void> {
    await this.initializeWhisper();
  }

  async getBindingInfo(): Promise<{ path: string; type: string } | null> {
    if (!this.workerWrapper) {
      return null;
    }
    try {
      return await this.workerWrapper.exec<{
        path: string;
        type: string;
      } | null>("getBindingInfo", []);
    } catch (error) {
      logger.transcription.warn("Failed to get binding info:", error);
      return null;
    }
  }

  /**
   * Process an audio chunk - buffers and conditionally transcribes
   */
  async transcribe(params: TranscribeParams): Promise<string> {
    await this.initializeWhisper();

    const { audioData, sampleRate, speechProbability = 1, context } = params;
    const normalizedAudio = this.normalizeToWhisperRate(audioData, sampleRate);
    if (normalizedAudio.length === 0) {
      return "";
    }

    // Buffer raw audio immediately. VAD probabilities are generated against
    // re-framed 512-sample windows so arbitrary native chunk sizes still map
    // cleanly onto the frame-based silence and extraction logic.
    this.frameBuffer.push(normalizedAudio);
    const vadProbabilities = await this.processChunkThroughVad(
      normalizedAudio,
      speechProbability,
    );
    this.frameBufferSpeechProbabilities.push(...vadProbabilities);
    this.bufferedSpeechSamples += vadProbabilities.length * this.FRAME_SIZE;

    for (const probability of vadProbabilities) {
      if (probability > this.SPEECH_PROBABILITY_THRESHOLD) {
        this.currentSilenceFrameCount = 0;
      } else {
        this.currentSilenceFrameCount++;
      }
    }

    const latestProbability =
      vadProbabilities.length > 0
        ? vadProbabilities[vadProbabilities.length - 1]
        : speechProbability;

    logger.transcription.debug("Frame received", {
      speechProbability: latestProbability.toFixed(3),
      generatedVadFrames: vadProbabilities.length,
      bufferSize: this.frameBuffer.length,
      bufferedSpeechSamples: this.bufferedSpeechSamples,
      silenceCount: this.currentSilenceFrameCount,
      vadRemainderSamples: this.vadRemainder.length,
    });

    // Only transcribe if speech/silence patterns indicate we should
    if (!this.shouldTranscribe()) {
      return "";
    }

    return this.doTranscription(context);
  }

  /**
   * Flush any buffered audio and return transcription
   * Called at the end of a recording session
   */
  async flush(context: TranscribeContext): Promise<string> {
    if (this.frameBuffer.length === 0) {
      const flushedResamplerAudio = this.flushResampler();
      if (flushedResamplerAudio.length === 0) {
        return "";
      }

      this.frameBuffer.push(flushedResamplerAudio);
      const vadProbabilities = await this.processChunkThroughVad(
        flushedResamplerAudio,
        1,
      );
      this.frameBufferSpeechProbabilities.push(...vadProbabilities);
      this.bufferedSpeechSamples += vadProbabilities.length * this.FRAME_SIZE;
    }

    await this.initializeWhisper();
    const flushedResamplerAudio = this.flushResampler();
    if (flushedResamplerAudio.length > 0) {
      this.frameBuffer.push(flushedResamplerAudio);
      const vadProbabilities = await this.processChunkThroughVad(
        flushedResamplerAudio,
        1,
      );
      this.frameBufferSpeechProbabilities.push(...vadProbabilities);
      this.bufferedSpeechSamples += vadProbabilities.length * this.FRAME_SIZE;
    }
    await this.flushVadRemainder();
    return this.doTranscription(context);
  }

  /**
   * Shared transcription logic - aggregates buffer, calls whisper, clears state
   * Assumes initializeWhisper() was already called by caller
   */
  private async doTranscription(context: TranscribeContext): Promise<string> {
    try {
      const { aggregatedTranscription, language } = context;

      // Capture speech probabilities before reset
      const vadProbs = [...this.frameBufferSpeechProbabilities];

      // Aggregate buffered frames
      const rawAudio = this.aggregateFrames();

      const transcribableLength =
        vadProbs.length === 0
          ? rawAudio.length
          : Math.min(this.bufferedSpeechSamples, rawAudio.length);
      const transcribableAudio =
        transcribableLength > 0
          ? rawAudio.subarray(0, transcribableLength)
          : rawAudio;
      const unprocessedTail =
        transcribableLength < rawAudio.length
          ? rawAudio.slice(transcribableLength)
          : new Float32Array(0);

      // Clear only the buffered audio state so Silero state survives across
      // in-session chunk flushes. Full reset happens on session boundaries.
      this.clearBufferedAudioState(unprocessedTail);

      const shouldBypassVad =
        vadProbs.length === 0 ||
        vadProbs.every((probability) => probability >= 1);

      const { audio: speechOnlyAudio, segments: speechSegments } =
        shouldBypassVad
          ? {
              audio: transcribableAudio,
              segments:
                transcribableAudio.length > 0
                  ? [{ start: 0, end: Math.max(0, vadProbs.length - 1) }]
                  : [],
            }
          : extractSpeechFromVad(transcribableAudio, vadProbs);

      if (speechOnlyAudio.length === 0) {
        logger.transcription.debug(
          "Skipping transcription - no speech detected by VAD filter",
        );
        return "";
      }

      logger.transcription.debug(
        `VAD filtered: ${transcribableAudio.length} → ${speechOnlyAudio.length} samples (${speechSegments.length} speech segments, ${((speechOnlyAudio.length / transcribableAudio.length) * 100).toFixed(0)}% kept)`,
      );

      logger.transcription.debug(
        `Starting transcription of ${speechOnlyAudio.length} samples (${((speechOnlyAudio.length / this.SAMPLE_RATE) * 1000).toFixed(0)}ms)`,
      );

      if (!this.workerWrapper) {
        throw new AppError(
          "Worker wrapper is not initialized",
          ErrorCodes.WORKER_INITIALIZATION_FAILED,
        );
      }

      // Generate initial prompt from recent context only (align with cloud)
      const initialPrompt = this.generateInitialPrompt(
        aggregatedTranscription,
        context.accessibilityContext,
      );

      const text = await this.workerWrapper.exec<string>("transcribeAudio", [
        speechOnlyAudio,
        {
          language: language || "auto",
          initial_prompt: initialPrompt,
          suppress_blank: true,
          suppress_non_speech_tokens: true,
          no_timestamps: false,
        },
      ]);

      logger.transcription.debug(
        `Transcription completed, length: ${text.length}`,
      );

      return text;
    } catch (error) {
      logger.transcription.error("Transcription failed:", error);
      // Re-throw AppError as-is, wrap other errors
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        `Whisper transcription failed: ${error instanceof Error ? error.message : error}`,
        ErrorCodes.LOCAL_TRANSCRIPTION_FAILED,
      );
    }
  }

  /**
   * Clear internal buffers without transcribing
   * Called when cancelling a session to prevent audio bleed
   */
  reset(): void {
    this.clearBufferedAudioState();
    this.inputResampler?.reset();
    this.inputResampler = null;
    this.inputSampleRate = null;
    this.vadService?.reset();
  }

  private clearBufferedAudioState(remainder = new Float32Array(0)): void {
    this.frameBuffer = remainder.length > 0 ? [remainder] : [];
    this.frameBufferSpeechProbabilities = [];
    this.currentSilenceFrameCount = 0;
    this.bufferedSpeechSamples = 0;
    this.vadRemainder = remainder;
  }

  private shouldTranscribe(): boolean {
    // Transcribe if:
    // 1. We have enough buffered audio and significant silence after speech
    // 2. Buffer is getting too large

    const audioDurationMs =
      (this.bufferedSpeechSamples / this.SAMPLE_RATE) * 1000;
    const silenceDurationMs =
      ((this.currentSilenceFrameCount * this.FRAME_SIZE) / this.SAMPLE_RATE) *
      1000;

    // If we have enough buffered audio and then significant silence, transcribe
    if (
      audioDurationMs >= this.MIN_AUDIO_DURATION_MS &&
      silenceDurationMs > this.MAX_SILENCE_DURATION_MS
    ) {
      logger.transcription.debug(
        `Transcribing due to ${silenceDurationMs}ms of silence`,
      );
      return true;
    }

    // If buffer is too large, transcribe anyway even without silence.
    // This keeps meeting transcription responsive during long uninterrupted speech.
    if (audioDurationMs > this.MAX_BUFFER_DURATION_MS) {
      logger.transcription.debug(
        `Transcribing due to buffer size: ${audioDurationMs}ms`,
      );
      return true;
    }

    logger.transcription.debug("Not transcribing", {
      audioDurationMs,
      silenceDurationMs,
      frameBufferLength: this.frameBuffer.length,
      bufferedSpeechSamples: this.bufferedSpeechSamples,
      silenceFrameCount: this.currentSilenceFrameCount,
    });

    return false;
  }

  private aggregateFrames(): Float32Array {
    const totalLength = this.frameBuffer.reduce(
      (sum, frame) => sum + frame.length,
      0,
    );
    const aggregated = new Float32Array(totalLength);

    let offset = 0;
    for (const frame of this.frameBuffer) {
      aggregated.set(frame, offset);
      offset += frame.length;
    }

    return aggregated;
  }

  private async processChunkThroughVad(
    audioData: Float32Array,
    fallbackProbability: number,
  ): Promise<number[]> {
    if (audioData.length === 0) {
      return [];
    }

    const vadService = await this.getVadService();
    if (!vadService) {
      return [];
    }

    const combined = this.concatFloat32(this.vadRemainder, audioData);
    const probabilities: number[] = [];
    let offset = 0;

    while (offset + this.FRAME_SIZE <= combined.length) {
      const frame = combined.subarray(offset, offset + this.FRAME_SIZE);
      const result = await vadService.processAudioFrame(frame);
      probabilities.push(result.probability);
      offset += this.FRAME_SIZE;
    }

    this.vadRemainder = combined.slice(offset);

    if (!probabilities.length && !this.loggedVadFallback) {
      logger.transcription.debug("Awaiting more audio for full VAD frame", {
        remainderSamples: this.vadRemainder.length,
        fallbackProbability,
      });
    }

    return probabilities;
  }

  private async flushVadRemainder(): Promise<void> {
    const vadService = await this.getVadService();
    if (!vadService || this.vadRemainder.length === 0) {
      return;
    }

    const result = await vadService.processAudioFrame(this.vadRemainder);
    this.frameBufferSpeechProbabilities.push(result.probability);
    this.bufferedSpeechSamples += this.vadRemainder.length;

    if (result.probability > this.SPEECH_PROBABILITY_THRESHOLD) {
      this.currentSilenceFrameCount = 0;
    } else {
      this.currentSilenceFrameCount++;
    }

    this.vadRemainder = new Float32Array(0);
  }

  private normalizeToWhisperRate(
    audioData: Float32Array,
    sampleRate: number,
  ): Float32Array {
    if (audioData.length === 0) {
      return new Float32Array(0);
    }

    if (sampleRate === this.SAMPLE_RATE) {
      return audioData;
    }

    if (this.inputSampleRate !== sampleRate || !this.inputResampler) {
      if (
        this.inputSampleRate !== null &&
        this.inputSampleRate !== sampleRate
      ) {
        logger.transcription.warn(
          "Whisper input sample rate changed mid-session; resetting provider resampler",
          {
            previousSampleRate: this.inputSampleRate,
            nextSampleRate: sampleRate,
          },
        );
      }

      this.inputSampleRate = sampleRate;
      this.inputResampler = new StreamingLinearResampler(
        sampleRate,
        this.SAMPLE_RATE,
      );
    }

    return this.inputResampler.process(audioData);
  }

  private flushResampler(): Float32Array {
    if (!this.inputResampler) {
      return new Float32Array(0);
    }

    return this.inputResampler.flush();
  }

  private async getVadService(): Promise<VADService | null> {
    if (this.vadService) {
      return this.vadService;
    }

    if (this.vadInitializationFailed) {
      return null;
    }

    if (this.vadInitializationPromise) {
      await this.vadInitializationPromise;
      return this.vadService;
    }

    this.vadInitializationPromise = (async () => {
      try {
        const vadService = new VADService();
        await vadService.initialize();
        this.vadService = vadService;
      } catch (error) {
        this.vadInitializationFailed = true;
        if (!this.loggedVadFallback) {
          logger.transcription.warn(
            "Whisper VAD unavailable; falling back to full-audio transcription",
            error,
          );
          this.loggedVadFallback = true;
        }
      } finally {
        this.vadInitializationPromise = null;
      }
    })();

    await this.vadInitializationPromise;
    return this.vadService;
  }

  private concatFloat32(left: Float32Array, right: Float32Array): Float32Array {
    if (left.length === 0) {
      return right.slice();
    }

    const output = new Float32Array(left.length + right.length);
    output.set(left, 0);
    output.set(right, left.length);
    return output;
  }

  private generateInitialPrompt(
    aggregatedTranscription?: string,
    accessibilityContext?: TranscribeContext["accessibilityContext"],
  ): string {
    if (aggregatedTranscription) {
      // Pass full transcription - whisper.cpp auto-truncates to last ~224 tokens
      logger.transcription.debug(
        `Generated initial prompt from aggregated transcription: "${aggregatedTranscription}"`,
      );
      return aggregatedTranscription;
    }

    const beforeText =
      accessibilityContext?.context?.textSelection?.preSelectionText;
    if (beforeText && beforeText.trim().length > 0) {
      logger.transcription.debug(
        `Generated initial prompt from before text: "${beforeText}"`,
      );
      return beforeText;
    }

    logger.transcription.debug("Generated initial prompt: empty");
    return "";
  }

  async initializeWhisper(): Promise<void> {
    if (!this.workerWrapper) {
      // Determine the correct path for the worker script
      const workerPath = app.isPackaged
        ? path.join(__dirname, "whisper-worker-fork.js") // In production, same directory as main.js
        : path.join(process.cwd(), ".vite/build/whisper-worker-fork.js"); // In development

      logger.transcription.info(
        `Initializing Whisper worker at: ${workerPath}`,
      );

      this.workerWrapper = new SimpleForkWrapper(
        workerPath,
        this.getNodeBinaryPath(),
      );

      await this.workerWrapper.initialize();
    }

    const modelPath = await this.modelService.getBestAvailableModelPath();
    if (!modelPath) {
      throw new AppError(
        "No Whisper models available. Please download a model first.",
        ErrorCodes.MODEL_MISSING,
      );
    }

    try {
      await this.workerWrapper.exec("initializeModel", [modelPath]);
    } catch (error) {
      logger.transcription.error(`Failed to initialize:`, error);
      // Re-throw AppError as-is, wrap other errors
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        `Whisper model initialization failed: ${error instanceof Error ? error.message : error}`,
        ErrorCodes.WORKER_INITIALIZATION_FAILED,
      );
    }
  }

  // Simple cleanup method
  async dispose(): Promise<void> {
    if (this.workerWrapper) {
      try {
        await this.workerWrapper.exec("dispose", []);
        await this.workerWrapper.terminate(); // Terminate the worker
        logger.transcription.debug("Worker terminated");
      } catch (error) {
        logger.transcription.warn("Error disposing worker:", error);
      } finally {
        this.workerWrapper = null;
      }
    }

    if (this.vadService) {
      await this.vadService.dispose();
      this.vadService = null;
    }

    this.vadInitializationPromise = null;
    this.vadInitializationFailed = false;
    this.reset();
  }
}
