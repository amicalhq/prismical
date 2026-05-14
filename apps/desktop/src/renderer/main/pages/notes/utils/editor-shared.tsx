// Shared Lexical editor config used by both the note (Yjs-backed raw surface)
// and the artifact (standalone AI Summary surface). Keeping theme, node list,
// and link matchers in one place ensures both editors render content with
// identical styling.
import { useEffect } from "react";
import {
  CodeNode,
  CodeHighlightNode,
  registerCodeHighlighting,
} from "@lexical/code";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { HorizontalRuleNode } from "@lexical/extension";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ArtifactNode } from "@/renderer/main/components/editor/nodes/artifact-node";
import { ArtifactInlineNode } from "@/renderer/main/components/editor/nodes/artifact-inline-node";

export const editorTheme = {
  paragraph: "mb-0.5 font-normal",
  heading: {
    h1: "text-3xl font-medium mt-4 mb-2",
    h2: "text-2xl font-medium mt-3 mb-1.5",
    h3: "text-xl font-medium mt-2 mb-1",
    h4: "text-lg font-medium mt-2 mb-1",
    h5: "text-base font-medium mt-1 mb-0.5",
  },
  quote: "border-l-4 border-border pl-4 italic text-muted-foreground my-1",
  list: {
    ul: "list-disc list-outside pl-6 my-1",
    ol: "list-decimal list-outside pl-6 my-1",
    listitem: "my-0",
    checklist: "list-none ml-0 my-1",
    listitemChecked: "listitemChecked",
    listitemUnchecked: "listitemUnchecked",
    nested: {
      listitem: "list-none",
    },
  },
  code: "bg-muted block px-4 py-3 rounded-lg font-mono text-sm my-2 overflow-x-auto whitespace-pre",
  codeHighlight: {
    atrule: "text-indigo-600 dark:text-indigo-400",
    attr: "text-blue-600 dark:text-blue-400",
    boolean: "text-orange-600 dark:text-orange-400",
    builtin: "text-cyan-600 dark:text-cyan-400",
    cdata: "text-gray-500 dark:text-gray-400",
    char: "text-green-600 dark:text-green-400",
    class: "text-yellow-600 dark:text-yellow-400",
    "class-name": "text-yellow-600 dark:text-yellow-400",
    comment: "text-gray-500 dark:text-gray-400 italic",
    constant: "text-orange-600 dark:text-orange-400",
    deleted: "text-red-600 dark:text-red-400",
    doctype: "text-gray-500 dark:text-gray-400",
    entity: "text-orange-600 dark:text-orange-400",
    function: "text-blue-600 dark:text-blue-400",
    important: "text-red-600 dark:text-red-400 font-bold",
    inserted: "text-green-600 dark:text-green-400",
    keyword: "text-indigo-600 dark:text-indigo-400",
    namespace: "text-gray-500 dark:text-gray-400",
    number: "text-orange-600 dark:text-orange-400",
    operator: "text-gray-600 dark:text-gray-400",
    prolog: "text-gray-500 dark:text-gray-400",
    property: "text-blue-600 dark:text-blue-400",
    punctuation: "text-gray-600 dark:text-gray-400",
    regex: "text-orange-600 dark:text-orange-400",
    selector: "text-green-600 dark:text-green-400",
    string: "text-green-600 dark:text-green-400",
    symbol: "text-orange-600 dark:text-orange-400",
    tag: "text-red-600 dark:text-red-400",
    url: "text-cyan-600 dark:text-cyan-400",
    variable: "text-orange-600 dark:text-orange-400",
  },
  link: "text-indigo-600 dark:text-indigo-400 underline underline-offset-2 cursor-pointer hover:opacity-80",
  text: {
    bold: "font-bold",
    italic: "italic",
    underline: "underline",
    strikethrough: "line-through",
    code: "bg-muted px-1 py-0.5 rounded font-mono text-sm",
  },
  hr: "my-4 border-t border-border",
  artifact: "prismical-artifact-node-theme",
  artifactInline: "prismical-artifact-inline-theme",
};

export const EDITOR_NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
  AutoLinkNode,
  HorizontalRuleNode,
  ArtifactNode,
  ArtifactInlineNode,
];

// URL and email matchers for AutoLinkPlugin
const URL_REGEX =
  /(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z]{2,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

const EMAIL_REGEX =
  /(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/;

export const AUTO_LINK_MATCHERS = [
  (text: string) => {
    const match = text.match(EMAIL_REGEX);
    if (match) {
      const fullMatch = match[0];
      return {
        index: match.index ?? 0,
        length: fullMatch.length,
        text: fullMatch,
        url: `mailto:${fullMatch}`,
      };
    }
    return null;
  },
  (text: string) => {
    const match = text.match(URL_REGEX);
    if (match) {
      const fullMatch = match[0];
      const matchIndex = match.index ?? 0;
      const textBefore = text.slice(0, matchIndex);
      if (textBefore.includes("@")) {
        return null;
      }
      return {
        index: matchIndex,
        length: fullMatch.length,
        text: fullMatch,
        url: fullMatch.startsWith("http") ? fullMatch : `https://${fullMatch}`,
      };
    }
    return null;
  },
];

// Plugin that turns on code syntax highlighting for the active editor.
export function CodeHighlightPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerCodeHighlighting(editor), [editor]);
  return null;
}
