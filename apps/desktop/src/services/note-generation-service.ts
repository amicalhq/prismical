import {
  getProviderTypeFromModelProviderName,
  type ProviderType,
} from "@/constants/provider-types";
import { createOrReplaceArtifact } from "@/db/artifacts";
import { getNoteTranscript } from "@/db/meetings";
import { getNoteById } from "@/db/notes";
import { logger } from "@/main/logger";
import {
  createRemoteNoteGenerationProvider,
  type RemoteNoteGenerationProviderType,
} from "@/pipeline/providers/note-generation/remote-note-generation-provider-registry";
import type { NoteGenerationResult } from "@/pipeline/providers/note-generation/types";
import type { NoteArtifact } from "@/db/schema";
import type { SettingsService } from "./settings-service";
import type { ModelService } from "./model-service";
import { markdownToLexicalStateJson } from "./notes/markdown-to-lexical";

export interface GeneratedNotesResult {
  artifact: NoteArtifact;
  modelSelection: string;
  modelId: string;
  providerType: RemoteNoteGenerationProviderType;
  generatedAt: Date;
}

export class NoteGenerationService {
  constructor(
    private readonly modelService: ModelService,
    private readonly settingsService: SettingsService,
  ) {}

  async generateNotesFromTranscript(
    noteId: number,
  ): Promise<GeneratedNotesResult> {
    const [note, transcript] = await Promise.all([
      getNoteById(noteId),
      getNoteTranscript(noteId),
    ]);

    if (!note) {
      throw new Error("Note not found");
    }

    if (transcript.length === 0) {
      throw new Error("No transcript is available for this note yet");
    }

    const modelRecord = await this.modelService.getDefaultLanguageModelRecord();
    const modelSelection =
      await this.modelService.getDefaultLanguageModelSelection();

    if (!modelRecord || !modelSelection) {
      throw new Error("No language model is configured");
    }

    const providerType = getProviderTypeFromModelProviderName(
      modelRecord.provider,
    );

    if (!providerType || !isRemoteNoteGenerationProviderType(providerType)) {
      throw new Error(
        `Unsupported language model provider for note generation: ${modelRecord.provider}`,
      );
    }

    const provider = await createRemoteNoteGenerationProvider(
      this.settingsService,
      providerType,
      modelRecord.id,
    );

    if (!provider) {
      throw new Error(
        `Provider ${providerType} is not configured for note generation`,
      );
    }

    const transcriptText = serializeTranscriptForGeneration(transcript);
    const result: NoteGenerationResult = await provider.generateMarkdown({
      transcript: transcriptText,
      noteTitle: note.title,
      eventTitle: note.eventData?.title,
    });

    if (!result.markdown.trim()) {
      throw new Error("The configured language model returned an empty result");
    }

    const generatedAt = new Date();

    const artifact = await createOrReplaceArtifact({
      noteId,
      kind: "summary",
      content: markdownToLexicalStateJson(result.markdown),
      generator: "ai",
      modelId: modelRecord.id,
      meta: {
        modelSelection,
        providerType,
        transcriptLength: transcriptText.length,
      },
      generatedAt,
    });

    logger.pipeline.info("Generated note artifact from transcript", {
      noteId,
      artifactId: artifact.id,
      modelSelection,
      providerType,
      transcriptLength: transcriptText.length,
      generatedAt: generatedAt.toISOString(),
    });

    return {
      artifact,
      modelSelection,
      modelId: modelRecord.id,
      providerType,
      generatedAt,
    };
  }
}

function isRemoteNoteGenerationProviderType(
  providerType: ProviderType,
): providerType is RemoteNoteGenerationProviderType {
  return (
    providerType === "openrouter" ||
    providerType === "ollama" ||
    providerType === "openai-compatible" ||
    providerType === "mock"
  );
}

function serializeTranscriptForGeneration(
  transcript: Awaited<ReturnType<typeof getNoteTranscript>>,
): string {
  return transcript
    .map((segment) => {
      const speaker = segment.speaker === "you" ? "You" : "Them";
      return `[${formatTranscriptTimestamp(segment.startTimeMs)}] ${speaker}: ${segment.text}`;
    })
    .join("\n");
}

function formatTranscriptTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
