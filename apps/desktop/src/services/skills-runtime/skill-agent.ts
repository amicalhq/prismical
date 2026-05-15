import {
  generateText,
  Output,
  ToolLoopAgent,
  type LanguageModelUsage,
  type ToolSet,
} from "ai";
import type {
  LanguageModelV3,
  SharedV3ProviderMetadata,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";
import { z } from "zod";

import type { Skill } from "@/db/schema";
import { logger } from "@/main/logger";
import { resolveTools } from "./resolve-tools";

// Shared output schema for skill runs. Lives here (not in skill-runner)
// because both the single-shot and tool-loop paths emit the same shape —
// keeping it next to the agent prevents the two paths drifting.
//
// Plain `z.string()` — see skill-runner.ts comment about OpenAI strict
// mode rejecting `minLength`. Non-empty is validated post-parse.
export const OUTPUT_SCHEMA = z.object({
  markdown: z.string(),
  reasoning: z.string().optional(),
});

export type SkillAgentOutput = z.infer<typeof OUTPUT_SCHEMA>;

export interface SkillAgentArgs {
  model: LanguageModelV3;
  systemPrompt: string;
  providerOptions?: SharedV3ProviderOptions;
  signal: AbortSignal;
  skill: Skill;
}

export interface SkillAgentResult {
  output: SkillAgentOutput;
  usage: LanguageModelUsage | undefined;
  providerMetadata: SharedV3ProviderMetadata | undefined;
}

/**
 * Run a skill via the agent surface. Today the no-tool path is the same
 * single-shot `generateText` call the runner used to make inline; the
 * tool-loop branch is shaped so a future MCP/native-tool enablement (see
 * resolve-tools.ts) plugs in without changing this file's shape — and
 * without changing the skill-runner's call site.
 *
 * Pre-resolution (registry lookup, middleware wrap, providerOptions
 * compose) and post-processing (markdown → tiptap children, audit row
 * write) live in skill-runner.ts. The agent only owns the model call.
 */
export async function runSkillAgent(
  args: SkillAgentArgs,
): Promise<SkillAgentResult> {
  const tools: ToolSet = await resolveTools(args.skill);

  if (Object.keys(tools).length === 0) {
    const result = await generateText({
      model: args.model,
      system: args.systemPrompt,
      prompt: "Run the skill as instructed in the system prompt.",
      output: Output.object({ schema: OUTPUT_SCHEMA }),
      abortSignal: args.signal,
      providerOptions: args.providerOptions,
    });
    return {
      output: result.output,
      usage: result.usage,
      providerMetadata: result.providerMetadata,
    };
  }

  // Future: tool-loop path. ToolLoopAgent supports `output` so the
  // structured-output contract holds across multiple tool-result turns.
  // System prompt goes in `instructions`; providerOptions lives on the
  // constructor settings (it's part of CallSettings on the agent).
  logger.pipeline.info("Running skill via ToolLoopAgent", {
    skill: args.skill.slug,
    toolNames: Object.keys(tools),
  });
  const agent = new ToolLoopAgent({
    model: args.model,
    instructions: args.systemPrompt,
    tools,
    output: Output.object({ schema: OUTPUT_SCHEMA }),
    providerOptions: args.providerOptions,
    // stopWhen defaults to stepCountIs(20) per the SDK.
  });
  const result = await agent.generate({
    prompt: "Run the skill as instructed.",
    abortSignal: args.signal,
  });
  return {
    output: result.output,
    usage: result.usage,
    providerMetadata: result.providerMetadata,
  };
}
