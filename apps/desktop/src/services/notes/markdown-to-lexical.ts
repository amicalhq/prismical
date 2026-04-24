import { createEditor } from "lexical";
import { $convertFromMarkdownString, TRANSFORMERS } from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { LinkNode, AutoLinkNode } from "@lexical/link";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";

// Node set mirrors what the renderer's NoteEditor registers, so the
// serialized state deserializes cleanly in the client editor.
const NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  AutoLinkNode,
  CodeNode,
  CodeHighlightNode,
  HorizontalRuleNode,
];

// Converts a markdown string (as produced by the AI generation pipeline)
// into a Lexical editor state JSON string, suitable for storing in
// `note_artifacts.content` and rendering directly in the client editor.
// Runs headless — no DOM required — via lexical core's createEditor.
export function markdownToLexicalStateJson(markdown: string): string {
  const editor = createEditor({
    namespace: "artifact-markdown-conv",
    nodes: NODES,
    onError: (error) => {
      throw error;
    },
  });

  editor.update(
    () => {
      $convertFromMarkdownString(markdown, TRANSFORMERS);
    },
    { discrete: true },
  );

  return JSON.stringify(editor.getEditorState().toJSON());
}
