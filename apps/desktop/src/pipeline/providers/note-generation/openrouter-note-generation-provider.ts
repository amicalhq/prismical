import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { logger } from "@/main/logger";
import { buildNoteGenerationPrompt } from "./note-generation-prompt";
import { normalizeGeneratedMarkdown } from "./normalize-generated-markdown";
import type {
  NoteGenerationInput,
  NoteGenerationProvider,
  NoteGenerationResult,
} from "./types";

export class OpenRouterNoteGenerationProvider
  implements NoteGenerationProvider
{
  readonly name = "openrouter";

  private readonly provider;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.provider = createOpenRouter({
      apiKey,
    });
  }

  async generateMarkdown(
    input: NoteGenerationInput,
  ): Promise<NoteGenerationResult> {
    const { systemPrompt, userPrompt } = buildNoteGenerationPrompt(input);

    logger.pipeline.info("Generating notes with OpenRouter", {
      model: this.model,
      transcriptLength: input.transcript.length,
    });

    const result = await generateText({
      model: this.provider(this.model),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      maxTokens: 3000,
    });

    return {
      markdown: normalizeGeneratedMarkdown(result.text),
    };
  }
}
