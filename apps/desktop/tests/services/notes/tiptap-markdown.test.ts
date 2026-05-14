import { describe, expect, it } from "vitest";
import {
  markdownToTiptapJson,
  tiptapJsonToMarkdown,
} from "@/services/notes/tiptap-markdown";

function jsonDoc(content: unknown[]) {
  return { type: "doc", content };
}

function paragraph(content: unknown[]) {
  return { type: "paragraph", content };
}

function text(value: string, marks?: string[]) {
  return marks?.length
    ? {
        type: "text",
        text: value,
        marks: marks.map((t) => ({ type: t })),
      }
    : { type: "text", text: value };
}

describe("tiptapJsonToMarkdown", () => {
  it("renders a plain paragraph", () => {
    const doc = jsonDoc([paragraph([text("Hello world")])]);
    expect(tiptapJsonToMarkdown(doc).trim()).toBe("Hello world");
  });

  it("renders heading levels", () => {
    const doc = jsonDoc([
      { type: "heading", attrs: { level: 1 }, content: [text("Title")] },
      { type: "heading", attrs: { level: 2 }, content: [text("Subtitle")] },
      { type: "heading", attrs: { level: 3 }, content: [text("Section")] },
    ]);
    expect(tiptapJsonToMarkdown(doc).trim()).toBe(
      "# Title\n\n## Subtitle\n\n### Section",
    );
  });

  it("unwraps artifact (block-level) on export", () => {
    const doc = jsonDoc([
      {
        type: "artifact",
        attrs: {
          artifactId: "a",
          skillId: "s",
          skillName: "S",
          version: 1,
          generatedAt: "x",
          modelId: "m",
        },
        content: [
          paragraph([text("AI paragraph")]),
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [paragraph([text("Item A")])] },
              { type: "listItem", content: [paragraph([text("Item B")])] },
            ],
          },
        ],
      },
    ]);
    const out = tiptapJsonToMarkdown(doc);
    expect(out).toContain("AI paragraph");
    expect(out).toContain("- Item A");
    expect(out).toContain("- Item B");
    // No artifact wrapper leaks into the output.
    expect(out).not.toContain("artifact");
  });

  it("unwraps artifact-inline inside a paragraph", () => {
    const doc = jsonDoc([
      paragraph([
        text("Before "),
        {
          type: "artifact-inline",
          attrs: { artifactId: "i", skillId: "s", skillName: "S" },
          content: [text("inline AI text")],
        },
        text(" after"),
      ]),
    ]);
    expect(tiptapJsonToMarkdown(doc).trim()).toBe(
      "Before inline AI text after",
    );
  });

  it("applies bold and italic marks", () => {
    expect(
      tiptapJsonToMarkdown(
        jsonDoc([paragraph([text("bold", ["bold"])])]),
      ).trim(),
    ).toBe("**bold**");
    expect(
      tiptapJsonToMarkdown(
        jsonDoc([paragraph([text("italic", ["italic"])])]),
      ).trim(),
    ).toBe("*italic*");
  });

  it("renders a link", () => {
    const doc = jsonDoc([
      paragraph([
        {
          type: "text",
          text: "link text",
          marks: [{ type: "link", attrs: { href: "https://example.com" } }],
        },
      ]),
    ]);
    expect(tiptapJsonToMarkdown(doc).trim()).toBe(
      "[link text](https://example.com)",
    );
  });

  it("renders an ordered list", () => {
    const doc = jsonDoc([
      {
        type: "orderedList",
        attrs: { start: 1 },
        content: [
          { type: "listItem", content: [paragraph([text("First")])] },
          { type: "listItem", content: [paragraph([text("Second")])] },
        ],
      },
    ]);
    expect(tiptapJsonToMarkdown(doc).trim()).toContain("First");
    expect(tiptapJsonToMarkdown(doc).trim()).toContain("Second");
  });

  it("renders an unordered list", () => {
    const doc = jsonDoc([
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph([text("Alpha")])] },
          { type: "listItem", content: [paragraph([text("Beta")])] },
        ],
      },
    ]);
    const out = tiptapJsonToMarkdown(doc);
    expect(out).toContain("- Alpha");
    expect(out).toContain("- Beta");
  });

  it("renders a code block", () => {
    const doc = jsonDoc([
      { type: "codeBlock", content: [text("const x = 1;")] },
    ]);
    expect(tiptapJsonToMarkdown(doc).trim()).toBe("```\nconst x = 1;\n```");
  });

  it("renders a blockquote", () => {
    const doc = jsonDoc([
      { type: "blockquote", content: [paragraph([text("A wise quote")])] },
    ]);
    expect(tiptapJsonToMarkdown(doc).trim()).toBe("> A wise quote");
  });

  it("renders a horizontal rule", () => {
    const doc = jsonDoc([{ type: "horizontalRule" }]);
    expect(tiptapJsonToMarkdown(doc).trim()).toBe("---");
  });

  it("handles an empty doc gracefully", () => {
    const doc = jsonDoc([paragraph([])]);
    expect(tiptapJsonToMarkdown(doc).trim()).toBe("");
  });

  it("renders multiple paragraphs separated by blank lines", () => {
    const doc = jsonDoc([
      paragraph([text("First")]),
      paragraph([text("Second")]),
    ]);
    expect(tiptapJsonToMarkdown(doc).trim()).toBe("First\n\nSecond");
  });
});

describe("markdownToTiptapJson", () => {
  it("parses a heading + paragraph", () => {
    const md = "# Title\n\nBody text";
    const doc = markdownToTiptapJson(md) as {
      type: string;
      content: { type: string; attrs?: { level: number } }[];
    };
    expect(doc.type).toBe("doc");
    expect(doc.content[0]).toMatchObject({
      type: "heading",
      attrs: { level: 1 },
    });
    expect(doc.content[1]).toMatchObject({ type: "paragraph" });
  });

  it("parses a bullet list", () => {
    const md = "- foo\n- bar";
    const doc = markdownToTiptapJson(md) as { content: unknown[] };
    expect(doc.content[0]).toMatchObject({ type: "bulletList" });
  });

  it("ignores softbreaks inside paragraphs (no throw)", () => {
    // Without the `softbreak` token mapping, prosemirror-markdown's
    // MarkdownParser throws on any wrapped paragraph. This test guards
    // that regression.
    const md = "line one\nline two\nline three";
    expect(() => markdownToTiptapJson(md)).not.toThrow();
  });

  it("parses fenced code blocks with language", () => {
    const md = "```ts\nconst x = 1;\n```";
    const doc = markdownToTiptapJson(md) as {
      content: { type: string; attrs: { language: string } }[];
    };
    expect(doc.content[0]).toMatchObject({
      type: "codeBlock",
      attrs: { language: "ts" },
    });
  });
});
