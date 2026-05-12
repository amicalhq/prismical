import type { SerializedLexicalNode } from "lexical";
import { markdownToLexicalStateJson } from "@/services/notes/markdown-to-lexical";
import { logger } from "@/main/logger";

// Converts the agent's markdown emission into a Lexical children array
// suitable for Plan 2's INSERT_ARTIFACT_NODE_COMMAND.content payload.
//
// Returns an empty array on parse failure; callers handle that as a SkillRunError.
// Parse errors are logged via the pipeline logger so support can diagnose
// malformed agent output (the SkillRunError thrown downstream just says
// "empty content" without preserving the original cause).
export function markdownToChildren(markdown: string): SerializedLexicalNode[] {
  if (!markdown || markdown.trim() === "") return [];
  try {
    const stateJson = markdownToLexicalStateJson(markdown);
    const parsed = JSON.parse(stateJson);
    const children = parsed?.root?.children;
    if (!Array.isArray(children)) return [];
    return children as SerializedLexicalNode[];
  } catch (err) {
    logger.pipeline.warn("markdownToChildren parse failed", {
      error: err instanceof Error ? err.message : String(err),
      markdownPreview: markdown.slice(0, 200),
    });
    return [];
  }
}
