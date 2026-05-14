// Headless markdown round-trip used by main-process code (skill runtime,
// tRPC routers for export). Bypasses tiptap-markdown's DOM-dependent parser
// by talking to prosemirror-markdown directly. The schema is constructed
// from the same TipTap extensions the renderer mounts, so doc shapes stay
// identical across the boundary.

import { getSchema } from "@tiptap/core";
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
} from "prosemirror-markdown";
import MarkdownIt from "markdown-it";
import { buildEditorExtensions } from "./editor-extensions";

// Built once — the schema is pure (no DOM, no editor instance) so it's safe
// to memoize across the whole process.
const schema = getSchema(buildEditorExtensions());

const md = MarkdownIt("commonmark", { html: false });

// Token-to-node mapping for markdown-it tokens. Node/mark names use TipTap's
// camelCase convention (NOT prosemirror-markdown's defaultParser snake_case).
// The cast bridges duplicate `@types/markdown-it` copies that pnpm nests
// under prosemirror-markdown — the runtime classes are identical.
const parser = new MarkdownParser(
  schema,
  md as ConstructorParameters<typeof MarkdownParser>[1],
  {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    list_item: { block: "listItem" },
    bullet_list: { block: "bulletList", getAttrs: () => ({}) },
    ordered_list: {
      block: "orderedList",
      getAttrs: (tok) => ({ start: Number(tok.attrGet("start") ?? "1") || 1 }),
    },
    heading: {
      block: "heading",
      getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }),
    },
    code_block: { block: "codeBlock", noCloseToken: true },
    fence: {
      block: "codeBlock",
      getAttrs: (tok) => ({ language: tok.info || null }),
      noCloseToken: true,
    },
    hr: { node: "horizontalRule" },
    hardbreak: { node: "hardBreak" },
    // markdown-it emits `softbreak` for line breaks inside paragraphs. We
    // ignore them (no visible break) — matches HTML convention where wrapped
    // markdown lines collapse to a single space. Without this entry,
    // MarkdownParser throws on any input containing a wrapped paragraph.
    softbreak: { ignore: true },
    // No image extension installed yet — drop images silently rather than
    // throwing. Revisit if/when the editor gains image support.
    image: { ignore: true },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    s: { mark: "strike" },
    link: {
      mark: "link",
      getAttrs: (tok) => ({
        href: tok.attrGet("href"),
        title: tok.attrGet("title") || null,
      }),
    },
    code_inline: { mark: "code", noCloseToken: true },
  },
);

// Reuse prosemirror-markdown's defaultSerializer for built-in nodes, then
// add our custom node serializers. Artifact wrappers are unwrapped on
// export to preserve the existing behavior (sharing a note never leaks
// that AI generated parts of it).
const serializerNodes: MarkdownSerializer["nodes"] = {
  paragraph: defaultMarkdownSerializer.nodes.paragraph,
  blockquote: defaultMarkdownSerializer.nodes.blockquote,
  bulletList: (state, node) => {
    state.renderList(node, "  ", () => "- ");
  },
  orderedList: (state, node) => {
    const start = (node.attrs.start as number | null) ?? 1;
    const maxW = String(start + node.childCount - 1).length;
    const pad = " ".repeat(maxW + 2);
    state.renderList(node, pad, (i) => {
      const nStr = String(start + i);
      return `${" ".repeat(maxW - nStr.length)}${nStr}. `;
    });
  },
  listItem: (state, node) => state.renderContent(node),
  taskList: (state, node) => {
    state.renderList(node, "  ", () => "- ");
  },
  taskItem: (state, node) => {
    const box = node.attrs.checked ? "[x]" : "[ ]";
    state.write(`${box} `);
    state.renderContent(node);
  },
  heading: (state, node) => {
    state.write(`${"#".repeat(node.attrs.level as number)} `);
    state.renderInline(node);
    state.closeBlock(node);
  },
  codeBlock: (state, node) => {
    const lang = (node.attrs.language as string | null) ?? "";
    state.write(`\`\`\`${lang}\n`);
    state.text(node.textContent, false);
    state.ensureNewLine();
    state.write("```");
    state.closeBlock(node);
  },
  horizontalRule: (state, node) => {
    state.write("---");
    state.closeBlock(node);
  },
  hardBreak: (state) => state.write("\\\n"),
  text: defaultMarkdownSerializer.nodes.text,
  // Artifact wrappers are unwrapped on export — children render as if they
  // were native top-level content.
  artifact: (state, node) => {
    state.renderContent(node);
  },
  "artifact-inline": (state, node) => {
    state.renderInline(node);
  },
};

const serializerMarks: MarkdownSerializer["marks"] = {
  italic: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
  bold: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  code: defaultMarkdownSerializer.marks.code,
  link: defaultMarkdownSerializer.marks.link,
};

const serializer = new MarkdownSerializer(serializerNodes, serializerMarks);

export function markdownToTiptapJson(markdown: string): unknown {
  const doc = parser.parse(markdown);
  if (!doc) {
    throw new Error("Failed to parse markdown — parser returned null");
  }
  return doc.toJSON();
}

// Stringify TipTap JSON (as stored in the DB) to markdown.
export function tiptapJsonToMarkdown(jsonStringOrObject: string | object): string {
  const json =
    typeof jsonStringOrObject === "string"
      ? JSON.parse(jsonStringOrObject)
      : jsonStringOrObject;
  const doc = schema.nodeFromJSON(json);
  return serializer.serialize(doc);
}

// Convenience: parses markdown, returns just the doc's top-level children
// as plain JSON objects. Used by the skill runtime to produce the `content`
// payload for the insertArtifactBlock / insertArtifactInline commands.
export function markdownToTiptapChildren(markdown: string): object[] {
  const json = markdownToTiptapJson(markdown) as { content?: unknown[] };
  return (json.content ?? []) as object[];
}
