import { describe, it, expect } from "vitest";
import {
  markdownToTiptapJson,
  tiptapJsonToMarkdown,
  markdownToTiptapChildren,
} from "./tiptap-markdown.js";
import { markdownToChildren, markdownToInlineChildren } from "./markdown-to-children.js";

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

  it("drops images instead of throwing (schema has no image node)", () => {
    // markdown-it emits `image` as a self-contained token; the parser must not choke on it.
    const children = markdownToTiptapChildren("Before ![alt](http://x/y.png) after.");
    expect(children).toHaveLength(1);
    const text = JSON.stringify(children);
    expect(text).toContain("Before");
    expect(text).toContain("after.");
    expect(text).not.toContain("y.png");
    // An image-only line still parses to a (now empty-ish) paragraph rather than throwing.
    expect(() => markdownToTiptapJson("![just an image](http://x/y.png)")).not.toThrow();
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
