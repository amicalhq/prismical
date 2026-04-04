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
import {
  segmentAudioByEnergy,
  type SegmentedAudioChunk,
} from "../meetings/energy-segmenter";
import { NativeAudioCaptureClient } from "../meetings/native-audio-capture-client";
import { WhisperSessionTranscriber } from "../meetings/whisper-session-transcriber";
import type {
  AudioFrame,
  AudioSource,
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

export class MeetingManager extends EventEmitter {
  private state: MeetingRuntimeState = "idle";
  private mode: MeetingCaptureMode | null = null;
  private activeMeetingId: string | null = null;
  private activeNoteId: number | null = null;
  private startedAtEpochMs: number | null = null;
  private captureClient: NativeAudioCaptureClient | null = null;
  private transcriber: WhisperSessionTranscriber;
  private writers: Partial<Record<AudioSource, StreamingWavWriter>> = {};
  private frameBuffers: Record<AudioSource, Float32Array[]> = {
    mic: [],
    system: [],
  };
  private levels: { mic?: number; system?: number } = {};
  private lastTranscript: TranscriptEvent[] = [];
  private frameWriteChain: Promise<void> = Promise.resolve();

  constructor(private readonly modelService: ModelService) {
    super();
    this.transcriber = new WhisperSessionTranscriber(modelService);
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
    this.frameBuffers = {
      mic: [],
      system: [],
    };
    this.levels = {};
    this.writers = {};

    if (mode === "mic" || mode === "dual") {
      this.writers.mic = new StreamingWavWriter(
        path.join(artifactsDir, "mic.wav"),
      );
    }

    if (mode === "system" || mode === "dual") {
      this.writers.system = new StreamingWavWriter(
        path.join(artifactsDir, "system.wav"),
      );
    }

    this.captureClient = new NativeAudioCaptureClient();
    this.captureClient.on("frame", this.handleFrame);
    this.captureClient.on("error", this.handleCaptureError);
    this.captureClient.on("exit", this.handleCaptureExit);

    this.setState("starting");
    try {
      await this.captureClient.start(mode);
      this.setState("recording");
      logger.audio.info("Meeting capture started", { meetingId, mode });
      return {
        meetingId,
      };
    } catch (error) {
      await updateMeeting(meetingId, {
        state: "failed",
        endedAt: new Date(),
      });
      await this.abortArtifacts();
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
      const transcript = await this.transcribeRecordedAudio(meetingId);
      await this.persistArtifacts(meetingId);
      await updateMeeting(meetingId, {
        state: "completed",
        endedAt: new Date(),
        durationMs: this.getState().durationMs,
        transcriptionModel:
          transcript.modelPath === null
            ? null
            : path.basename(transcript.modelPath),
        metadata: {
          sourceLayout: "merged",
          rawAudioRetained: true,
          transcriptSegmentCount: transcript.events.length,
        },
      });

      this.lastTranscript = transcript.events;
      for (const event of transcript.events) {
        this.emit("transcript-event", event);
      }

      logger.audio.info("Meeting capture finalized", {
        meetingId,
        transcriptSegmentCount: transcript.events.length,
      });

      this.resetRuntime();

      return {
        meetingId,
        transcriptSegmentCount: transcript.events.length,
      };
    } catch (error) {
      logger.audio.error("Meeting capture finalization failed", error);
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
      this.resetRuntime();
    }

    await this.transcriber.dispose();
  }

  private handleFrame = (frame: AudioFrame): void => {
    this.frameWriteChain = this.frameWriteChain
      .then(async () => {
        this.frameBuffers[frame.source].push(frame.samples);
        const writer = this.writers[frame.source];
        if (writer) {
          await writer.appendAudio(frame.samples);
        }

        this.levels[frame.source] = normalizeLevel(frame.samples);
        this.emit("level", { ...this.levels });
      })
      .catch((error) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        logger.audio.error("Failed to persist meeting frame", normalizedError);
        this.emit("error", normalizedError);
      });
  };

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

  private async transcribeRecordedAudio(meetingId: string): Promise<{
    events: TranscriptEvent[];
    modelPath: string | null;
  }> {
    if (this.activeNoteId === null) {
      throw new Error("Active note ID is missing.");
    }

    const pendingSegments: Array<Omit<TranscriptEvent, "createdAt">> = [];
    let modelPath: string | null = null;

    for (const source of orderedSourcesForMode(this.mode)) {
      const audio = concatenateAudio(this.frameBuffers[source]);
      if (audio.length === 0) {
        continue;
      }

      const sourceSegments = buildSourceSegments(audio);
      for (const [segmentOrder, sourceSegment] of sourceSegments.entries()) {
        const { text, modelPath: usedModelPath } =
          await this.transcriber.transcribeAudio(sourceSegment.audio);

        if (!modelPath) {
          modelPath = usedModelPath;
        }

        const normalizedText = text.trim();
        if (!normalizedText) {
          continue;
        }

        pendingSegments.push({
          id: uuid(),
          meetingId,
          noteId: this.activeNoteId,
          source,
          speaker: SOURCE_TO_SPEAKER[source],
          text: normalizedText,
          startTimeMs: sourceSegment.startTimeMs,
          endTimeMs: sourceSegment.endTimeMs,
          segmentOrder,
          isFinal: true,
        });
      }
    }

    pendingSegments.sort((left, right) => {
      if (left.startTimeMs === right.startTimeMs) {
        return left.endTimeMs - right.endTimeMs;
      }
      return left.startTimeMs - right.startTimeMs;
    });

    pendingSegments.forEach((segment, index) => {
      segment.segmentOrder = index;
    });

    const storedSegments = await createTranscriptSegments(
      pendingSegments.map((segment) => ({
        id: segment.id,
        meetingId: segment.meetingId,
        source: segment.source,
        speaker: segment.speaker,
        text: segment.text,
        startTimeMs: segment.startTimeMs,
        endTimeMs: segment.endTimeMs,
        segmentOrder: segment.segmentOrder,
        isFinal: segment.isFinal,
      })),
    );

    return {
      events: storedSegments.map((segment) => ({
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
      })),
      modelPath,
    };
  }

  private async persistArtifacts(meetingId: string): Promise<void> {
    const pendingArtifacts: Array<{
      id: string;
      meetingId: string;
      artifactType: "mic_wav" | "system_wav";
      path: string;
      sizeBytes: number;
    }> = [];

    for (const source of orderedSourcesForMode(this.mode)) {
      const writer = this.writers[source];
      if (!writer) {
        continue;
      }

      const stats = await fs.promises.stat(writer.getFilePath());
      pendingArtifacts.push({
        id: uuid(),
        meetingId,
        artifactType: source === "mic" ? "mic_wav" : "system_wav",
        path: writer.getFilePath(),
        sizeBytes: stats.size,
      });
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
      this.captureClient.off("error", this.handleCaptureError);
      this.captureClient.off("exit", this.handleCaptureExit);
      this.captureClient = null;
    }

    this.writers = {};
    this.frameBuffers = {
      mic: [],
      system: [],
    };
    this.levels = {};
    this.activeMeetingId = null;
    this.activeNoteId = null;
    this.startedAtEpochMs = null;
    this.mode = null;
    this.frameWriteChain = Promise.resolve();
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

function concatenateAudio(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Float32Array(totalLength);

  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined;
}

function buildSourceSegments(audio: Float32Array): SegmentedAudioChunk[] {
  const segments = segmentAudioByEnergy(audio);
  if (segments.length > 0) {
    return segments;
  }

  if (audio.length === 0) {
    return [];
  }

  return [
    {
      startSample: 0,
      endSample: audio.length,
      startTimeMs: 0,
      endTimeMs: Math.round((audio.length / 16000) * 1000),
      audio,
    },
  ];
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
