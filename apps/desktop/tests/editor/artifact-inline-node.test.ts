import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { buildEditorExtensions } from "@/services/notes/editor-extensions";

const schema = getSchema(buildEditorExtensions());

describe("editor/nodes/artifact-inline-node", () => {
  it("toJSON round-trips through nodeFromJSON preserving metadata + inline children", () => {
    const inline = schema.nodes["artifact-inline"].create(
      { artifactId: "i1", skillId: "fix-grammar", skillName: "Fix grammar" },
      [schema.text("Rewritten span")],
    );
    const para = schema.nodes.paragraph.create(null, [
      schema.text("Before "),
      inline,
      schema.text(" after"),
    ]);

    const json = para.toJSON();
    const restored = schema.nodeFromJSON(json);

    expect(restored.type.name).toBe("paragraph");
    expect(restored.childCount).toBe(3);

    const inlineRestored = restored.child(1);
    expect(inlineRestored.type.name).toBe("artifact-inline");
    expect(inlineRestored.attrs).toMatchObject({
      artifactId: "i1",
      skillId: "fix-grammar",
      skillName: "Fix grammar",
    });
    expect(inlineRestored.textContent).toBe("Rewritten span");
  });

  it("is inline (group: 'inline')", () => {
    const nodeType = schema.nodes["artifact-inline"];
    expect(nodeType.isInline).toBe(true);
    // The schema spec must allow inline content (text + marks) inside.
    const inline = nodeType.create({}, [schema.text("x")]);
    expect(inline.firstChild?.type.name).toBe("text");
  });
});
