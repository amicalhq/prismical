import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { buildEditorExtensions } from "@/services/notes/editor-extensions";
import {
  tiptapJsonToMarkdown,
  markdownToTiptapJson,
} from "@/services/notes/tiptap-markdown";

const schema = getSchema(buildEditorExtensions());

describe("editor/tables markdown round-trip", () => {
  it("exports a 2x2 table with a header row as a GFM pipe table", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.table.create(null, [
        schema.nodes.tableRow.create(null, [
          schema.nodes.tableHeader.create(null, [
            schema.nodes.paragraph.create(null, schema.text("A")),
          ]),
          schema.nodes.tableHeader.create(null, [
            schema.nodes.paragraph.create(null, schema.text("B")),
          ]),
        ]),
        schema.nodes.tableRow.create(null, [
          schema.nodes.tableCell.create(null, [
            schema.nodes.paragraph.create(null, schema.text("1")),
          ]),
          schema.nodes.tableCell.create(null, [
            schema.nodes.paragraph.create(null, schema.text("2")),
          ]),
        ]),
      ]),
    ]);
    const md = tiptapJsonToMarkdown(doc.toJSON());
    expect(md.trim()).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("exports a headerless 1-row table with a synthesized empty header", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.table.create(null, [
        schema.nodes.tableRow.create(null, [
          schema.nodes.tableCell.create(null, [
            schema.nodes.paragraph.create(null, schema.text("x")),
          ]),
          schema.nodes.tableCell.create(null, [
            schema.nodes.paragraph.create(null, schema.text("y")),
          ]),
        ]),
      ]),
    ]);
    const md = tiptapJsonToMarkdown(doc.toJSON());
    expect(md.trim()).toBe("|   |   |\n| --- | --- |\n| x | y |");
  });

  it("imports a GFM pipe table into a table node with header + body rows", () => {
    const md = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const json = markdownToTiptapJson(md) as {
      content?: Array<{
        type?: string;
        content?: Array<{
          type?: string;
          content?: Array<{
            type?: string;
            content?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
          }>;
        }>;
      }>;
    };
    const table = json.content?.[0];
    expect(table?.type).toBe("table");
    const rows = table?.content ?? [];
    expect(rows).toHaveLength(2);

    const [headerRow, bodyRow] = rows;
    expect(headerRow.content).toHaveLength(2);
    expect(headerRow.content?.[0].type).toBe("tableHeader");
    expect(headerRow.content?.[1].type).toBe("tableHeader");
    expect(bodyRow.content?.[0].type).toBe("tableCell");
    expect(bodyRow.content?.[1].type).toBe("tableCell");

    // Each cell wraps a paragraph containing the expected text.
    expect(headerRow.content?.[0].content?.[0].type).toBe("paragraph");
    expect(headerRow.content?.[0].content?.[0].content?.[0].text).toBe("A");
    expect(headerRow.content?.[1].content?.[0].content?.[0].text).toBe("B");
    expect(bodyRow.content?.[0].content?.[0].content?.[0].text).toBe("1");
    expect(bodyRow.content?.[1].content?.[0].content?.[0].text).toBe("2");
  });

  it("round-trips a 2x2 table through markdown without losing content", () => {
    const original = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const json = markdownToTiptapJson(original);
    const reExported = tiptapJsonToMarkdown(json as object);
    expect(reExported.trim()).toBe(original);
  });
});
