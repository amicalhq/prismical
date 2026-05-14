// Renderer-side TipTap extension list — wraps `buildEditorExtensions` with
// the lowlight instance, placeholder text, and per-extension Tailwind class
// names. Keeping this in one place ensures the note editor and the artifact
// editor render with identical typography.

import { StarterKit } from "@tiptap/starter-kit";
import { Heading } from "@tiptap/extension-heading";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { createLowlight, common } from "lowlight";
import { mergeAttributes, type Extensions } from "@tiptap/core";
import { ArtifactNode } from "@/renderer/main/components/editor/nodes/artifact-node";
import { ArtifactInlineNode } from "@/renderer/main/components/editor/nodes/artifact-inline-node";
import { ArtifactEscape } from "@/renderer/main/components/editor/artifact-escape-plugin";
import { MARKDOWN_OPTIONS } from "@/services/notes/editor-extensions";

const lowlight = createLowlight(common);

// Per-level heading classes mirror Lexical's theme exactly. TipTap's Heading
// `HTMLAttributes` config is a single bag applied to every level, so we
// extend the extension and pick the class by node.attrs.level in renderHTML.
const HEADING_CLASSES: Record<number, string> = {
  1: "text-3xl font-medium mt-4 mb-2",
  2: "text-2xl font-medium mt-3 mb-1.5",
  3: "text-xl font-medium mt-2 mb-1",
  4: "text-lg font-medium mt-2 mb-1",
  5: "text-base font-medium mt-1 mb-0.5",
};

const ThemedHeading = Heading.extend({
  renderHTML({ node, HTMLAttributes }) {
    const level = (node.attrs.level as number) ?? 1;
    const tag = `h${level}`;
    const themeClass = HEADING_CLASSES[level] ?? HEADING_CLASSES[1];
    return [
      tag,
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: themeClass,
      }),
      0,
    ];
  },
});

interface RendererExtensionsOptions {
  placeholder?: string;
}

export function buildRendererExtensions(
  opts: RendererExtensionsOptions = {},
): Extensions {
  return [
    StarterKit.configure({
      // Replaced by ThemedHeading below — disabling here avoids duplicate
      // heading node registration.
      heading: false,
      codeBlock: false,
      paragraph: { HTMLAttributes: { class: "mb-0.5 font-normal" } },
      blockquote: {
        HTMLAttributes: {
          class: "border-l-4 border-border pl-4 italic text-muted-foreground my-1",
        },
      },
      bulletList: {
        HTMLAttributes: { class: "list-disc list-outside pl-6 my-1" },
      },
      orderedList: {
        HTMLAttributes: { class: "list-decimal list-outside pl-6 my-1" },
      },
      listItem: { HTMLAttributes: { class: "my-0" } },
      horizontalRule: {
        HTMLAttributes: { class: "my-4 border-t border-border" },
      },
      code: {
        HTMLAttributes: {
          class: "bg-muted px-1 py-0.5 rounded font-mono text-sm",
        },
      },
      // Mark classes mirror the old Lexical theme.text.* entries. Tailwind
      // preflight neutralizes some browser defaults, so we apply them
      // explicitly rather than rely on user-agent styling.
      bold: { HTMLAttributes: { class: "font-bold" } },
      italic: { HTMLAttributes: { class: "italic" } },
      strike: { HTMLAttributes: { class: "line-through" } },
      underline: { HTMLAttributes: { class: "underline" } },
      link: {
        HTMLAttributes: {
          class:
            "text-indigo-600 dark:text-indigo-400 underline underline-offset-2 cursor-pointer hover:opacity-80",
        },
        autolink: true,
        protocols: ["http", "https", "mailto"],
        defaultProtocol: "https",
      },
    }),
    ThemedHeading.configure({ levels: [1, 2, 3, 4, 5] }),
    CodeBlockLowlight.configure({
      lowlight,
      HTMLAttributes: {
        class:
          "bg-muted block px-4 py-3 rounded-lg font-mono text-sm my-2 overflow-x-auto whitespace-pre",
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    ArtifactNode,
    ArtifactInlineNode,
    ArtifactEscape,
    Placeholder.configure({
      placeholder: opts.placeholder ?? "",
      emptyEditorClass: "is-editor-empty",
    }),
    Markdown.configure(MARKDOWN_OPTIONS),
  ];
}
