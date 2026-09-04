import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import { buildEditorExtensions, getEditorSchema } from "@prismical/editor-schema";

describe("web editor schema parity", () => {
  it("the web base extension set matches the shared server schema (no drift)", () => {
    // Collaboration adds no nodes/marks, so the base set (sans Collaboration,
    // which needs a Y.Doc) is sufficient to prove parity with the server schema.
    const web = getSchema(buildEditorExtensions({ undoRedo: false }));
    const server = getEditorSchema();
    expect(Object.keys(web.nodes)).toEqual(Object.keys(server.nodes));
    expect(Object.keys(web.marks)).toEqual(Object.keys(server.marks));
  });
});
