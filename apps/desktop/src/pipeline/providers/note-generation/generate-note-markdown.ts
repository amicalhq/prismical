import { generateText } from "ai";

import { logger } from "@/main/logger";
import { getRegistry, registryKey } from "@/services/ai/registry";
import { buildNoteGenerationPrompt } from "./note-generation-prompt";
import { normalizeGeneratedMarkdown } from "./normalize-generated-markdown";

// Note: this entry point currently has no caller. The previous note-gen
// service was deleted in PRSM-2 (commit 1a7cae5). It lives here so the
// re-wire (a separate task) has a single place to plug back in, and so
// later tasks in the AI revamp (t-05, t-06, t-07, t-16) have an
// instrumentation target. Until that re-wire lands, this function is
// dead code.

export interface NoteGenerationInput {
  transcript: string;
  noteTitle?: string;
  eventTitle?: string;
}

export interface NoteGenerationResult {
  markdown: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

/**
 * Generate a note's markdown via the unified provider registry.
 *
 * The model is resolved on every call so the latest instance config (e.g.
 * a freshly rotated API key) reaches the wire. See `registry.ts` for the
 * rationale.
 *
 * Unlike the skill runner, note-gen does NOT wrap the model with
 * `extractJsonMiddleware`. The middleware's fence-stripping regex
 * misinterprets ` ```markdown ... ``` ` blocks (which note-gen models
 * often emit) — we rely on `normalizeGeneratedMarkdown` instead.
 */
export async function generateNoteMarkdown(
  instanceId: string,
  modelId: string,
  input: NoteGenerationInput,
): Promise<NoteGenerationResult> {
  const { systemPrompt, userPrompt } = buildNoteGenerationPrompt(input);

  logger.pipeline.info("Generating notes via unified provider registry", {
    instanceId,
    modelId,
    transcriptLength: input.transcript.length,
  });

  const registry = await getRegistry();
  const model = registry.languageModel(registryKey(instanceId, modelId));

  const result = await generateText({
    model,
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
