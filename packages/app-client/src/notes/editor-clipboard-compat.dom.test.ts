// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { getEditorSchema } from "@prismical/editor-schema";

/**
 * ProseMirror ALWAYS re-parses pasted HTML — there is no cached-slice shortcut on the paste path
 * the way there is for an in-view drop. So anything the schema renders without a matching parse
 * rule is deleted by cut-and-paste inside the editor, silently.
 *
 * That is a live hazard for the compatibility types, which deliberately render nothing visible.
 * These tests walk a document through serialize -> HTML -> parse, which is what the clipboard does.
 */
const schema = getEditorSchema();

function throughClipboard(json: object): Record<string, unknown> {
  const node = schema.nodeFromJSON(json);
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(node.content);
  const host = document.createElement("div");
  host.appendChild(fragment);
  return DOMParser.fromSchema(schema).parse(host).toJSON() as Record<string, unknown>;
}

describe("clipboard round-trip through the editor's own HTML", () => {
  it("keeps an image node and every one of its attributes", () => {
    // The node renders an empty placeholder; without the data-* attributes and the matching parse
    // rule, cutting a region containing a mobile-authored image deleted it outright.
    const out = throughClipboard({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "https://example.com/a.png",
            alt: "a shot",
            title: "T",
            width: 640,
            height: 480,
          },
        },
      ],
    }) as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> };

    const image = out.content?.find((n) => n.type === "image");
    expect(image).toBeDefined();
    expect(image?.attrs).toMatchObject({
      src: "https://example.com/a.png",
      alt: "a shot",
      title: "T",
      width: 640,
      height: 480,
    });
  });

  it("keeps a numeric-looking alt as TEXT, not a number", () => {
    // Coercing every data-* attribute turned an alt of "2024" into the NUMBER 2024, which the
    // markdown serializer hands to state.esc() — throwing and nulling the whole note's snapshot.
    // Only the dimensions are numeric.
    const out = throughClipboard({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "https://example.com/a.png", alt: "2024", title: "1999", width: 640, height: null },
        },
      ],
    }) as { content?: Array<{ attrs?: Record<string, unknown> }> };

    const attrs = out.content?.[0]?.attrs ?? {};
    expect(attrs.alt).toBe("2024");
    expect(typeof attrs.alt).toBe("string");
    expect(attrs.title).toBe("1999");
    expect(typeof attrs.title).toBe("string");
    expect(attrs.width).toBe(640);
    expect(typeof attrs.width).toBe("number");
  });

  it("keeps an image that sits between other blocks", () => {
    const out = throughClipboard({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        { type: "image", attrs: { src: "https://example.com/a.png" } },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    }) as { content?: Array<{ type?: string }> };

    expect(out.content?.map((n) => n.type)).toEqual(["paragraph", "image", "paragraph"]);
  });

  it("keeps the TEXT under a decoration mark, even though the mark itself does not survive", () => {
    // Decoration is deliberately unparseable — this editor does not offer colour or highlight, and
    // a span-matching rule would import CSS from anything pasted off the web. Losing the decoration
    // on an internal copy is the accepted cost; losing the words would not be.
    const out = throughClipboard({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "plain " },
            { type: "text", text: "tinted", marks: [{ type: "textStyle", attrs: { color: "red" } }] },
            { type: "text", text: " and ", marks: [{ type: "highlight", attrs: { color: "y" } }] },
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });

    expect(JSON.stringify(out)).toContain("plain ");
    expect(JSON.stringify(out)).toContain("tinted");
    expect(JSON.stringify(out)).toContain("bold");
    // The mark markdown and the editor both drop; the bold one is unaffected.
    expect(JSON.stringify(out)).toContain('"bold"');
  });

  it("does not mint an image from foreign HTML", () => {
    const host = document.createElement("div");
    host.innerHTML = '<img src="https://evil.example/x.png"><div>plain div</div>';
    const parsed = JSON.stringify(DOMParser.fromSchema(schema).parse(host).toJSON());
    expect(parsed).not.toContain("image");
    expect(parsed).not.toContain("evil.example");
  });

  it("does not mint a decoration mark from a styled span", () => {
    const host = document.createElement("div");
    host.innerHTML = '<p><span style="color: red; font-size: 40px">imported</span></p>';
    const parsed = JSON.stringify(DOMParser.fromSchema(schema).parse(host).toJSON());
    expect(parsed).toContain("imported");
    expect(parsed).not.toContain("textStyle");
    expect(parsed).not.toContain("40px");
  });
});
