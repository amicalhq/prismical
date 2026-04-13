import { describe, expect, it, vi } from "vitest";
import type { TranscriptionProvider } from "../../src/pipeline/core/pipeline-types";
import {
  MEETING_TRANSCRIPTION_PROVIDER_TYPES,
  type MeetingTranscriptionSelection,
} from "../../src/main/meetings/meeting-transcription-provider-registry";
import { MeetingSourceTranscriptionRuntime } from "../../src/main/meetings/meeting-transcription-service";

function createSelection(): MeetingTranscriptionSelection {
  return {
    providerType: MEETING_TRANSCRIPTION_PROVIDER_TYPES.localWhisper,
    transport: "local",
    modelId: "test-model",
    modelName: "Test Whisper",
  };
}

describe("MeetingSourceTranscriptionRuntime", () => {
  it("emits provider segment timestamps instead of one coarse chunk", async () => {
    const provider: TranscriptionProvider = {
      name: "test-provider",
      transcribe: vi.fn(async () => ({
        text: "Hello world",
        segments: [
          { text: "Hello", startTimeMs: 1020, endTimeMs: 1180 },
          { text: "world", startTimeMs: 1250, endTimeMs: 1420 },
        ],
      })),
      flush: vi.fn(async () => ({ text: "", segments: [] })),
      reset: vi.fn(),
    };
    const runtime = new MeetingSourceTranscriptionRuntime(
      provider,
      createSelection(),
      {
        meetingId: "meeting-1",
        source: "mic",
        speaker: "you",
      },
    );

    const chunks = await runtime.ingestFrame({
      source: "mic_processed",
      samples: new Float32Array(3200),
      sampleRate: 16000,
      channels: 1,
      timestampMs: 1000,
      durationMs: 200,
      sequenceNum: 1,
      sampleStartIndex: 16000,
    });

    expect(provider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        startTimeMs: 1000,
      }),
    );
    expect(chunks).toEqual([
      {
        source: "mic",
        speaker: "you",
        text: "Hello",
        startTimeMs: 1020,
        endTimeMs: 1180,
        isFinal: false,
      },
      {
        source: "mic",
        speaker: "you",
        text: "world",
        startTimeMs: 1250,
        endTimeMs: 1420,
        isFinal: false,
      },
    ]);
  });

  it("falls back to the buffered frame range when the provider has no segments", async () => {
    const provider: TranscriptionProvider = {
      name: "test-provider",
      transcribe: vi.fn(async () => ({
        text: "fallback text",
        segments: [],
      })),
      flush: vi.fn(async () => ({ text: "", segments: [] })),
      reset: vi.fn(),
    };
    const runtime = new MeetingSourceTranscriptionRuntime(
      provider,
      createSelection(),
      {
        meetingId: "meeting-1",
        source: "system",
        speaker: "them",
      },
    );

    const chunks = await runtime.ingestFrame({
      source: "system",
      samples: new Float32Array(3200),
      sampleRate: 16000,
      channels: 1,
      timestampMs: 500,
      durationMs: 200,
      sequenceNum: 1,
      sampleStartIndex: 8000,
    });

    expect(chunks).toEqual([
      {
        source: "system",
        speaker: "them",
        text: "fallback text",
        startTimeMs: 500,
        endTimeMs: 700,
        isFinal: false,
      },
    ]);
  });
});
