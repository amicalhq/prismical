import type { SkillRunContext } from "./skill-context";

export function buildSystemPrompt(ctx: SkillRunContext): string {
  const lines: string[] = [];
  lines.push(ctx.skill.body.trim());
  lines.push("");
  lines.push(`# Active mode: ${ctx.mode}`);

  if (ctx.mode === "inline-rewrite" && ctx.selectionText) {
    lines.push(`The user's selected text to rewrite:\n${ctx.selectionText}`);
  }

  if (ctx.refineInstruction && ctx.previousOutput) {
    lines.push("");
    lines.push("# Refine context");
    lines.push("Your previous output was:");
    lines.push("```");
    lines.push(ctx.previousOutput);
    lines.push("```");
    lines.push(`The user wants you to revise it: ${ctx.refineInstruction}`);
  }

  return lines.join("\n");
}
