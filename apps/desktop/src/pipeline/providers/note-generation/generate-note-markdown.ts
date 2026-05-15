import { generateText } from "ai";
import { v4 as uuid } from "uuid";

import { db } from "@/db";
import { getInstanceById } from "@/db/instances";
import { noteGenerationAudit } from "@/db/schema";
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
  // Optional — passed to the audit row so per-note spend can be joined
  // back to the source note. Absent for one-shot dev/test runs.
  noteId?: number;
}

export interface NoteGenerationResult {
  markdown: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
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
 *
 * On success, writes a `note_generation_audit` row capturing token usage
 * (t-07). Failed runs do not write a row; the pipeline logger carries
 * the failure breadcrumb instead.
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

  // Resolve providerType for the audit row. One extra query per run is
  // fine — note-gen isn't on a hot path. If we ever care, the call site
  // can pre-fetch and pass it in.
  const instance = await getInstanceById(instanceId);
  try {
    await db.insert(noteGenerationAudit).values({
      id: uuid(),
      noteId: input.noteId ?? null,
      modelInstanceId: instanceId,
      modelId,
      providerType: instance?.provider ?? "unknown",
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      totalTokens: result.usage?.totalTokens ?? null,
      rawUsageJson: result.usage ? JSON.stringify(result.usage) : null,
    });
  } catch (err) {
    // Audit-write failure must not fail the user's run. Surface to logs.
    logger.pipeline.error("Failed to write note_generation_audit row", {
      instanceId,
      modelId,
      err,
    });
  }

  return {
    markdown: normalizeGeneratedMarkdown(result.text),
    usage: {
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      totalTokens: result.usage?.totalTokens,
    },
  };
}
