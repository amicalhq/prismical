// Shared TipTap extension list used by the in-editor surface (renderer) and
// the headless markdown converters (main process). Keeping this in one place
// guarantees the schema used to parse skill output matches the schema the
// editor renders — drift here causes silent serialization bugs.

import { StarterKit } from "@tiptap/starter-kit";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Markdown } from "tiptap-markdown";
import { createLowlight } from "lowlight";
import type { Extensions } from "@tiptap/core";
import { ArtifactNode } from "@/renderer/main/components/editor/nodes/artifact-node";
import { ArtifactInlineNode } from "@/renderer/main/components/editor/nodes/artifact-inline-node";
import { ArtifactEscape } from "@/renderer/main/components/editor/artifact-escape-plugin";

// Single tiptap-markdown configuration shared by both the renderer's
// editor and the headless converters. Keep this in lockstep with how
// the renderer surface parses pasted markdown.
export const MARKDOWN_OPTIONS = {
  html: false,
  tightLists: true,
  linkify: false,
  breaks: false,
  transformPastedText: true,
  transformCopiedText: true,
} as const;

// Lowlight instance is constructed lazily to avoid pulling all language
// grammars into the main-process bundle. Callers in the renderer build a
// configured instance; the headless paths get plain code blocks (no syntax
// classes) which is fine — they're only used for skill-output parsing where
// the rendered markdown never gets syntax-highlighted server-side anyway.
// Default to an empty lowlight registry. The renderer passes its own
// (common-languages) instance when building extensions for the live editor;
// headless callers get this no-op highlighter — code blocks still render,
// they just don't get token classes (the renderer adds those at runtime).
const emptyLowlight = createLowlight();

export function buildEditorExtensions(opts?: {
  lowlight?: ReturnType<typeof createLowlight>;
  placeholder?: string;
}): Extensions {
  return [
    StarterKit.configure({
      // Replace the plain code-block with the lowlight-backed one below.
      codeBlock: false,
    }),
    CodeBlockLowlight.configure({
      lowlight: opts?.lowlight ?? emptyLowlight,
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
    Markdown.configure(MARKDOWN_OPTIONS),
  ];
}
