import { tool } from "ai";
import { z } from "zod";
import type { WriteSectionPayload } from "../skill-context";

// `write_section` is a "captures the final answer" tool. The runner injects
// a `captureCallback` closure that the tool's `execute` calls with the
// markdown. After capture, returns "Section written" so the agent loop
// has confirmation and can terminate.
//
// The runner uses presence-of-capture as the loop-exit signal; we don't
// rely on the model's text response after this tool.

export interface CreateWriteSectionToolOpts {
  capture: (payload: WriteSectionPayload) => void;
  // Hint to the agent — embedded in the tool's description so the model
  // emits the right kind of content for the active mode.
  mode: "append-section" | "replace-doc";
}

export function createWriteSectionTool(opts: CreateWriteSectionToolOpts) {
  const modeHint =
    opts.mode === "append-section"
      ? "Append a new section to the note."
      : "Replace the entire note body.";
  return tool({
    description: `Write the final output for this skill run as markdown. ${modeHint} Call this exactly once.`,
    inputSchema: z.object({
      markdown: z
        .string()
        .min(1)
        .describe("The markdown content the user will see."),
    }),
    execute: async (input) => {
      opts.capture({ markdown: input.markdown });
      return { ok: true };
    },
  });
}
