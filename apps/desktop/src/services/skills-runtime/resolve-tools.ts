import type { ToolSet } from "ai";

import type { Skill } from "@/db/schema";
import { logger } from "@/main/logger";

/**
 * Resolve the tool set a skill is allowed to use. Stub today: returns an
 * empty `ToolSet`, so the agent path collapses to the current single-shot
 * `generateText` behaviour.
 *
 * The future MCP task replaces this with `createMCPClient` calls plus
 * native provider tools (e.g. `openai.tools.webSearch({})`). Until then,
 * a skill that declares `allowedTools` just logs a warning so the
 * misconfiguration surfaces without crashing.
 *
 * Single integration point — adding tool sources here is the entire surface
 * for MCP enablement.
 */
export async function resolveTools(skill: Skill): Promise<ToolSet> {
  if ((skill.allowedTools?.length ?? 0) > 0) {
    logger.pipeline.warn(
      "Skill declared allowedTools but tool execution is not yet implemented",
      { skill: skill.slug, allowedTools: skill.allowedTools },
    );
  }
  return {};
}
