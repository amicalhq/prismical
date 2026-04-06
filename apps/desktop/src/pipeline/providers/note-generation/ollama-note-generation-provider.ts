import { logger } from "@/main/logger";
import { buildNoteGenerationPrompt } from "./note-generation-prompt";
import { normalizeGeneratedMarkdown } from "./normalize-generated-markdown";
import type {
  NoteGenerationInput,
  NoteGenerationProvider,
  NoteGenerationResult,
} from "./types";

export class OllamaNoteGenerationProvider implements NoteGenerationProvider {
  readonly name = "ollama";

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async generateMarkdown(
    input: NoteGenerationInput,
  ): Promise<NoteGenerationResult> {
    const { systemPrompt, userPrompt } = buildNoteGenerationPrompt(input);

    logger.pipeline.info("Generating notes with Ollama", {
      model: this.model,
      transcriptLength: input.transcript.length,
    });

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 3000,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();
    const markdown = data.message?.content;

    if (typeof markdown !== "string" || !markdown.trim()) {
      throw new Error("Ollama returned an empty note generation response");
    }

    return {
      markdown: normalizeGeneratedMarkdown(markdown),
    };
  }
}
