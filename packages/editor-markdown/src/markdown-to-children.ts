import type { JSONContent } from "@tiptap/core";
import { markdownToTiptapJson } from "./tiptap-markdown.js";

// Converts the model's markdown emission into a TipTap *block* children array — paragraphs,
// headings, lists, etc. Used by append-section (artifact wrapper children) and replace-doc (the new
// doc content). Returns [] on parse failure; callers surface that as a "couldn't run" error rather
// than crashing the editor.
export function markdownToChildren(markdown: string): JSONContent[] {
  if (!markdown || markdown.trim() === "") return [];
  try {
    const doc = markdownToTiptapJson(markdown) as { content?: JSONContent[] };
    const children = doc?.content;
    if (!Array.isArray(children)) return [];
    return children;
  } catch (err) {
    console.warn(
      "markdownToChildren parse failed",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

// Converts the model's markdown emission into a TipTap *inline* children array — text/link nodes —
// suitable for nesting inside the artifact-inline wrapper (whose content model is `inline*`;
// putting a paragraph or heading inside would corrupt the schema).
//
// Contract for inline-rewrite skills: emit a single paragraph. Multi-block or
// non-paragraph output (heading, list, code) is rejected with [] so the caller surfaces a
// "returned unexpected output" error instead of silently mangling the note.
export function markdownToInlineChildren(markdown: string): JSONContent[] {
  if (!markdown || markdown.trim() === "") return [];
  try {
    const doc = markdownToTiptapJson(markdown) as { content?: JSONContent[] };
    const blocks = doc?.content;
    if (!Array.isArray(blocks) || blocks.length === 0) return [];

    if (blocks.length > 1) {
      console.warn("markdownToInlineChildren rejecting multi-block output", blocks.length);
      return [];
    }

    const only = blocks[0];
    if (only?.type !== "paragraph") {
      console.warn("markdownToInlineChildren rejecting non-paragraph block", only?.type);
      return [];
    }

    const inlineChildren = only.content;
    if (!Array.isArray(inlineChildren) || inlineChildren.length === 0) return [];
    return inlineChildren;
  } catch (err) {
    console.warn(
      "markdownToInlineChildren parse failed",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
