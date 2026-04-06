import { Mutex } from "async-mutex";
import type { TranscriptionProvider } from "@/pipeline/core/pipeline-types";
import type { ModelService } from "@/services/model-service";
import type {
  AudioFrame,
  AudioSource,
  TranscriptSpeaker,
} from "@/types/meeting";
import {
  createMeetingTranscriptionProvider,
  type MeetingTranscriptionSelection,
} from "./meeting-transcription-provider-registry";

export interface MeetingTranscriptionChunk {
  source: AudioSource;
  speaker: TranscriptSpeaker;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  isFinal: boolean;
}

interface CreateMeetingSourceRuntimeOptions {
  meetingId: string;
  source: AudioSource;
  speaker: TranscriptSpeaker;
  language?: string;
}

export class MeetingTranscriptionService {
  constructor(private readonly modelService: ModelService) {}

  async createSourceRuntime(
    options: CreateMeetingSourceRuntimeOptions,
  ): Promise<MeetingSourceTranscriptionRuntime> {
    const { provider, selection } = await createMeetingTranscriptionProvider(
      this.modelService,
    );

    provider.reset();

    return new MeetingSourceTranscriptionRuntime(provider, selection, options);
  }
}

export class MeetingSourceTranscriptionRuntime {
  private readonly mutex = new Mutex();
  private aggregatedText = "";
  private lastProviderChunk: string | undefined;
  private pendingStartTimeMs: number | null = null;
  private pendingEndTimeMs = 0;

  constructor(
    private readonly provider: TranscriptionProvider,
    private readonly selection: MeetingTranscriptionSelection,
    private readonly options: CreateMeetingSourceRuntimeOptions,
  ) {}

  getMetadata(): MeetingTranscriptionSelection {
    return this.selection;
  }

  async ingestFrame(frame: AudioFrame): Promise<MeetingTranscriptionChunk[]> {
    return this.mutex.runExclusive(async () => {
      if (this.pendingStartTimeMs === null) {
        this.pendingStartTimeMs = frame.timestampMs;
      }

      this.pendingEndTimeMs = Math.max(
        this.pendingEndTimeMs,
        frame.timestampMs + frame.durationMs,
      );

      const providerText = await this.provider.transcribe({
        audioData: frame.samples,
        speechProbability: estimateSpeechProbability(frame.samples),
        context: {
          sessionId: this.options.meetingId,
          language: this.options.language ?? "auto",
          previousChunk: this.lastProviderChunk,
          aggregatedTranscription: this.aggregatedText || undefined,
        },
      });

      return this.consumeProviderOutput(providerText, false);
    });
  }

  async flush(): Promise<MeetingTranscriptionChunk[]> {
    return this.mutex.runExclusive(async () => {
      const providerText = await this.provider.flush({
        sessionId: this.options.meetingId,
        language: this.options.language ?? "auto",
        previousChunk: this.lastProviderChunk,
        aggregatedTranscription: this.aggregatedText || undefined,
      });

      return this.consumeProviderOutput(providerText, true);
    });
  }

  async dispose(): Promise<void> {
    if (
      "dispose" in this.provider &&
      typeof this.provider.dispose === "function"
    ) {
      await this.provider.dispose();
      return;
    }

    this.provider.reset();
  }

  private consumeProviderOutput(
    providerText: string,
    isFinal: boolean,
  ): MeetingTranscriptionChunk[] {
    if (!providerText || this.pendingStartTimeMs === null) {
      return [];
    }

    const emittedText = this.extractEmittedText(providerText);
    this.lastProviderChunk = providerText;

    if (!emittedText.trim()) {
      return [];
    }

    const chunk: MeetingTranscriptionChunk = {
      source: this.options.source,
      speaker: this.options.speaker,
      text: emittedText.trim(),
      startTimeMs: this.pendingStartTimeMs,
      endTimeMs: this.pendingEndTimeMs,
      isFinal,
    };

    this.pendingStartTimeMs = null;
    this.pendingEndTimeMs = 0;

    return [chunk];
  }

  private extractEmittedText(providerText: string): string {
    if (this.selection.transport === "cloud") {
      const previousAggregated = this.aggregatedText;
      this.aggregatedText = providerText;

      if (!previousAggregated) {
        return providerText;
      }

      if (providerText.startsWith(previousAggregated)) {
        return providerText.slice(previousAggregated.length);
      }

      return providerText;
    }

    this.aggregatedText += providerText;
    return providerText;
  }
}

function estimateSpeechProbability(audio: Float32Array): number {
  if (audio.length === 0) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < audio.length; index += 1) {
    total += audio[index] * audio[index];
  }

  const rms = Math.sqrt(total / audio.length);
  if (rms <= 0.008) {
    return 0;
  }

  if (rms >= 0.05) {
    return 1;
  }

  return (rms - 0.008) / (0.05 - 0.008);
}
