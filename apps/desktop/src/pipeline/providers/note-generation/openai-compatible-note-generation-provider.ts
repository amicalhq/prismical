import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { logger } from "@/main/logger";
import { getUserAgent } from "@/utils/http-client";
import { buildNoteGenerationPrompt } from "./note-generation-prompt";
import { normalizeGeneratedMarkdown } from "./normalize-generated-markdown";
import type {
  NoteGenerationInput,
  NoteGenerationProvider,
  NoteGenerationResult,
} from "./types";

export class OpenAICompatibleNoteGenerationProvider
  implements NoteGenerationProvider
{
  readonly name = "openai-compatible";

  private readonly provider;

  constructor(
    apiKey: string,
    baseURL: string,
    private readonly model: string,
  ) {
    this.provider = createOpenAICompatible({
      apiKey,
      baseURL,
      name: "openai-compatible",
      headers: {
        "User-Agent": getUserAgent(),
      },
      // Newer OpenAI models (o-series, gpt-5) reject `max_tokens` and require
      // `max_completion_tokens`. Renaming unconditionally is safe: OpenAI accepts
      // the new name for all chat models.
      transformRequestBody: (body) => {
        if (typeof body.max_tokens !== "number") return body;
        const { max_tokens, ...rest } = body;
        return { ...rest, max_completion_tokens: max_tokens };
      },
    });
  }

  async generateMarkdown(
    input: NoteGenerationInput,
  ): Promise<NoteGenerationResult> {
    const { systemPrompt, userPrompt } = buildNoteGenerationPrompt(input);

    logger.pipeline.info("Generating notes with OpenAI-compatible provider", {
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
      maxOutputTokens: 3000,
    });

    return {
      markdown: normalizeGeneratedMarkdown(result.text),
    };
  }
}
