import type { SerializedLexicalNode } from "lexical";
import { markdownToLexicalStateJson } from "@/services/notes/markdown-to-lexical";
import { logger } from "@/main/logger";

interface LexicalBlockLike {
  type?: string;
  children?: SerializedLexicalNode[];
}

// Converts the model's markdown emission into a Lexical *block* children array
// — paragraphs, headings, lists, etc. Used by `append-section` and
// `replace-doc` modes, where the artifact wrapper is a block-level container.
//
// Returns an empty array on parse failure; callers handle that as a SkillRunError.
// Parse errors are logged via the pipeline logger so support can diagnose
// malformed model output (the SkillRunError thrown downstream just says
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

// Converts the model's markdown emission into a Lexical *inline* children
// array — text nodes, link nodes, etc. — suitable for nesting inside an
// `ArtifactInlineNode`. An inline wrapper can only contain inline content;
// putting paragraphs/headings inside would corrupt Lexical's tree invariants.
//
// Contract for inline-rewrite skills: emit a single paragraph (or plain text).
// If the model emits multiple blocks or a non-paragraph block (heading, list,
// code), we reject with `[]` so the runner surfaces a SkillRunError — the user
// sees "couldn't run X — model returned unexpected output" and can retry.
export function markdownToInlineChildren(
  markdown: string,
): SerializedLexicalNode[] {
  if (!markdown || markdown.trim() === "") return [];
  try {
    const stateJson = markdownToLexicalStateJson(markdown);
    const parsed = JSON.parse(stateJson);
    const blocks = parsed?.root?.children as LexicalBlockLike[] | undefined;
    if (!Array.isArray(blocks) || blocks.length === 0) return [];

    if (blocks.length > 1) {
      logger.pipeline.warn(
        "markdownToInlineChildren rejecting multi-block output",
        { blockCount: blocks.length, markdownPreview: markdown.slice(0, 200) },
      );
      return [];
    }

    const only = blocks[0];
    if (only.type !== "paragraph") {
      logger.pipeline.warn(
        "markdownToInlineChildren rejecting non-paragraph block",
        { blockType: only.type, markdownPreview: markdown.slice(0, 200) },
      );
      return [];
    }

    const inlineChildren = only.children;
    if (!Array.isArray(inlineChildren) || inlineChildren.length === 0) {
      return [];
    }
    return inlineChildren;
  } catch (err) {
    logger.pipeline.warn("markdownToInlineChildren parse failed", {
      error: err instanceof Error ? err.message : String(err),
      markdownPreview: markdown.slice(0, 200),
    });
    return [];
  }
}
