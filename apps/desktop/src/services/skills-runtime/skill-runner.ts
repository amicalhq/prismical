import { generateText, Output } from "ai";
import { z } from "zod";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { logger } from "@/main/logger";
import { db as defaultDb } from "@/db";
import { getInstanceById } from "@/db/instances";
import type { SkillRunContext, SkillRunResult } from "./skill-context";
import { buildSystemPrompt } from "./build-system-prompt";
import { collectInput } from "./collect-input";
import { resolveSkillModel } from "./resolve-model";
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

  const model = resolveSkillModel(instance, ctx.modelId);
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

  logger.pipeline.info("Skill run produced candidate (unpersisted)", {
    noteId: ctx.noteId,
    skill: ctx.skill.slug,
    mode: ctx.mode,
  });

  // beforeText is the "before" side of the char-level diff overlay for
  // replace-doc. We use the markdown rendering of the note (not plain text)
  // because the candidate's `rawMarkdown` is markdown — diffing plain-vs-md
  // makes every `##`, `**`, `-` look like an insert even when the content
  // hasn't changed. append-section is additive (no diff); inline-rewrite
  // gets beforeText from the client's selection.
  const beforeText =
    ctx.mode === "replace-doc" ? input.noteMarkdown : undefined;

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
