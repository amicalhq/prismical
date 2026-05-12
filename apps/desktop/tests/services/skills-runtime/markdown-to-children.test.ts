import { describe, expect, it } from "vitest";
import { markdownToChildren } from "@/services/skills-runtime/markdown-to-children";

describe("skills-runtime/markdown-to-children", () => {
  it("returns a paragraph node with text content for a simple paragraph", () => {
    const children = markdownToChildren("hello");
    expect(children.length).toBeGreaterThan(0);
    const first = children[0] as { type: string; children?: { text?: string }[] };
    expect(first.type).toBe("paragraph");
    // Text should be present somewhere in the structure
    const texts = first.children?.map((c) => c.text).join("") ?? "";
    expect(texts).toContain("hello");
  });

  it("preserves heading and list structure", () => {
    const md = "# My Heading\n\n- item one\n- item two";
    const children = markdownToChildren(md);
    expect(children.length).toBeGreaterThan(1);
    const types = children.map((c) => (c as { type: string }).type);
    expect(types).toContain("heading");
    expect(types).toContain("list");
  });

  it("returns empty array for empty input", () => {
    expect(markdownToChildren("")).toEqual([]);
    expect(markdownToChildren("   ")).toEqual([]);
  });
});
