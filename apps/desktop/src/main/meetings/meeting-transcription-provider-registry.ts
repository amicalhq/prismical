import { AVAILABLE_MODELS } from "@/constants/models";
import type { TranscriptionProvider } from "@/pipeline/core/pipeline-types";
import { PrismicalCloudProvider } from "@/pipeline/providers/transcription/prismical-cloud-provider";
import { WhisperProvider } from "@/pipeline/providers/transcription/whisper-provider";
import type { ModelService } from "@/services/model-service";

export const MEETING_TRANSCRIPTION_PROVIDER_TYPES = {
  localWhisper: "local-whisper",
  prismicalCloud: "prismical-cloud",
} as const;

export type MeetingTranscriptionProviderType =
  (typeof MEETING_TRANSCRIPTION_PROVIDER_TYPES)[keyof typeof MEETING_TRANSCRIPTION_PROVIDER_TYPES];

export type MeetingTranscriptionTransport = "local" | "cloud";

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
  [MEETING_TRANSCRIPTION_PROVIDER_TYPES.prismicalCloud]: {
    async createProvider() {
      return new PrismicalCloudProvider();
    },
  },
};

export async function resolveMeetingTranscriptionSelection(
  modelService: ModelService,
): Promise<MeetingTranscriptionSelection> {
  const selectedModelId = await modelService.getSelectedModel();
  const model = selectedModelId
    ? AVAILABLE_MODELS.find((entry) => entry.id === selectedModelId)
    : null;

  if (model?.provider === "Prismical Cloud") {
    return {
      providerType: MEETING_TRANSCRIPTION_PROVIDER_TYPES.prismicalCloud,
      transport: "cloud",
      modelId: model.id,
      modelName: model.name,
    };
  }

  return {
    providerType: MEETING_TRANSCRIPTION_PROVIDER_TYPES.localWhisper,
    transport: "local",
    modelId: model?.id ?? null,
    modelName: model?.name ?? "Local Whisper",
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
