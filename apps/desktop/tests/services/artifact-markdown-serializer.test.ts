import { describe, it, expect } from "vitest";
import { tiptapJsonToMarkdown } from "@/services/notes/tiptap-markdown";

describe("artifact serialization — headless path used by sidecar/export/skills", () => {
  it("block 'artifact' wrapper is unwrapped; inner content renders as plain markdown", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "artifact",
          attrs: {
            artifactId: "a1",
            skillId: "skl_x",
            skillName: "enhance",
            version: 1,
            generatedAt: "2026-05-14T00:00:00Z",
            modelId: "claude-opus-4-7",
          },
          content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Summary" }] },
            { type: "paragraph", content: [{ type: "text", text: "Hello world." }] },
          ],
        },
      ],
    };

    const md = tiptapJsonToMarkdown(json);
    expect(md).not.toMatch(/artifact/i);
    expect(md).toContain("## Summary");
    expect(md).toContain("Hello world.");
  });

  it("inline 'artifact-inline' wrapper is unwrapped; inner text renders as inline markdown", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "before " },
            {
              type: "artifact-inline",
              attrs: {
                artifactId: "a2",
                skillId: "skl_y",
                skillName: "rewrite",
                version: 1,
                generatedAt: "2026-05-14T00:00:00Z",
                modelId: "claude-opus-4-7",
              },
              content: [{ type: "text", text: "rewritten" }],
            },
            { type: "text", text: " after" },
          ],
        },
      ],
    };

    const md = tiptapJsonToMarkdown(json);
    expect(md).toContain("before rewritten after");
    expect(md).not.toMatch(/artifact/i);
  });
});
