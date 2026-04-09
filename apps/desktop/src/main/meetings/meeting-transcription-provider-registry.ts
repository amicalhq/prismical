import type { TranscriptionProvider } from "@/pipeline/core/pipeline-types";
import { WhisperProvider } from "@/pipeline/providers/transcription/whisper-provider";
import type { ModelService } from "@/services/model-service";

export const MEETING_TRANSCRIPTION_PROVIDER_TYPES = {
  localWhisper: "local-whisper",
} as const;

export type MeetingTranscriptionProviderType =
  (typeof MEETING_TRANSCRIPTION_PROVIDER_TYPES)[keyof typeof MEETING_TRANSCRIPTION_PROVIDER_TYPES];

export type MeetingTranscriptionTransport = "local";

export interface MeetingTranscriptionSelection {
  providerType: MeetingTranscriptionProviderType;
  transport: MeetingTranscriptionTransport;
  modelId: string | null;
  modelName: string;
}

interface MeetingTranscriptionProviderFactory {
  createProvider(modelService: ModelService): Promise<TranscriptionProvider>;
}

const registry: Record<
  MeetingTranscriptionProviderType,
  MeetingTranscriptionProviderFactory
> = {
  [MEETING_TRANSCRIPTION_PROVIDER_TYPES.localWhisper]: {
    async createProvider(modelService) {
      return new WhisperProvider(modelService);
    },
  },
};

export async function resolveMeetingTranscriptionSelection(
  modelService: ModelService,
): Promise<MeetingTranscriptionSelection> {
  const selectedModelId = await modelService.getSelectedModel();

  return {
    providerType: MEETING_TRANSCRIPTION_PROVIDER_TYPES.localWhisper,
    transport: "local",
    modelId: selectedModelId,
    modelName: "Local Whisper",
  };
}

export async function createMeetingTranscriptionProvider(
  modelService: ModelService,
): Promise<{
  provider: TranscriptionProvider;
  selection: MeetingTranscriptionSelection;
}> {
  const selection = await resolveMeetingTranscriptionSelection(modelService);
  const provider =
    await registry[selection.providerType].createProvider(modelService);

  return {
    provider,
    selection,
  };
}
