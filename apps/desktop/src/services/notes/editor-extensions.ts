// Shared TipTap extension list used by the in-editor surface (renderer) and
// the headless markdown converters (main process). Keeping this in one place
// guarantees the schema used to parse skill output matches the schema the
// editor renders — drift here causes silent serialization bugs.

import { StarterKit } from "@tiptap/starter-kit";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Markdown } from "tiptap-markdown";
import type { Extensions } from "@tiptap/core";
import { ArtifactNode } from "@/renderer/main/components/editor/nodes/artifact-node";
import { ArtifactInlineNode } from "@/renderer/main/components/editor/nodes/artifact-inline-node";
import { ArtifactEscape } from "@/renderer/main/components/editor/artifact-escape-plugin";

// Lowlight instance is constructed lazily to avoid pulling all language
// grammars into the main-process bundle. Callers in the renderer build a
// configured instance; the headless paths get plain code blocks (no syntax
// classes) which is fine — they're only used for skill-output parsing where
// the rendered markdown never gets syntax-highlighted server-side anyway.
export function buildEditorExtensions(opts?: {
  // null = plain code blocks, no syntax classes.
  lowlight?: unknown;
  placeholder?: string;
}): Extensions {
  return [
    StarterKit.configure({
      // Replace the plain code-block with the lowlight-backed one below.
      codeBlock: false,
    }),
    CodeBlockLowlight.configure({
      lowlight: opts?.lowlight,
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    ArtifactNode,
    ArtifactInlineNode,
    ArtifactEscape,
    // tiptap-markdown must come AFTER all schema-contributing extensions
    // so it can attach its `addStorage().markdown` overrides cleanly.
    Markdown.configure({
      html: false,
      tightLists: true,
      linkify: false,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
  ];
}
