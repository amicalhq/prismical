import type { SerializedLexicalNode } from "lexical";
import { markdownToLexicalStateJson } from "@/services/notes/markdown-to-lexical";

// Converts the agent's markdown emission into a Lexical children array
// suitable for Plan 2's INSERT_ARTIFACT_NODE_COMMAND.content payload.
//
// Returns an empty array on parse failure; callers handle that as a SkillRunError.
export function markdownToChildren(markdown: string): SerializedLexicalNode[] {
  if (!markdown || markdown.trim() === "") return [];
  try {
    const stateJson = markdownToLexicalStateJson(markdown);
    const parsed = JSON.parse(stateJson);
    const children = parsed?.root?.children;
    if (!Array.isArray(children)) return [];
    return children as SerializedLexicalNode[];
  } catch {
    return [];
  }
}
