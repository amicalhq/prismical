import { describe, expect, it } from "vitest";
import { lexicalStateToMarkdown } from "@/services/notes/lexical-to-markdown";

function makeState(rootChildren: unknown[]) {
  return JSON.stringify({ root: { children: rootChildren } });
}

function textNode(text: string, format = 0) {
  return { type: "text", text, format };
}

function paragraphNode(children: unknown[]) {
  return { type: "paragraph", children };
}

function headingNode(tag: string, children: unknown[]) {
  return { type: "heading", tag, children };
}

describe("lexicalStateToMarkdown", () => {
  it("renders a plain paragraph", () => {
    const state = makeState([paragraphNode([textNode("Hello world")])]);
    expect(lexicalStateToMarkdown(state)).toBe("Hello world");
  });

  it("renders heading levels correctly", () => {
    const state = makeState([
      headingNode("h1", [textNode("Title")]),
      headingNode("h2", [textNode("Subtitle")]),
      headingNode("h3", [textNode("Section")]),
    ]);
    expect(lexicalStateToMarkdown(state)).toBe(
      "# Title\n\n## Subtitle\n\n### Section",
    );
  });

  it("unwraps ArtifactNode (block-level) children", () => {
    const state = makeState([
      {
        type: "artifact",
        children: [
          paragraphNode([textNode("AI paragraph")]),
          {
            type: "list",
            listType: "bullet",
            children: [
              { type: "listitem", children: [textNode("Item A")] },
              { type: "listitem", children: [textNode("Item B")] },
            ],
          },
        ],
      },
    ]);
    const result = lexicalStateToMarkdown(state);
    expect(result).toContain("AI paragraph");
    expect(result).toContain("- Item A");
    expect(result).toContain("- Item B");
  });

  it("unwraps ArtifactInlineNode inside a paragraph transparently", () => {
    const state = makeState([
      paragraphNode([
        textNode("Before "),
        {
          type: "artifact-inline",
          children: [textNode("inline AI text")],
        },
        textNode(" after"),
      ]),
    ]);
    expect(lexicalStateToMarkdown(state)).toBe("Before inline AI text after");
  });

  it("applies bold mark (format bit 1)", () => {
    const state = makeState([paragraphNode([textNode("bold", 1)])]);
    expect(lexicalStateToMarkdown(state)).toBe("**bold**");
  });

  it("applies italic mark (format bit 2)", () => {
    const state = makeState([paragraphNode([textNode("italic", 2)])]);
    expect(lexicalStateToMarkdown(state)).toBe("*italic*");
  });

  it("applies code mark (format bit 16)", () => {
    const state = makeState([paragraphNode([textNode("code", 16)])]);
    expect(lexicalStateToMarkdown(state)).toBe("`code`");
  });

  it("renders a link", () => {
    const state = makeState([
      paragraphNode([
        {
          type: "link",
          url: "https://example.com",
          children: [textNode("link text")],
        },
      ]),
    ]);
    expect(lexicalStateToMarkdown(state)).toBe("[link text](https://example.com)");
  });

  it("renders an ordered list", () => {
    const state = makeState([
      {
        type: "list",
        listType: "number",
        children: [
          { type: "listitem", children: [textNode("First")] },
          { type: "listitem", children: [textNode("Second")] },
        ],
      },
    ]);
    expect(lexicalStateToMarkdown(state)).toBe("1. First\n2. Second");
  });

  it("renders an unordered list", () => {
    const state = makeState([
      {
        type: "list",
        listType: "bullet",
        children: [
          { type: "listitem", children: [textNode("Alpha")] },
          { type: "listitem", children: [textNode("Beta")] },
        ],
      },
    ]);
    expect(lexicalStateToMarkdown(state)).toBe("- Alpha\n- Beta");
  });

  it("renders a code block", () => {
    const state = makeState([
      { type: "code", children: [textNode("const x = 1;")] },
    ]);
    expect(lexicalStateToMarkdown(state)).toBe("```\nconst x = 1;\n```");
  });

  it("renders a blockquote", () => {
    const state = makeState([
      { type: "quote", children: [textNode("A wise quote")] },
    ]);
    expect(lexicalStateToMarkdown(state)).toBe("> A wise quote");
  });

  it("renders a horizontal rule", () => {
    const state = makeState([{ type: "horizontalrule", children: [] }]);
    expect(lexicalStateToMarkdown(state)).toBe("---");
  });

  it("handles empty state gracefully", () => {
    const state = makeState([]);
    expect(lexicalStateToMarkdown(state)).toBe("");
  });

  it("handles multiple paragraphs separated by blank lines", () => {
    const state = makeState([
      paragraphNode([textNode("First")]),
      paragraphNode([textNode("Second")]),
    ]);
    expect(lexicalStateToMarkdown(state)).toBe("First\n\nSecond");
  });
});
