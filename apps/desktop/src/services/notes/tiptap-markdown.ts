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
import { gitHubEmojis, shortcodeToEmoji } from "@tiptap/extension-emoji";
import { buildEditorExtensions } from "./editor-extensions";

// Built once — the schema is pure (no DOM, no editor instance) so it's safe
// to memoize across the whole process.
const schema = getSchema(buildEditorExtensions());

const md = MarkdownIt("commonmark", { html: false }).enable("table");

// Wrap inline children of th/td cells in paragraph tokens so they hydrate
// into TipTap's strict `tableCell`/`tableHeader` schema (which requires
// `block+` content). Without this, prosemirror-markdown's addNode silently
// drops cell content because Node.createAndFill can't materialize a cell
// with raw inline children.
md.core.ruler.after("inline", "wrap-table-cells", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== "th_open" && open.type !== "td_open") continue;
    // Find the matching close at the same nesting level.
    const closeType = open.type === "th_open" ? "th_close" : "td_close";
    let depth = 1;
    let closeIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.type === open.type) depth++;
      else if (t.type === closeType) {
        depth--;
        if (depth === 0) {
          closeIdx = j;
          break;
        }
      }
    }
    if (closeIdx === -1) continue;
    // Empty cell or already wrapped — leave alone.
    if (closeIdx === i + 1 || tokens[i + 1].type === "paragraph_open") {
      continue;
    }
    const pOpen = new state.Token("paragraph_open", "p", 1);
    pOpen.block = true;
    const pClose = new state.Token("paragraph_close", "p", -1);
    pClose.block = true;
    // Splice paragraph_open after the cell-open and paragraph_close before
    // the cell-close.
    tokens.splice(i + 1, 0, pOpen);
    tokens.splice(closeIdx + 1, 0, pClose);
    // Advance past the newly-inserted close so the outer loop doesn't
    // re-scan the same cell.
    i = closeIdx + 1;
  }
  return true;
});

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
    table: { block: "table" },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: "tableRow" },
    th: { block: "tableHeader" },
    td: { block: "tableCell" },
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
  // Emoji nodes only carry the shortcode `name` attribute; the unicode glyph
  // lives in the emoji set itself. Look it up and emit the native character;
  // fall back to `:name:` so unsupported shortcodes survive a round-trip.
  emoji: (state, node) => {
    const name = node.attrs.name as string | undefined;
    if (!name) {
      return;
    }
    const item = shortcodeToEmoji(name, gitHubEmojis);
    if (item?.emoji) {
      state.text(item.emoji, false);
      return;
    }
    state.text(`:${name}:`, false);
  },
  table: (state, node) => {
    const rows: string[] = [];
    let colCount = 0;
    let hasExplicitHeader = false;
    node.forEach((row, _offset, i) => {
      const cells: string[] = [];
      let rowHasHeader = false;
      row.forEach((cell) => {
        if (cell.type.name === "tableHeader") rowHasHeader = true;
        const text = cell.textContent.replace(/\|/g, "\\|").trim() || " ";
        cells.push(text);
      });
      if (i === 0) {
        colCount = cells.length;
        hasExplicitHeader = rowHasHeader;
      }
      rows.push(`| ${cells.join(" | ")} |`);
    });
    if (rows.length === 0) {
      state.closeBlock(node);
      return;
    }
    const sep = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
    if (hasExplicitHeader) {
      state.write([rows[0], sep, ...rows.slice(1)].join("\n"));
    } else {
      // Synthesize an empty header row so the GFM table stays well-formed.
      const emptyHeader = `| ${Array.from({ length: colCount }, () => " ").join(" | ")} |`;
      state.write([emptyHeader, sep, ...rows].join("\n"));
    }
    state.closeBlock(node);
  },
  tableRow: () => {
    // Handled inside the `table` serializer; this entry is required by
    // MarkdownSerializer's type but is never invoked for table-row children.
  },
  tableHeader: () => {
    // Same — consumed by the `table` serializer.
  },
  tableCell: () => {
    // Same.
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
