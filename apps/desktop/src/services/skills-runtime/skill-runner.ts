import { generateText, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { logger } from "@/main/logger";
import { db as defaultDb } from "@/db";
import { appendArtifact } from "@/db/artifacts";
import { getInstanceById } from "@/db/instances";

import type {
  SkillRunContext,
  SkillRunResult,
  WriteSectionPayload,
} from "./skill-context";
import type { ApiKeyConfig, OpenAICompatibleConfig } from "@/db/schema";
import { buildSystemPrompt } from "./build-system-prompt";
import { buildToolRegistry } from "./tools";
import { markdownToChildren } from "./markdown-to-children";
import { WriteToolMissingError, SkillRunError, SkillCancelledError } from "./errors";

const MAX_STEPS = 8;

export async function runSkill(
  ctx: SkillRunContext,
  options: { db?: LibSQLDatabase<Record<string, unknown>> } = {},
): Promise<SkillRunResult> {
  const db = options.db ?? (defaultDb as unknown as LibSQLDatabase<Record<string, unknown>>);
  let captured: WriteSectionPayload | null = null;
  const capture = (payload: WriteSectionPayload) => {
    captured = payload;
  };

  const tools = buildToolRegistry(db, ctx, capture);
  const systemPrompt = buildSystemPrompt(ctx);

  // Resolve the model instance.
  const instance = await getInstanceById(ctx.modelInstanceId);
  if (!instance) {
    throw new SkillRunError(
      `Configured model instance not found: ${ctx.modelInstanceId}`,
    );
  }

  if (
    instance.provider !== "openai-compatible" &&
    instance.provider !== "openai" &&
    instance.provider !== "groq" &&
    instance.provider !== "openrouter"
  ) {
    throw new SkillRunError(
      `Skill runtime only supports openai-compatible providers in v1 (got ${instance.provider})`,
    );
  }

  // Cast to the union of configs that carry apiKey. Both ApiKeyConfig and
  // OpenAICompatibleConfig have apiKey; only OpenAICompatibleConfig has baseURL.
  const config = instance.config as ApiKeyConfig | OpenAICompatibleConfig;
  const apiKey = config.apiKey;
  const baseURL =
    "baseURL" in config && config.baseURL
      ? config.baseURL
      : resolveDefaultBaseURL(instance.provider);

  const provider = createOpenAICompatible({ apiKey, baseURL, name: "skills-runtime" });

  try {
    await generateText({
      model: provider(ctx.modelId),
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: "Run the skill as instructed in the system prompt.",
        },
      ],
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: ctx.signal,
    });
  } catch (err) {
    if (ctx.signal.aborted) {
      throw new SkillCancelledError();
    }
    throw new SkillRunError(
      err instanceof Error ? err.message : String(err),
      err,
    );
  }

  if (!captured) {
    throw new WriteToolMissingError();
  }

  const content = markdownToChildren(captured.markdown);
  if (content.length === 0) {
    throw new SkillRunError("Agent emitted markdown that produced empty content");
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
      refine: ctx.refineInstruction ? true : false,
    },
  });

  logger.pipeline.info("Skill run completed", {
    noteId: ctx.noteId,
    skill: ctx.skill.slug,
    mode: ctx.mode,
    artifactId: auditRow.id,
    version: auditRow.version,
  });

  return {
    artifactId: auditRow.id,
    mode: ctx.mode,
    skillId: ctx.skill.slug,
    skillName: ctx.skill.name,
    version: auditRow.version,
    generatedAt: auditRow.generatedAt!.toISOString(),
    modelId: ctx.modelId,
    content,
    rawMarkdown: captured.markdown,
  };
}

function resolveDefaultBaseURL(provider: string): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "groq":
      return "https://api.groq.com/openai/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    default:
      return "https://api.openai.com/v1";
  }
}
