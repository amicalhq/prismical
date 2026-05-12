import { tool } from "ai";
import { z } from "zod";
import type { WriteSectionPayload } from "../skill-context";

export interface CreateReplaceSelectionToolOpts {
  capture: (payload: WriteSectionPayload) => void;
  selectionText: string;
}

export function createReplaceSelectionTool(opts: CreateReplaceSelectionToolOpts) {
  return tool({
    description: `Replace the user's selected text with rewritten markdown. The original selection was: ${JSON.stringify(opts.selectionText)}. Call this exactly once.`,
    inputSchema: z.object({
      markdown: z.string().min(1),
    }),
    execute: async (input) => {
      opts.capture({ markdown: input.markdown });
      return { ok: true };
    },
  });
}
