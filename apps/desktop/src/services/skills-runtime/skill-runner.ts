import {
  generateText,
  Output,
  extractJsonMiddleware,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { logger } from "@/main/logger";
import { db as defaultDb } from "@/db";
import { getInstanceById } from "@/db/instances";
import { getRegistry, registryKey } from "@/services/ai/registry";
import type { SkillRunContext, SkillRunResult } from "./skill-context";
import { buildSystemPrompt } from "./build-system-prompt";
import { collectInput } from "./collect-input";
import {
  markdownToChildren,
  markdownToInlineChildren,
} from "./markdown-to-children";
import { SkillRunError, SkillCancelledError } from "./errors";

// The model returns one JSON object per run. We deliberately don't expose
// tools in v1 — the runner injects everything the skill needs (note,
// transcript, selection, refine context) into the system prompt, and the
// model just transforms. Tool-loop / MCP support can opt-in via
// `skill.allowedTools` later without changing this default path.
const OUTPUT_SCHEMA = z.object({
  markdown: z.string().min(1, "must produce non-empty markdown"),
  // Optional model-supplied notes. Stored in the audit meta for eval/debug;
  // never shown to the user.
  reasoning: z.string().optional(),
});

export async function runSkill(
  ctx: SkillRunContext,
  options: { db?: LibSQLDatabase<Record<string, unknown>> } = {},
): Promise<SkillRunResult> {
  const db =
    options.db ?? (defaultDb as unknown as LibSQLDatabase<Record<string, unknown>>);

  const instance = await getInstanceById(ctx.modelInstanceId);
  if (!instance) {
    throw new SkillRunError(
      `Configured model instance not found: ${ctx.modelInstanceId}`,
    );
  }

  // The registry's `languageModel(...)` throws `NoSuchModelError` /
  // `NoSuchProviderError` (raw `AI_NoSuchModelError`) when the row's
  // provider has no factory entry — e.g. an anthropic instance before
  // t-03 installs `@ai-sdk/anthropic`, or a row whose provider was
  // removed between the `getInstanceById` lookup above and this call.
  // Translate to `SkillRunError` so the tRPC layer surfaces a friendly
  // "Couldn't run X — <reason>" toast instead of the raw SDK message.
  const registry = await getRegistry();
  let baseModel;
  try {
    baseModel = registry.languageModel(
      registryKey(instance.id, ctx.modelId),
    );
  } catch (err) {
    throw new SkillRunError(
      `Skills aren't wired for this instance yet (${instance.provider}). ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  // Local + weaker models (Ollama, lower-tier Groq, generic
  // openai-compatible endpoints) often wrap structured-output JSON in
  // ```json ... ``` fences, which `Output.object` then parses as text and
  // rejects with `NoObjectGeneratedError`. The SDK ships
  // `extractJsonMiddleware` for exactly this case. We apply it per-call at
  // the skill-runner site only — NOT registry-global — because note-gen
  // returns freeform markdown via plain `generateText` and the middleware's
  // fence-stripping regex would mangle ` ```markdown ... ``` ` blocks.
  const model = wrapLanguageModel({
    model: baseModel,
    middleware: extractJsonMiddleware(),
  });
  const input = await collectInput(db, ctx);
  const systemPrompt = buildSystemPrompt(ctx, input);

  let object: z.infer<typeof OUTPUT_SCHEMA>;
  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: "Run the skill as instructed in the system prompt.",
      output: Output.object({ schema: OUTPUT_SCHEMA }),
      abortSignal: ctx.signal,
    });
    object = result.output;
  } catch (err) {
    if (ctx.signal.aborted) throw new SkillCancelledError();
    throw new SkillRunError(
      err instanceof Error ? err.message : String(err),
      err,
    );
  }

  // Inline-rewrite wraps the output in an ArtifactInlineNode, which can only
  // contain inline children. Use a stricter converter that flattens a single
  // paragraph and rejects multi-block / non-paragraph output.
  const content =
    ctx.mode === "inline-rewrite"
      ? markdownToInlineChildren(object.markdown)
      : markdownToChildren(object.markdown);
  if (content.length === 0) {
    throw new SkillRunError(
      ctx.mode === "inline-rewrite"
        ? "Model returned unexpected output for an inline rewrite (expected a single short replacement)"
        : "Model emitted markdown that produced empty content",
    );
  }

  // beforeText is the "before" side of the char-level diff overlay. We use the
  // markdown rendering of the note (not plain text) because the candidate's
  // `rawMarkdown` is markdown — diffing plain-vs-md makes every `##`, `**`,
  // `-` look like an insert even when the content hasn't changed.
  //
  // Populated for both `append-section` and `replace-doc` so the diff store's
  // post-run mode switch (append <-> replace) can re-render the overlay
  // without a second tRPC round-trip. append-section's additive preview
  // doesn't render beforeText today; carrying it is harmless.
  //
  // inline-rewrite gets beforeText from the client's selection instead.
  const beforeText =
    ctx.mode === "inline-rewrite" ? undefined : input.noteMarkdown;

  logger.pipeline.info("Skill run produced candidate (unpersisted)", {
    noteId: ctx.noteId,
    skill: ctx.skill.slug,
    mode: ctx.mode,
  });

  return {
    mode: ctx.mode,
    skillId: ctx.skill.slug,
    skillName: ctx.skill.name,
    modelId: ctx.modelId,
    modelInstanceId: instance.id,
    providerType: instance.provider,
    content,
    rawMarkdown: object.markdown,
    beforeText,
    refineInstruction: ctx.refineInstruction ?? null,
    selectionText: ctx.selectionText ?? null,
    reasoning: object.reasoning ?? null,
  };
}
