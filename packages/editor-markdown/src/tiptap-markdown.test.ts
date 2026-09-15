import { describe, it, expect } from "vitest";
import {
  markdownToTiptapJson,
  tiptapJsonToMarkdown,
  markdownToTiptapChildren,
} from "./tiptap-markdown.js";
import { markdownToChildren, markdownToInlineChildren } from "./markdown-to-children.js";
import { getEditorSchema } from "@prismical/editor-schema";

describe("tiptap-markdown", () => {
  it("parses headings + lists into the shared schema's node names", () => {
    const json = markdownToTiptapJson("## Summary\n\n- one\n- two") as {
      type: string;
      content: Array<{ type: string; attrs?: { level?: number } }>;
    };
    expect(json.type).toBe("doc");
    expect(json.content[0]?.type).toBe("heading");
    expect(json.content[0]?.attrs?.level).toBe(2);
    expect(json.content[1]?.type).toBe("bulletList");
  });

  it("round-trips markdown through the doc and back", () => {
    const md = "## Summary\n\n- First key point\n- Second key point";
    const back = tiptapJsonToMarkdown(markdownToTiptapJson(md) as object).trim();
    expect(back).toContain("## Summary");
    expect(back).toContain("- First key point");
    expect(back).toContain("- Second key point");
  });

  it("markdownToTiptapChildren returns the top-level block children", () => {
    const children = markdownToTiptapChildren("# Title\n\nA paragraph.");
    expect(children).toHaveLength(2);
    expect((children[0] as { type: string }).type).toBe("heading");
    expect((children[1] as { type: string }).type).toBe("paragraph");
  });

  it("markdownToChildren returns [] for empty input (caller surfaces an error)", () => {
    expect(markdownToChildren("")).toEqual([]);
    expect(markdownToChildren("   ")).toEqual([]);
  });

  it("drops an image sitting inside a sentence, keeping the sentence", () => {
    // The schema's image node is a BLOCK node, so an image mid-paragraph has nowhere to go.
    // Losing the image beats mangling the paragraph around it; the words must survive either way.
    const children = markdownToTiptapChildren("Before ![alt](http://x/y.png) after.");
    expect(children).toHaveLength(1);
    const text = JSON.stringify(children);
    expect(text).toContain("Before");
    expect(text).toContain("after.");
    expect(text).not.toContain("y.png");
  });

  it("does not parse markdown images back into image nodes", () => {
    // The node exists for compatibility with bodies written elsewhere; markdown must not mint one.
    // markdown-it emits images INLINE and the node is BLOCK, and every scheme for reconciling that
    // mangles neighbouring content in lists, table cells and headings.
    expect(JSON.stringify(markdownToTiptapChildren("![just an image](http://x/y.png)"))).not.toContain(
      "image",
    );
  });

  it("preserves bold/italic marks across the round-trip", () => {
    const back = tiptapJsonToMarkdown(
      markdownToTiptapJson("A **bold** and *italic* line.") as object,
    );
    expect(back).toContain("**bold**");
    expect(back).toContain("*italic*");
  });

  describe("task lists", () => {
    it("parses - [ ] / - [x] into taskList/taskItem with checked attrs", () => {
      const json = markdownToTiptapJson("- [ ] buy milk\n- [x] ship it") as {
        content: Array<{
          type: string;
          content: Array<{ type: string; attrs?: { checked?: boolean } }>;
        }>;
      };
      expect(json.content[0]?.type).toBe("taskList");
      const items = json.content[0]!.content;
      expect(items.map((i) => i.type)).toEqual(["taskItem", "taskItem"]);
      expect(items[0]?.attrs?.checked).toBe(false);
      expect(items[1]?.attrs?.checked).toBe(true);
      // The box must be stripped from the text, not kept as literal "[ ]".
      expect(JSON.stringify(json)).not.toContain("[ ]");
      expect(JSON.stringify(json)).toContain("buy milk");
    });

    it("round-trips checkboxes through the doc and back", () => {
      const md = "- [ ] buy milk\n- [x] ship it";
      const back = tiptapJsonToMarkdown(markdownToTiptapJson(md) as object).trim();
      expect(back).toContain("- [ ] buy milk");
      expect(back).toContain("- [x] ship it");
    });

    it("leaves MIXED lists as plain bullets (taskList can't hold non-task items)", () => {
      const json = markdownToTiptapJson("- [ ] a task\n- a plain bullet") as {
        content: Array<{ type: string }>;
      };
      expect(json.content[0]?.type).toBe("bulletList");
      expect(JSON.stringify(json)).toContain("[ ] a task"); // literal box preserved
    });

    it("keeps marks inside task text", () => {
      const json = markdownToTiptapJson("- [x] **done** thing");
      const s = JSON.stringify(json);
      expect(s).toContain('"taskItem"');
      expect(s).toContain('"bold"');
      expect(s).not.toContain("[x]");
    });
  });

  describe("underline mark", () => {
    it("serializes underlined text transparently instead of throwing", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "keep " },
              { type: "text", text: "this", marks: [{ type: "underline" }] },
            ],
          },
        ],
      };
      expect(() => tiptapJsonToMarkdown(doc)).not.toThrow();
      expect(tiptapJsonToMarkdown(doc).trim()).toBe("keep this");
    });
  });

  // The trap this catches: prosemirror-markdown throws "No mark serializer for <name>" for any mark
  // it has no entry for, and that failure takes the WHOLE snapshot down — the note store logs a
  // warning and stores content_markdown null for the entire body, not just the marked run. Adding a
  // mark to the shared schema without an entry here is a one-line change with that consequence, so
  // assert the coverage rather than trusting the next author to remember.
  describe("every schema mark is serializable", () => {
    // Only marks whose serializer reads an attribute need one; everything else takes its defaults.
    const REQUIRED_ATTRS: Record<string, object> = { link: { href: "https://example.com" } };

    it.each(Object.keys(getEditorSchema().marks))("serializes the %s mark", (mark) => {
      const marks = [{ type: mark, attrs: REQUIRED_ATTRS[mark] ?? {} }];
      const doc = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "covered", marks }] }],
      };
      expect(() => tiptapJsonToMarkdown(doc)).not.toThrow();
      expect(tiptapJsonToMarkdown(doc)).toContain("covered");
    });
  });

  // The node-side sibling of the mark guard above, and the same trap: a node with no serializer
  // entry throws and takes the whole snapshot to null, not just that node.
  describe("every schema node is serializable", () => {
    // Deliberately does NOT supply a src for image: the schema default is null, and a serializer
    // that assumes otherwise throws and nulls the whole note's snapshot.
    const LEAF_ATTRS: Record<string, object> = { emoji: { name: "smile" } };
    const SKIP = ["doc", "text"]; // structural, never serialized on their own

    const schema = getEditorSchema();
    const names = Object.keys(schema.nodes).filter((n) => !SKIP.includes(n));

    it.each(names)("serializes the %s node", (name) => {
      const type = schema.nodes[name]!;
      const node = type.createAndFill(LEAF_ATTRS[name] ?? undefined);
      expect(node).not.toBeNull();
      const doc = type.isBlock
        ? { type: "doc", content: [node!.toJSON()] }
        : { type: "doc", content: [{ type: "paragraph", content: [node!.toJSON()] }] };
      expect(() => tiptapJsonToMarkdown(doc)).not.toThrow();
    });
  });

  describe("highlight mark", () => {
    it("serializes highlighted text transparently — markdown has no marker pen", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "keep " },
              { type: "text", text: "this", marks: [{ type: "highlight", attrs: { color: "yellow" } }] },
            ],
          },
        ],
      };
      expect(tiptapJsonToMarkdown(doc).trim()).toBe("keep this");
    });
  });

  describe("image node", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "https://example.com/a.png", alt: "a shot", title: null } },
      ],
    };

    it("emits real markdown image syntax", () => {
      expect(tiptapJsonToMarkdown(doc).trim()).toBe("![a shot](https://example.com/a.png)");
    });

    it("closes its block so the next block is not glued onto the image line", () => {
      // prosemirror-markdown's own image serializer is written for an INLINE image and never calls
      // closeBlock. Used as a block serializer it emits "![a](x.png)# Heading", and re-parsing that
      // destroys BOTH the image and the heading.
      const withNeighbour = {
        type: "doc",
        content: [
          { type: "image", attrs: { src: "https://example.com/a.png", alt: "a", title: null } },
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Heading" }] },
        ],
      };
      const md = tiptapJsonToMarkdown(withNeighbour);
      expect(md).toContain("![a](https://example.com/a.png)\n");
      expect(md).not.toContain(".png)# Heading");
      // And the heading still survives a re-parse.
      const back = markdownToTiptapJson(md) as { content?: Array<{ type?: string }> };
      expect(back.content?.some((n) => n.type === "heading")).toBe(true);
    });

    it("does not throw when an attribute is not a string", () => {
      // These values come from documents other clients wrote. A number reaching state.esc throws
      // "str.replace is not a function", which nulls the WHOLE note's markdown snapshot.
      const numeric = {
        type: "doc",
        content: [
          { type: "image", attrs: { src: "https://x/a.png", alt: 2024, title: 1999, width: 640 } },
        ],
      };
      expect(() => tiptapJsonToMarkdown(numeric)).not.toThrow();
      expect(tiptapJsonToMarkdown(numeric)).toContain("2024");
    });

    it("does not throw on the schema's null src default", () => {
      // A null src nulls the WHOLE note's markdown snapshot if the serializer throws.
      const bare = { type: "doc", content: [{ type: "image", attrs: {} }] };
      expect(() => tiptapJsonToMarkdown(bare)).not.toThrow();
    });

    it("wraps a src containing spaces or parentheses so the link does not break", () => {
      const awkward = {
        type: "doc",
        content: [{ type: "image", attrs: { src: "https://x/a b(c).png", alt: null, title: null } }],
      };
      expect(tiptapJsonToMarkdown(awkward).trim()).toBe("![](<https://x/a b(c).png>)");
    });

    it("keeps a data: URI intact — the writing client allows base64", () => {
      const inline = {
        type: "doc",
        content: [{ type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=", alt: null, title: null } }],
      };
      expect(tiptapJsonToMarkdown(inline)).toContain("data:image/png;base64,iVBORw0KGgo=");
    });
  });

  // An earlier attempt at this parsed markdown images back into the block `image` node, using a
  // markdown-it rule that promoted image-only paragraphs. Every case below lost content under that
  // design. They are kept as a fence: markdown must not mint an image, and must not let one disturb
  // the structure around it.
  describe("markdown images never disturb their surroundings", () => {
    it("adjacent image lines leave the surrounding text intact", () => {
      expect(JSON.stringify(markdownToTiptapJson("![a](1.png)\n![b](2.png)"))).not.toContain("image");
    });

    it("does not fabricate a task list out of text following an image", () => {
      const json = JSON.stringify(markdownToTiptapJson("- ![a](i.png)[x] item\n- ![b](j.png)[ ] other"));
      expect(json).not.toContain("taskList");
      expect(json).toContain("item");
      expect(json).toContain("other");
    });

    it("keeps an image-bearing list item inside its list", () => {
      const json = markdownToTiptapJson("- ![a](1.png)\n- plain") as {
        content: Array<{ type: string }>;
      };
      expect(json.content).toHaveLength(1);
      expect(json.content[0]?.type).toBe("bulletList");
      expect(JSON.stringify(json)).toContain("plain");
    });

    it("keeps a table whose cell holds only an image", () => {
      const json = markdownToTiptapJson("| h |\n| --- |\n| ![a](1.png) |") as {
        content: Array<{ type: string }>;
      };
      expect(json.content[0]?.type).toBe("table");
    });

    it("keeps a heading whose content is only an image", () => {
      const json = markdownToTiptapJson("# ![a](1.png)") as { content: Array<{ type: string }> };
      expect(json.content[0]?.type).toBe("heading");
    });
  });

  describe("textStyle mark", () => {
    const styled = (attrs: object) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "keep " },
            { type: "text", text: "this", marks: [{ type: "textStyle", attrs }] },
          ],
        },
      ],
    });

    it("serializes inline-styled text transparently instead of throwing", () => {
      const doc = styled({ color: "rgb(1, 2, 3)" });
      expect(() => tiptapJsonToMarkdown(doc)).not.toThrow();
      expect(tiptapJsonToMarkdown(doc).trim()).toBe("keep this");
    });

    it("drops every declared CSS attribute rather than inventing syntax for it", () => {
      const attrs = { color: "red", backgroundColor: "yellow", fontFamily: "serif", fontSize: "18px", lineHeight: "2" };
      expect(tiptapJsonToMarkdown(styled(attrs)).trim()).toBe("keep this");
    });

    it("leaves the marks markdown CAN express alone when textStyle sits alongside them", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "strong",
                marks: [{ type: "bold" }, { type: "textStyle", attrs: { color: "red" } }],
              },
            ],
          },
        ],
      };
      expect(tiptapJsonToMarkdown(doc).trim()).toBe("**strong**");
    });

    it("never produces textStyle from markdown — it is a compatibility mark, not a syntax", () => {
      expect(JSON.stringify(markdownToTiptapJson("plain *em* text"))).not.toContain("textStyle");
    });
  });

  describe("strikethrough", () => {
    it("round-trips ~~struck~~ text as the strike mark", () => {
      const json = markdownToTiptapJson("some ~~gone~~ text");
      expect(JSON.stringify(json)).toContain('"strike"');
      const back = tiptapJsonToMarkdown(json as object).trim();
      expect(back).toBe("some ~~gone~~ text");
    });
  });

  describe("markdownToInlineChildren", () => {
    it("returns the inline children of a single paragraph, marks preserved", () => {
      const children = markdownToInlineChildren("A **bold** rewrite.");
      expect(children.length).toBeGreaterThan(0);
      const text = JSON.stringify(children);
      expect(text).toContain("bold");
      expect(text).not.toContain('"paragraph"'); // inline nodes only, no block wrapper
      expect(text).toContain('"bold"'); // the mark survived
    });

    it("rejects multi-block output with []", () => {
      expect(markdownToInlineChildren("Para one.\n\nPara two.")).toEqual([]);
    });

    it("rejects non-paragraph blocks (heading, list, code) with []", () => {
      expect(markdownToInlineChildren("# A heading")).toEqual([]);
      expect(markdownToInlineChildren("- a list item")).toEqual([]);
      expect(markdownToInlineChildren("```\ncode\n```")).toEqual([]);
    });

    it("returns [] for empty/blank input", () => {
      expect(markdownToInlineChildren("")).toEqual([]);
      expect(markdownToInlineChildren("   ")).toEqual([]);
    });
  });
});
