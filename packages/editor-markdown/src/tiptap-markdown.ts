// Markdown <-> TipTap-JSON round-trip against the shared `@prismical/editor-schema` ProseMirror
// schema. Consumed by the web client (skills run/accept + diff "before" side) and the note service
// (the /v1 server-side body-write path). The schema comes from `getEditorSchema()` so it is
// byte-identical to what the collaborative editor and note service mount — no separate extension
// list to drift. DOM-free (pure prosemirror-markdown + markdown-it), so it runs headless on the server.

import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
} from "prosemirror-markdown";
import MarkdownIt from "markdown-it";
import { gitHubEmojis, shortcodeToEmoji } from "@tiptap/extension-emoji";
import { getEditorSchema } from "@prismical/editor-schema";

// Built once — the schema is pure (no DOM, no editor instance) so it's safe to memoize.
const schema = getEditorSchema();

// strikethrough: the serializer has always emitted `~~text~~` for the strike mark, but the
// commonmark preset leaves the rule off — so struck text came BACK as literal tildes after any
// skill round-trip. Enabling it closes the asymmetry.
const md = MarkdownIt("commonmark", { html: false }).enable(["table", "strikethrough"]);

// Wrap inline children of th/td cells in paragraph tokens so they hydrate into TipTap's strict
// `tableCell`/`tableHeader` schema (which requires `block+` content). Without this,
// prosemirror-markdown's addNode silently drops cell content.
md.core.ruler.after("inline", "wrap-table-cells", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (!open) continue;
    if (open.type !== "th_open" && open.type !== "td_open") continue;
    const closeType = open.type === "th_open" ? "th_close" : "td_close";
    let depth = 1;
    let closeIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (!t) continue;
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
    if (closeIdx === i + 1 || tokens[i + 1]?.type === "paragraph_open") continue;
    const pOpen = new state.Token("paragraph_open", "p", 1);
    pOpen.block = true;
    const pClose = new state.Token("paragraph_close", "p", -1);
    pClose.block = true;
    tokens.splice(i + 1, 0, pOpen);
    tokens.splice(closeIdx + 1, 0, pClose);
    i = closeIdx + 1;
  }
  return true;
});

// GitHub task lists: the serializer has always emitted
// `- [x] item` for taskList/taskItem, but nothing parsed it back — so checkboxes returned
// from a skill run (or round-tripped through replace-doc) degraded to plain bullets with
// literal "[ ]" text. This rule renames the tokens of a bullet list whose DIRECT items all
// start with a `[ ]`/`[x]` box into task_list/task_item tokens (checked on `meta`), stripping
// the box from the text. Mixed lists (only some items boxed) are left untouched — TipTap's
// taskList schema can't hold non-task items, and literal boxes beat silently reshuffling the
// user's list.
md.core.ruler.after("inline", "task-lists", (state) => {
  const tokens = state.tokens;
  const BOX = /^\[([ xX])\](?:\s+|$)/;

  // First inline token directly inside the item (level = itemLevel + 2: item > paragraph > inline).
  const firstInlineOfItem = (openIdx: number): number => {
    const open = tokens[openIdx]!;
    for (let j = openIdx + 1; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type === "list_item_close" && t.level === open.level) break;
      if (t.type === "inline" && t.level === open.level + 2) return j;
      // A nested block (another list, a quote) before any text ⇒ not a task row.
      if (t.type !== "paragraph_open" && t.level === open.level + 1) break;
    }
    return -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const listOpen = tokens[i]!;
    if (listOpen.type !== "bullet_list_open") continue;

    // Collect the list's DIRECT items and check every one carries a box.
    const items: Array<{ open: number; inline: number; checked: boolean }> = [];
    let allBoxed = true;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type === "bullet_list_close" && t.level === listOpen.level) break;
      if (t.type !== "list_item_open" || t.level !== listOpen.level + 1) continue;
      const inlineIdx = firstInlineOfItem(j);
      const m = inlineIdx >= 0 ? BOX.exec(tokens[inlineIdx]!.content) : null;
      if (!m) {
        allBoxed = false;
        break;
      }
      items.push({ open: j, inline: inlineIdx, checked: m[1]!.toLowerCase() === "x" });
    }
    if (!allBoxed || items.length === 0) continue;

    // Rename the list + its items; strip the box from each item's leading text.
    listOpen.type = "task_list_open";
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type === "bullet_list_close" && t.level === listOpen.level) {
        t.type = "task_list_close";
        break;
      }
    }
    for (const item of items) {
      const open = tokens[item.open]!;
      open.type = "task_item_open";
      open.meta = { ...(open.meta ?? {}), checked: item.checked };
      for (let j = item.open + 1; j < tokens.length; j++) {
        const t = tokens[j]!;
        if (t.type === "list_item_close" && t.level === open.level) {
          t.type = "task_item_close";
          break;
        }
      }
      const inline = tokens[item.inline]!;
      inline.content = inline.content.replace(BOX, "");
      const firstChild = inline.children?.[0];
      if (firstChild?.type === "text") firstChild.content = firstChild.content.replace(BOX, "");
    }
  }
  return true;
});

// Token-to-node mapping for markdown-it tokens. Names use TipTap's camelCase convention.
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
    softbreak: { ignore: true },
    // markdown-it emits `image` as a self-contained token (nesting: 0), so it needs a single
    // no-op handler (`noCloseToken`) rather than the open/close pair `ignore` defaults to —
    // without this, any markdown containing an image throws "Token type `image` not supported".
    // The schema has no image node, so images are intentionally dropped (alt text included).
    image: { ignore: true, noCloseToken: true },
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
    task_list: { block: "taskList" },
    task_item: {
      block: "taskItem",
      getAttrs: (tok) => ({ checked: (tok.meta as { checked?: boolean } | null)?.checked === true }),
    },
    table: { block: "table" },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: "tableRow" },
    th: { block: "tableHeader" },
    td: { block: "tableCell" },
  },
);

// defaultSerializer for built-ins + our custom node serializers. Artifact wrappers are UNWRAPPED on
// export (children render as native content) so sharing/copy never leaks that AI generated parts.
const serializerNodes: MarkdownSerializer["nodes"] = {
  paragraph: defaultMarkdownSerializer.nodes.paragraph!,
  blockquote: defaultMarkdownSerializer.nodes.blockquote!,
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
  text: defaultMarkdownSerializer.nodes.text!,
  artifact: (state, node) => {
    state.renderContent(node);
  },
  "artifact-inline": (state, node) => {
    state.renderInline(node);
  },
  emoji: (state, node) => {
    const name = node.attrs.name as string | undefined;
    if (!name) return;
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
      const emptyHeader = `| ${Array.from({ length: colCount }, () => " ").join(" | ")} |`;
      state.write([emptyHeader, sep, ...rows].join("\n"));
    }
    state.closeBlock(node);
  },
  tableRow: () => {},
  tableHeader: () => {},
  tableCell: () => {},
};

const serializerMarks: MarkdownSerializer["marks"] = {
  italic: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
  bold: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  // Markdown has no underline syntax. Serialize transparently so the text survives while the
  // mark drops, and keep an explicit entry so underlined text does not make the serializer throw.
  underline: { open: "", close: "", mixable: true, expelEnclosingWhitespace: true },
  code: defaultMarkdownSerializer.marks.code!,
  link: defaultMarkdownSerializer.marks.link!,
};

const serializer = new MarkdownSerializer(serializerNodes, serializerMarks);

export function markdownToTiptapJson(markdown: string): unknown {
  const doc = parser.parse(markdown);
  if (!doc) throw new Error("Failed to parse markdown — parser returned null");
  return doc.toJSON();
}

/** Stringify TipTap JSON (e.g. `editor.getJSON()`) to markdown — the diff "before" side. */
export function tiptapJsonToMarkdown(jsonStringOrObject: string | object): string {
  const json =
    typeof jsonStringOrObject === "string" ? JSON.parse(jsonStringOrObject) : jsonStringOrObject;
  const doc = schema.nodeFromJSON(json);
  return serializer.serialize(doc);
}

/** Parse markdown, return just the doc's top-level children — the `content` payload for
 * insertArtifactBlock / setContent. */
export function markdownToTiptapChildren(markdown: string): object[] {
  const json = markdownToTiptapJson(markdown) as { content?: unknown[] };
  return (json.content ?? []) as object[];
}
