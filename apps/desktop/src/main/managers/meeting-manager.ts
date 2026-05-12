import { app } from "electron";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuid } from "uuid";
import { logger } from "../logger";
import type { ModelService } from "@/services/model-service";
import {
  createMeeting,
  createMeetingArtifacts,
  createTranscriptSegments,
  updateMeeting,
} from "@/db/meetings";
import { StreamingWavWriter } from "@/utils/streaming-wav-writer";
import { NativeAudioCaptureClient } from "../meetings/native-audio-capture-client";
import { ReferenceEchoCanceller } from "../meetings/reference-echo-canceller";
import { MeetingTraceWriter } from "../meetings/meeting-trace-writer";
import {
  MeetingTranscriptionService,
  type MeetingSourceTranscriptionRuntime,
  type MeetingTranscriptionChunk,
} from "../meetings/meeting-transcription-service";
import type { MeetingTranscriptionSelection } from "../meetings/meeting-transcription-provider-registry";
import type {
  AudioFrame,
  AudioSource,
  CapturedAudioSource,
  MeetingCaptureMode,
  MeetingRuntimeSnapshot,
  MeetingRuntimeState,
  TranscriptEvent,
  TranscriptSpeaker,
} from "@/types/meeting";

interface MeetingManagerEvents {
  "state-changed": (snapshot: MeetingRuntimeSnapshot) => void;
  "transcript-event": (event: TranscriptEvent) => void;
  level: (levels: { mic?: number; system?: number }) => void;
  error: (error: Error) => void;
}

const SOURCE_TO_SPEAKER: Record<AudioSource, TranscriptSpeaker> = {
  mic: "you",
  system: "them",
};

type MeetingArtifactSource = "mic_raw" | "mic_processed" | "system";

const ARTIFACT_TYPE_BY_SOURCE: Record<
  MeetingArtifactSource,
  "mic_wav" | "mic_processed_wav" | "system_wav"
> = {
  mic_raw: "mic_wav",
  mic_processed: "mic_processed_wav",
  system: "system_wav",
};

const parseAecRenderHoldbackMs = (): number => {
  const rawValue = process.env.PRISMICAL_AEC_RENDER_HOLDBACK_MS;
  if (rawValue == null || rawValue.trim() === "") {
    return 300;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : 300;
};

const AEC_RENDER_HOLDBACK_MS = parseAecRenderHoldbackMs();
const parseAecRenderWaitTimeoutMs = (fallbackMs: number): number => {
  const rawValue = process.env.PRISMICAL_AEC_RENDER_WAIT_TIMEOUT_MS;
  if (rawValue == null || rawValue.trim() === "") {
    return fallbackMs;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? parsedValue
    : fallbackMs;
};
const AEC_RENDER_WAIT_TIMEOUT_MS = parseAecRenderWaitTimeoutMs(
  AEC_RENDER_HOLDBACK_MS,
);

export class MeetingManager extends EventEmitter {
  private state: MeetingRuntimeState = "idle";
  private mode: MeetingCaptureMode | null = null;
  private activeMeetingId: string | null = null;
  private activeNoteId: number | null = null;
  private startedAtEpochMs: number | null = null;
  private captureClient: NativeAudioCaptureClient | null = null;
  private transcriptionService: MeetingTranscriptionService;
  private writers: Partial<Record<MeetingArtifactSource, StreamingWavWriter>> =
    {};
  private transcriptionRuntimes: Partial<
    Record<AudioSource, MeetingSourceTranscriptionRuntime>
  > = {};
  private transcriptionChains: Record<AudioSource, Promise<void>> = {
    mic: Promise.resolve(),
    system: Promise.resolve(),
  };
  private levels: { mic?: number; system?: number } = {};
  private lastTranscript: TranscriptEvent[] = [];
  private frameWriteChain: Promise<void> = Promise.resolve();
  private nextSegmentOrder = 0;
  private activeTranscriptionSelection: MeetingTranscriptionSelection | null =
    null;
  private echoCanceller: ReferenceEchoCanceller | null = null;
  private hasNativeProcessedMicFrames = false;
  private nativeEchoCancellationMode: string | null = null;
  private traceWriter: MeetingTraceWriter | null = null;
  private traceDirectory: string | null = null;
  private artifactNextSampleIndex: Partial<
    Record<MeetingArtifactSource, number>
  > = {};
  private transcriptionNextSampleIndex: Partial<Record<AudioSource, number>> =
    {};

  constructor(modelService: ModelService) {
    super();
    this.transcriptionService = new MeetingTranscriptionService(modelService);
  }

  on<U extends keyof MeetingManagerEvents>(
    event: U,
    listener: MeetingManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }

  off<U extends keyof MeetingManagerEvents>(
    event: U,
    listener: MeetingManagerEvents[U],
  ): this {
    return super.off(event, listener);
  }

  emit<U extends keyof MeetingManagerEvents>(
    event: U,
    ...args: Parameters<MeetingManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getState(): MeetingRuntimeSnapshot {
    return {
      state: this.state,
      mode: this.mode,
      meetingId: this.activeMeetingId,
      noteId: this.activeNoteId,
      startedAt: this.startedAtEpochMs,
      durationMs:
        this.startedAtEpochMs === null ? 0 : Date.now() - this.startedAtEpochMs,
    };
  }

  getLastTranscript(): TranscriptEvent[] {
    return [...this.lastTranscript];
  }

  async start(
    noteId: number,
    mode: MeetingCaptureMode = "dual",
  ): Promise<{ meetingId: string }> {
    if (this.state !== "idle") {
      throw new Error("A meeting capture session is already active.");
    }

    const meetingId = uuid();
    const startedAt = new Date();
    const artifactsDir = path.join(
      app.getPath("userData"),
      "meetings",
      meetingId,
    );
    const traceDirectory = path.join(artifactsDir, "trace");
    await fs.promises.mkdir(artifactsDir, { recursive: true });

    await createMeeting({
      id: meetingId,
      noteId,
      title: buildMeetingTitle(startedAt),
      startedAt,
      captureMode: mode,
      state: "recording",
      metadata: {
        sourceLayout: "merged",
        rawAudioRetained: true,
      },
    });

    this.activeMeetingId = meetingId;
    this.activeNoteId = noteId;
    this.mode = mode;
    this.startedAtEpochMs = startedAt.getTime();
    this.lastTranscript = [];
    this.levels = {};
    this.writers = {};
    this.transcriptionRuntimes = {};
    this.transcriptionChains = {
      mic: Promise.resolve(),
      system: Promise.resolve(),
    };
    this.nextSegmentOrder = 0;
    this.activeTranscriptionSelection = null;
    this.echoCanceller = mode === "dual" ? new ReferenceEchoCanceller() : null;
    this.hasNativeProcessedMicFrames = false;
    this.nativeEchoCancellationMode = null;
    this.artifactNextSampleIndex = {};
    this.transcriptionNextSampleIndex = {};
    this.traceWriter = new MeetingTraceWriter(traceDirectory);
    this.traceDirectory = traceDirectory;
    await this.traceWriter.recordEvent("meeting_start", {
      meetingId,
      noteId,
      mode,
      artifactsDir,
      traceDirectory,
    });
    logger.audio.info("Meeting trace files", {
      meetingId,
      traceDirectory,
      appTracePath: this.traceWriter.getTraceJsonlPath(),
      transcriptionMicPath:
        this.traceWriter.getTraceAudioPath("transcription-mic"),
      transcriptionSystemPath: this.traceWriter.getTraceAudioPath(
        "transcription-system",
      ),
      appFrameMicProcessedPath: this.traceWriter.getTraceAudioPath(
        "app-frame-mic_processed",
      ),
      appFrameSystemPath:
        this.traceWriter.getTraceAudioPath("app-frame-system"),
    });

    if (mode === "mic" || mode === "dual") {
      this.writers.mic_raw = new StreamingWavWriter(
        path.join(artifactsDir, "mic.wav"),
        48_000,
      );
    }

    if (mode === "system" || mode === "dual") {
      this.writers.system = new StreamingWavWriter(
        path.join(artifactsDir, "system.wav"),
        48_000,
      );
    }

    if (mode === "dual") {
      this.writers.mic_processed = new StreamingWavWriter(
        path.join(artifactsDir, "mic_processed.wav"),
        48_000,
      );
    }

    for (const source of orderedSourcesForMode(mode)) {
      const runtime = await this.transcriptionService.createSourceRuntime({
        meetingId,
        source,
        speaker: SOURCE_TO_SPEAKER[source],
      });
      this.transcriptionRuntimes[source] = runtime;
      if (!this.activeTranscriptionSelection) {
        this.activeTranscriptionSelection = runtime.getMetadata();
      }
    }

    this.captureClient = new NativeAudioCaptureClient();
    this.captureClient.on("frame", this.handleFrame);
    this.captureClient.on("aec-mode", this.handleNativeAecMode);
    this.captureClient.on("error", this.handleCaptureError);
    this.captureClient.on("exit", this.handleCaptureExit);

    this.setState("starting");
    try {
      await this.captureClient.start(mode, {
        debugArtifactsDir: artifactsDir,
        aecRenderHoldbackMs: AEC_RENDER_HOLDBACK_MS,
        aecRenderWaitTimeoutMs: AEC_RENDER_WAIT_TIMEOUT_MS,
      });
      this.setState("recording");
      logger.audio.info("Meeting capture started", { meetingId, mode });
      return {
        meetingId,
      };
    } catch (error) {
      await this.traceWriter?.recordEvent("meeting_start_failed", {
        meetingId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.traceWriter?.close();
      await updateMeeting(meetingId, {
        state: "failed",
        endedAt: new Date(),
      });
      await this.abortArtifacts();
      await this.disposeTranscriptionRuntimes();
      this.resetRuntime();
      throw error;
    }
  }

  async stop(): Promise<{ meetingId: string; transcriptSegmentCount: number }> {
    if (
      this.state !== "recording" &&
      this.state !== "starting" &&
      this.state !== "error"
    ) {
      throw new Error("No active meeting capture session to stop.");
    }

    const meetingId = this.activeMeetingId;
    const noteId = this.activeNoteId;
    if (!meetingId) {
      throw new Error("Active meeting ID is missing.");
    }
    if (noteId === null) {
      throw new Error("Active note ID is missing.");
    }

    this.setState("stopping");

    try {
      await this.captureClient?.stop();
      await this.frameWriteChain;
      await this.finalizeArtifacts();
      await Promise.all(Object.values(this.transcriptionChains));
      await this.flushTranscriptionRuntimes();
      await this.traceWriter?.recordEvent("meeting_stop_completed", {
        meetingId,
        transcriptSegmentCount: this.lastTranscript.length,
        echoCancellation: this.resolveEchoCancellationMetadata(),
      });
      await this.traceWriter?.close();
      await this.persistArtifacts(meetingId);
      await updateMeeting(meetingId, {
        state: "completed",
        endedAt: new Date(),
        durationMs: this.getState().durationMs,
        transcriptionModel:
          this.activeTranscriptionSelection?.modelName ?? null,
        metadata: {
          sourceLayout: "merged",
          rawAudioRetained: true,
          echoCancellation: this.resolveEchoCancellationMetadata(),
          transcriptSegmentCount: this.lastTranscript.length,
          transcriptionProvider:
            this.activeTranscriptionSelection?.providerType ?? null,
        },
      });

      logger.audio.info("Meeting capture finalized", {
        meetingId,
        transcriptSegmentCount: this.lastTranscript.length,
      });

      await this.disposeTranscriptionRuntimes();
      this.resetRuntime();

      return {
        meetingId,
        transcriptSegmentCount: this.lastTranscript.length,
      };
    } catch (error) {
      logger.audio.error("Meeting capture finalization failed", error);
      await this.traceWriter?.recordEvent("meeting_stop_failed", {
        meetingId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.traceWriter?.close();
      await updateMeeting(meetingId, {
        state: "failed",
        endedAt: new Date(),
        durationMs: this.getState().durationMs,
        metadata: {
          sourceLayout: "merged",
          rawAudioRetained: true,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
      await this.disposeTranscriptionRuntimes();
      this.resetRuntime();
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (this.state !== "idle") {
      try {
        await this.captureClient?.stop();
      } catch (error) {
        logger.audio.warn("Failed to stop capture client during cleanup", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await this.abortArtifacts();
      await this.traceWriter?.recordEvent("meeting_cleanup_abort", {
        state: this.state,
      });
      await this.traceWriter?.close();
      await this.disposeTranscriptionRuntimes();
      this.resetRuntime();
    }

    await this.disposeTranscriptionRuntimes();
  }

  private handleFrame = (frame: AudioFrame): void => {
    const frameReceivedAtEpochMs = Date.now();
    if (frame.source === "mic_processed") {
      this.hasNativeProcessedMicFrames = true;
    }

    const artifactSource = this.resolveArtifactSource(frame.source);
    const levelUpdate = this.resolveLevelUpdate(frame);
    const transcriptionRouting = this.resolveTranscriptionRouting(frame);

    this.frameWriteChain = this.frameWriteChain
      .then(async () => {
        await this.traceWriter?.recordAudioEvent(
          "native_frame_received",
          `app-frame-${frame.source}`,
          frame.samples,
          {
            source: frame.source,
            timestampMs: frame.timestampMs,
            sampleStartIndex: frame.sampleStartIndex,
            durationMs: frame.durationMs,
            sequenceNum: frame.sequenceNum,
            sampleRate: frame.sampleRate,
            channels: frame.channels,
            sampleCount: frame.samples.length,
            frameReceivedAtEpochMs,
          },
        );

        const writer = artifactSource ? this.writers[artifactSource] : null;
        if (artifactSource && writer) {
          const resolvedArtifactSource: MeetingArtifactSource = artifactSource;
          const scheduledFrames = this.expandFrameForTimeline(
            resolvedArtifactSource,
            frame,
            this.artifactNextSampleIndex,
          );
          for (const scheduledFrame of scheduledFrames) {
            const byteOffset = writer.getDataSize();
            if (scheduledFrame.isSyntheticSilence) {
              await writer.appendSilence(scheduledFrame.frame.samples.length);
            } else {
              await writer.appendAudio(scheduledFrame.frame.samples);
            }

            await this.traceWriter?.recordEvent("artifact_frame_appended", {
              source: resolvedArtifactSource,
              wavPath: writer.getFilePath(),
              timestampMs: scheduledFrame.frame.timestampMs,
              sampleStartIndex: scheduledFrame.frame.sampleStartIndex,
              durationMs: scheduledFrame.frame.durationMs,
              sequenceNum: scheduledFrame.frame.sequenceNum,
              sampleCount: scheduledFrame.frame.samples.length,
              isSyntheticSilence: scheduledFrame.isSyntheticSilence,
              int16ByteOffset: byteOffset,
              int16SampleOffset: Math.floor(byteOffset / 2),
            });
          }
        }

        if (levelUpdate) {
          this.levels[levelUpdate.source] = normalizeLevel(levelUpdate.samples);
          this.emit("level", { ...this.levels });
        }
      })
      .catch((error) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        logger.audio.error("Failed to persist meeting frame", normalizedError);
        this.emit("error", normalizedError);
      });

    if (!transcriptionRouting) {
      return;
    }

    const runtime = this.transcriptionRuntimes[transcriptionRouting.source];
    if (!runtime) {
      return;
    }

    this.transcriptionChains[transcriptionRouting.source] =
      this.transcriptionChains[transcriptionRouting.source]
        .then(async () => {
          const scheduledFrames = this.expandFrameForTimeline(
            transcriptionRouting.source,
            transcriptionRouting.frame,
            this.transcriptionNextSampleIndex,
          );
          for (const scheduledFrame of scheduledFrames) {
            await this.traceWriter?.recordAudioEvent(
              "transcription_frame_ingest",
              `transcription-${transcriptionRouting.source}`,
              scheduledFrame.frame.samples,
              {
                source: transcriptionRouting.source,
                frameSource: scheduledFrame.frame.source,
                timestampMs: scheduledFrame.frame.timestampMs,
                sampleStartIndex: scheduledFrame.frame.sampleStartIndex,
                durationMs: scheduledFrame.frame.durationMs,
                sequenceNum: scheduledFrame.frame.sequenceNum,
                sampleRate: scheduledFrame.frame.sampleRate,
                channels: scheduledFrame.frame.channels,
                sampleCount: scheduledFrame.frame.samples.length,
                isSyntheticSilence: scheduledFrame.isSyntheticSilence,
              },
            );
            const chunks = await runtime.ingestFrame(scheduledFrame.frame);
            await this.traceWriter?.recordEvent("transcription_frame_result", {
              source: transcriptionRouting.source,
              frameSource: scheduledFrame.frame.source,
              sequenceNum: scheduledFrame.frame.sequenceNum,
              sampleStartIndex: scheduledFrame.frame.sampleStartIndex,
              isSyntheticSilence: scheduledFrame.isSyntheticSilence,
              emittedChunkCount: chunks.length,
              emittedTextPreview:
                chunks.length > 0
                  ? chunks
                      .map((chunk) => chunk.text)
                      .join(" | ")
                      .slice(0, 240)
                  : null,
            });
            await this.persistTranscriptionChunks(chunks);
          }
        })
        .catch((error) => {
          const normalizedError =
            error instanceof Error ? error : new Error(String(error));
          logger.audio.error(
            "Failed to transcribe meeting frame",
            normalizedError,
          );
          this.setState("error");
          this.emit("error", normalizedError);
        });
  };

  private resolveArtifactSource(
    source: CapturedAudioSource,
  ): MeetingArtifactSource | null {
    switch (source) {
      case "mic_raw":
        return "mic_raw";
      case "mic_processed":
        return "mic_processed";
      case "system":
        return "system";
      default:
        return null;
    }
  }

  private resolveLevelUpdate(
    frame: AudioFrame,
  ): { source: AudioSource; samples: Float32Array } | null {
    if (frame.source === "system") {
      return { source: "system", samples: frame.samples };
    }

    if (frame.source === "mic_processed") {
      return { source: "mic", samples: frame.samples };
    }

    return this.hasNativeProcessedMicFrames
      ? null
      : { source: "mic", samples: frame.samples };
  }

  private resolveTranscriptionRouting(
    frame: AudioFrame,
  ): { source: AudioSource; frame: AudioFrame } | null {
    if (frame.source === "system") {
      if (!this.hasNativeProcessedMicFrames) {
        this.echoCanceller?.ingestReferenceFrame(frame.samples);
      }

      return {
        source: "system",
        frame,
      };
    }

    if (frame.source === "mic_processed") {
      return {
        source: "mic",
        frame,
      };
    }

    if (this.hasNativeProcessedMicFrames) {
      return null;
    }

    return {
      source: "mic",
      frame: this.prepareFallbackMicFrame(frame),
    };
  }

  private prepareFallbackMicFrame(frame: AudioFrame): AudioFrame {
    if (!this.echoCanceller) {
      return {
        ...frame,
        source: "mic_processed",
      };
    }

    return {
      ...frame,
      source: "mic_processed",
      samples: this.echoCanceller.processCaptureFrame(frame.samples),
    };
  }

  private resolveEchoCancellationMetadata(): string | null {
    if (this.hasNativeProcessedMicFrames) {
      return this.nativeEchoCancellationMode ?? "native-helper-processed";
    }

    return this.mode === "dual" ? "reference-reducer-v1" : null;
  }

  private handleNativeAecMode = (mode: string): void => {
    this.nativeEchoCancellationMode = mode;
  };

  private expandFrameForTimeline<K extends string>(
    key: K,
    frame: AudioFrame,
    nextSampleIndexMap: Partial<Record<K, number>>,
  ): Array<{ frame: AudioFrame; isSyntheticSilence: boolean }> {
    const scheduledFrames: Array<{
      frame: AudioFrame;
      isSyntheticSilence: boolean;
    }> = [];
    const expectedSampleIndex = nextSampleIndexMap[key];

    if (
      Number.isFinite(expectedSampleIndex) &&
      frame.sampleStartIndex > (expectedSampleIndex ?? 0)
    ) {
      const gapSampleCount =
        frame.sampleStartIndex - (expectedSampleIndex ?? 0);
      scheduledFrames.push({
        frame: this.makeSyntheticSilenceFrame(
          frame,
          expectedSampleIndex ?? 0,
          gapSampleCount,
        ),
        isSyntheticSilence: true,
      });
    }

    scheduledFrames.push({
      frame,
      isSyntheticSilence: false,
    });

    const frameEndSampleIndex = frame.sampleStartIndex + frame.samples.length;
    nextSampleIndexMap[key] = Math.max(
      expectedSampleIndex ?? frame.sampleStartIndex,
      frameEndSampleIndex,
    );

    return scheduledFrames;
  }

  private makeSyntheticSilenceFrame(
    template: AudioFrame,
    sampleStartIndex: number,
    sampleCount: number,
  ): AudioFrame {
    const durationMs = Math.round((sampleCount / template.sampleRate) * 1000);
    return {
      ...template,
      samples: new Float32Array(sampleCount),
      timestampMs: sampleIndexToTimestampMs(
        sampleStartIndex,
        template.sampleRate,
      ),
      durationMs,
      sampleStartIndex,
    };
  }

  private handleCaptureError = (error: Error): void => {
    logger.audio.error("Native capture reported an error", error);
    this.setState("error");
    this.emit("error", error);
  };

  private handleCaptureExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (this.state === "recording" || this.state === "starting") {
      logger.audio.warn("Native capture exited unexpectedly", {
        code,
        signal,
      });
      this.setState("error");
    }
  };

  private async flushTranscriptionRuntimes(): Promise<void> {
    for (const source of orderedSourcesForMode(this.mode)) {
      const runtime = this.transcriptionRuntimes[source];
      if (!runtime) {
        continue;
      }

      const chunks = await runtime.flush();
      await this.traceWriter?.recordEvent("transcription_runtime_flush", {
        source,
        emittedChunkCount: chunks.length,
        emittedTextPreview:
          chunks.length > 0
            ? chunks
                .map((chunk) => chunk.text)
                .join(" | ")
                .slice(0, 240)
            : null,
      });
      await this.persistTranscriptionChunks(chunks);
    }
  }

  private async persistTranscriptionChunks(
    chunks: MeetingTranscriptionChunk[],
  ): Promise<void> {
    if (
      !this.activeMeetingId ||
      this.activeNoteId === null ||
      chunks.length === 0
    ) {
      return;
    }

    const storedSegments = await createTranscriptSegments(
      chunks.map((chunk) => ({
        id: uuid(),
        meetingId: this.activeMeetingId!,
        source: chunk.source,
        speaker: chunk.speaker,
        text: chunk.text,
        startTimeMs: chunk.startTimeMs,
        endTimeMs: chunk.endTimeMs,
        segmentOrder: this.nextSegmentOrder++,
        isFinal: chunk.isFinal,
      })),
    );

    for (const segment of storedSegments) {
      const event: TranscriptEvent = {
        id: segment.id,
        meetingId: segment.meetingId,
        noteId: this.activeNoteId,
        source: segment.source as TranscriptEvent["source"],
        speaker: segment.speaker as TranscriptEvent["speaker"],
        text: segment.text,
        startTimeMs: segment.startTimeMs,
        endTimeMs: segment.endTimeMs,
        segmentOrder: segment.segmentOrder,
        isFinal: segment.isFinal,
        createdAt: segment.createdAt,
      };

      this.lastTranscript.push(event);
      this.emit("transcript-event", event);
    }
  }

  private async disposeTranscriptionRuntimes(): Promise<void> {
    await Promise.all(
      Object.values(this.transcriptionRuntimes).map(async (runtime) => {
        if (!runtime) {
          return;
        }

        await runtime.dispose();
      }),
    );
    this.transcriptionRuntimes = {};
  }

  private async persistArtifacts(meetingId: string): Promise<void> {
    const pendingArtifacts: Array<{
      id: string;
      meetingId: string;
      artifactType:
        | "mic_wav"
        | "mic_processed_wav"
        | "system_wav"
        | "debug_json";
      path: string;
      sizeBytes: number;
    }> = [];

    for (const source of Object.keys(
      ARTIFACT_TYPE_BY_SOURCE,
    ) as MeetingArtifactSource[]) {
      const writer = this.writers[source];
      if (!writer) {
        continue;
      }

      const stats = await fs.promises.stat(writer.getFilePath());
      pendingArtifacts.push({
        id: uuid(),
        meetingId,
        artifactType: ARTIFACT_TYPE_BY_SOURCE[source],
        path: writer.getFilePath(),
        sizeBytes: stats.size,
      });
    }

    if (this.traceDirectory) {
      const traceEntries = await fs.promises.readdir(this.traceDirectory, {
        withFileTypes: true,
      });

      for (const entry of traceEntries) {
        if (!entry.isFile()) {
          continue;
        }

        if (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl")) {
          continue;
        }

        const tracePath = path.join(this.traceDirectory, entry.name);
        const stats = await fs.promises.stat(tracePath);
        pendingArtifacts.push({
          id: uuid(),
          meetingId,
          artifactType: "debug_json",
          path: tracePath,
          sizeBytes: stats.size,
        });
      }
    }

    await createMeetingArtifacts(pendingArtifacts);
  }

  private async finalizeArtifacts(): Promise<void> {
    await Promise.all(
      Object.values(this.writers).map(async (writer) => {
        if (!writer) {
          return;
        }
        await writer.finalize();
      }),
    );
  }

  private async abortArtifacts(): Promise<void> {
    await Promise.all(
      Object.values(this.writers).map(async (writer) => {
        if (!writer) {
          return;
        }
        await writer.abort();
      }),
    );
  }

  private setState(state: MeetingRuntimeState): void {
    this.state = state;
    this.emit("state-changed", this.getState());
  }

  private resetRuntime(): void {
    if (this.captureClient) {
      this.captureClient.off("frame", this.handleFrame);
      this.captureClient.off("aec-mode", this.handleNativeAecMode);
      this.captureClient.off("error", this.handleCaptureError);
      this.captureClient.off("exit", this.handleCaptureExit);
      this.captureClient = null;
    }

    this.writers = {};
    this.transcriptionRuntimes = {};
    this.transcriptionChains = {
      mic: Promise.resolve(),
      system: Promise.resolve(),
    };
    this.levels = {};
    this.activeMeetingId = null;
    this.activeNoteId = null;
    this.startedAtEpochMs = null;
    this.mode = null;
    this.frameWriteChain = Promise.resolve();
    this.nextSegmentOrder = 0;
    this.activeTranscriptionSelection = null;
    this.hasNativeProcessedMicFrames = false;
    this.nativeEchoCancellationMode = null;
    this.artifactNextSampleIndex = {};
    this.transcriptionNextSampleIndex = {};
    this.traceWriter = null;
    this.traceDirectory = null;
    this.echoCanceller?.reset();
    this.echoCanceller = null;
    this.setState("idle");
  }
}

function buildMeetingTitle(startedAt: Date): string {
  return `Meeting ${startedAt.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function normalizeLevel(audio: Float32Array): number {
  if (audio.length === 0) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < audio.length; index += 1) {
    total += audio[index] * audio[index];
  }

  const rms = Math.sqrt(total / audio.length);
  return Math.min(1, rms * 4);
}

function sampleIndexToTimestampMs(
  sampleStartIndex: number,
  sampleRate: number,
): number {
  if (sampleStartIndex <= 0 || sampleRate <= 0) {
    return 0;
  }

  return Math.round((sampleStartIndex / sampleRate) * 1000);
}

function orderedSourcesForMode(mode: MeetingCaptureMode | null): AudioSource[] {
  switch (mode) {
    case "mic":
      return ["mic"];
    case "system":
      return ["system"];
    case "dual":
      return ["mic", "system"];
    default:
      return [];
  }
}
