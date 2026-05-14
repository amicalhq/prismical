import { describe, expect, it } from "vitest";

describe("@tiptap/extension-drag-handle-react module", () => {
  it("exports DragHandle", async () => {
    const mod = await import("@tiptap/extension-drag-handle-react");
    expect(mod.DragHandle).toBeDefined();
    expect(typeof mod.DragHandle).toBe("function");
  });
});
