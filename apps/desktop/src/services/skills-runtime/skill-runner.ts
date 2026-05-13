import { generateText, Output } from "ai";
import { z } from "zod";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { logger } from "@/main/logger";
import { db as defaultDb } from "@/db";
import { appendArtifact } from "@/db/artifacts";
import { getInstanceById } from "@/db/instances";
import type { SkillRunContext, SkillRunResult } from "./skill-context";
import { buildSystemPrompt } from "./build-system-prompt";
import { collectInput } from "./collect-input";
import { resolveSkillModel } from "./resolve-model";
import { markdownToChildren } from "./markdown-to-children";
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

  const content = markdownToChildren(object.markdown);
  if (content.length === 0) {
    throw new SkillRunError("Model emitted markdown that produced empty content");
  }

  const auditRow = await appendArtifact(db, {
    noteId: ctx.noteId,
    skillId: ctx.skill.slug,
    mode: ctx.mode,
    content: JSON.stringify(content),
    generator: "ai",
    modelId: ctx.modelId,
    meta: {
      instanceId: instance.id,
      providerType: instance.provider,
      refineInstruction: ctx.refineInstruction ?? null,
      selectionText: ctx.selectionText ?? null,
      reasoning: object.reasoning ?? null,
    },
  });

  logger.pipeline.info("Skill run completed", {
    noteId: ctx.noteId,
    skill: ctx.skill.slug,
    mode: ctx.mode,
    artifactId: auditRow.id,
    version: auditRow.version,
  });

  // beforeText is the "before" side of the char-level diff overlay for
  // replace-doc. append-section is additive (no diff). inline-rewrite gets
  // beforeText from the client's selection.
  const beforeText =
    ctx.mode === "replace-doc" ? input.notePlainText : undefined;

  return {
    artifactId: auditRow.id,
    mode: ctx.mode,
    skillId: ctx.skill.slug,
    skillName: ctx.skill.name,
    version: auditRow.version,
    generatedAt: auditRow.generatedAt!.toISOString(),
    modelId: ctx.modelId,
    content,
    rawMarkdown: object.markdown,
    beforeText,
  };
}
