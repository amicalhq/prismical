import { describe, expect, it } from "vitest";
import type { WriteSectionPayload } from "@/services/skills-runtime/skill-context";

describe("skills-runtime/tools/write-section", () => {
  it("write_section calls the capture callback with the markdown", async () => {
    const { createWriteSectionTool } = await import(
      "@/services/skills-runtime/tools/write-section"
    );
    let captured: WriteSectionPayload | null = null;
    const t = createWriteSectionTool({
      capture: (p) => {
        captured = p;
      },
      mode: "append-section",
    });
    await t.execute(
      { markdown: "## Summary\n\nHi" },
      { toolCallId: "x", messages: [], abortSignal: new AbortController().signal },
    );
    expect(captured).toEqual({ markdown: "## Summary\n\nHi" });
  });

  it("replace_selection calls the capture callback with the markdown", async () => {
    const { createReplaceSelectionTool } = await import(
      "@/services/skills-runtime/tools/replace-selection"
    );
    let captured: WriteSectionPayload | null = null;
    const t = createReplaceSelectionTool({
      capture: (p) => {
        captured = p;
      },
      selectionText: "original text here",
    });
    await t.execute(
      { markdown: "rewritten text" },
      { toolCallId: "y", messages: [], abortSignal: new AbortController().signal },
    );
    expect(captured).toEqual({ markdown: "rewritten text" });
  });

  it("write_section description includes mode hint for replace-doc", async () => {
    const { createWriteSectionTool } = await import(
      "@/services/skills-runtime/tools/write-section"
    );
    const t = createWriteSectionTool({
      capture: () => {},
      mode: "replace-doc",
    });
    expect(t.description).toContain("Replace the entire note body");
  });
});
