import type { SkillRunContext } from "./skill-context";
import type { SkillInput } from "./collect-input";

// Compose the system prompt sent to the model. The skill author's body is the
// star of the show; everything else is structured context the model needs to
// transform the note. The model returns a single JSON object matching the
// runner's output schema — no tool calls, no agentic decisions.
export function buildSystemPrompt(
  ctx: SkillRunContext,
  input: SkillInput,
): string {
  // Mode-agnostic skills want the model to produce a self-contained chunk
  // that the user can position (append vs replace) post-run via the diff
  // action bar. Inline-rewrite is exempted: inline output is single-paragraph
  // only and the model needs the explicit guidance to honour that constraint.
  const skipModeBlock =
    ctx.skill.config.modeAgnosticPrompt === true &&
    ctx.mode !== "inline-rewrite";

  const out: string[] = [];

  out.push(ctx.skill.body.trim());
  out.push("");
  if (!skipModeBlock) {
    out.push(`# Active mode: ${ctx.mode}`);
    out.push(modeGuidance(ctx.mode));
  }

  if (input.noteMarkdown.trim().length > 0) {
    out.push("");
    out.push("# Note (markdown)");
    out.push(input.noteMarkdown);
  } else {
    out.push("");
    out.push("# Note");
    out.push("(empty — no content yet)");
  }

  if (ctx.mode === "inline-rewrite" && input.selectionText) {
    out.push("");
    out.push("# Selected text to rewrite");
    out.push(input.selectionText);
  }

  // Gate transcript on the skill's explicit input policy. Default is OFF —
  // cleanup-style skills that only ever look at the note must not see the
  // transcript, because once it's in-context "don't use it" is just a hint
  // the model can ignore.
  if (input.transcript && ctx.skill.config.inputs?.transcript === true) {
    out.push("");
    out.push("# Meeting transcript");
    out.push(input.transcript);
  }

  if (ctx.refineInstruction && ctx.previousOutput) {
    out.push("");
    out.push("# Refine context");
    out.push("Your previous output was:");
    out.push("```");
    out.push(ctx.previousOutput);
    out.push("```");
    out.push(`The user wants you to revise it: ${ctx.refineInstruction}`);
  }

  out.push("");
  out.push("# Output");
  if (skipModeBlock) {
    out.push(
      'Return JSON matching the provided schema: { "markdown": "<your output>" }. ' +
        "The markdown will be inserted into the note as-is.",
    );
  } else {
    out.push(
      'Return JSON matching the provided schema: { "markdown": "<your output>" }. ' +
        "The markdown will be inserted into the note as-is based on the active " +
        "mode — append-section appends a new block, replace-doc replaces the " +
        "whole note, inline-rewrite replaces just the selected text.",
    );
  }

  return out.join("\n");
}

function modeGuidance(mode: SkillRunContext["mode"]): string {
  switch (mode) {
    case "append-section":
      return "Produce a new section to append to the note. Start with a heading.";
    case "replace-doc":
      return "Produce a complete replacement for the note's body.";
    case "inline-rewrite":
      return "Produce a rewrite of the selected text only. Do not include surrounding context.";
  }
}
