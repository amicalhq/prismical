import { createOrReplaceArtifact } from "@/db/artifacts";
import { getInstanceById } from "@/db/instances";
import { getNoteTranscript } from "@/db/meetings";
import { getNoteById } from "@/db/notes";
import { logger } from "@/main/logger";
import { createNoteGenerationProvider } from "@/pipeline/providers/note-generation/remote-note-generation-provider-registry";
import type { NoteGenerationResult } from "@/pipeline/providers/note-generation/types";
import type { NoteArtifact } from "@/db/schema";
import type { SettingsService } from "./settings-service";
import { selectionToKey } from "@/utils/model-selection";
import { markdownToLexicalStateJson } from "./notes/markdown-to-lexical";

export interface GeneratedNotesResult {
  artifact: NoteArtifact;
  /** Opaque "instanceId::modelId" key suitable for round-tripping back to the picker. */
  modelSelection: string;
  modelId: string;
  /** Provider type from the instance row, e.g. "openrouter", "groq". */
  providerType: string;
  generatedAt: Date;
}

export class NoteGenerationService {
  constructor(private readonly settingsService: SettingsService) {}

  async generateNotesFromTranscript(
    noteId: number,
  ): Promise<GeneratedNotesResult> {
    const [note, transcript] = await Promise.all([
      getNoteById(noteId),
      getNoteTranscript(noteId),
    ]);

    if (!note) throw new Error("Note not found");
    if (transcript.length === 0) {
      throw new Error("No transcript is available for this note yet");
    }

    // Note generation reuses the user's "formatting" default — both are
    // language-model use cases and the user hasn't expressed a separate
    // selection for note generation.
    const selection = await this.settingsService.getDefault("formatting");
    if (!selection) {
      throw new Error("No language model is configured");
    }

    const instance = await getInstanceById(selection.instanceId);
    if (!instance) {
      throw new Error(
        `The instance "${selection.instanceId}" referenced by the formatting default no longer exists`,
      );
    }

    const provider = await createNoteGenerationProvider(
      instance,
      selection.modelId,
    );

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
    const modelSelectionKey = selectionToKey(selection);

    const artifact = await createOrReplaceArtifact({
      noteId,
      kind: "summary",
      content: markdownToLexicalStateJson(result.markdown),
      generator: "ai",
      modelId: selection.modelId,
      meta: {
        modelSelection: modelSelectionKey,
        providerType: instance.provider,
        instanceId: instance.id,
        instanceLabel: instance.label,
        transcriptLength: transcriptText.length,
      },
      generatedAt,
    });

    logger.pipeline.info("Generated note artifact from transcript", {
      noteId,
      artifactId: artifact.id,
      modelSelection: modelSelectionKey,
      providerType: instance.provider,
      transcriptLength: transcriptText.length,
      generatedAt: generatedAt.toISOString(),
    });

    return {
      artifact,
      modelSelection: modelSelectionKey,
      modelId: selection.modelId,
      providerType: instance.provider,
      generatedAt,
    };
  }
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
