import { describe, it, expect } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { getEditorSchema } from "@prismical/editor-schema";
import { verifyRangeAgainstDoc } from "./selection-anchors";

const schema = getEditorSchema();

function docWith(children: JSONContent[]) {
  return schema.nodeFromJSON({ type: "doc", content: children });
}

const para = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("verifyRangeAgainstDoc", () => {
  it("accepts a range that still spells the selection text exactly", () => {
    // <p>hello world</p> — "hello" = [1,6)
    const doc = docWith([para("hello world")]);
    expect(verifyRangeAgainstDoc(doc, { from: 1, to: 6 }, "hello")).toEqual({ from: 1, to: 6 });
  });

  it("snaps when a boundary insert got swallowed into the range (block-start anchor stickiness)", () => {
    // Original selection was "Second part" at block start; a collaborator typed "REMOTE: " at the
    // block start and the raw anchor range now includes it.
    const doc = docWith([para("REMOTE: Second part here")]);
    // Raw resolved range covers "REMOTE: Second part" [1,20) — mismatch → snap to "Second part".
    const snapped = verifyRangeAgainstDoc(doc, { from: 1, to: 20 }, "Second part");
    expect(snapped).toEqual({ from: 9, to: 20 });
    expect(doc.textBetween(snapped!.from, snapped!.to, " ")).toBe("Second part");
  });

  it("rejects when the target text was edited (no exact occurrence left)", () => {
    const doc = docWith([para("the team dISCussed it")]);
    expect(verifyRangeAgainstDoc(doc, { from: 1, to: 18 }, "the team discussed")).toBeNull();
  });

  it("rejects a collapsed range whose text is gone", () => {
    const doc = docWith([para("xy")]);
    expect(verifyRangeAgainstDoc(doc, { from: 1, to: 1 }, "deleted sentence")).toBeNull();
  });

  it("refuses to guess between duplicate occurrences", () => {
    const doc = docWith([para("alpha beta alpha beta")]);
    // Raw range mismatches; "beta" appears twice in the block → ambiguous → null.
    expect(verifyRangeAgainstDoc(doc, { from: 1, to: 3 }, "beta")).toBeNull();
  });
});
