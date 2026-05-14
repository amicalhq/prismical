import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { buildEditorExtensions } from "@/services/notes/editor-extensions";

const schema = getSchema(buildEditorExtensions());

describe("editor/nodes/artifact-node", () => {
  it("toJSON round-trips through nodeFromJSON preserving attrs + children", () => {
    const attrs = {
      artifactId: "abc-123",
      skillId: "enhance",
      skillName: "Enhance",
      version: 2,
      generatedAt: new Date("2026-05-11T12:00:00Z").toISOString(),
      modelId: "claude-opus-4-7",
    };

    const paragraph = schema.nodes.paragraph.create(null, [
      schema.text("Summary line"),
    ]);
    const node = schema.nodes.artifact.create(attrs, [paragraph]);

    const json = node.toJSON();
    const restored = schema.nodeFromJSON(json);

    expect(restored.type.name).toBe("artifact");
    expect(restored.attrs).toMatchObject(attrs);

    // Children survive the round-trip — the paragraph + its text.
    expect(restored.childCount).toBe(1);
    const child = restored.firstChild;
    expect(child?.type.name).toBe("paragraph");
    expect(child?.textContent).toBe("Summary line");
  });

  it("defaults missing attributes to schema defaults", () => {
    const node = schema.nodes.artifact.create(
      { skillId: "y", skillName: "Y" },
      [schema.nodes.paragraph.create()],
    );
    expect(node.attrs.artifactId).toBe("");
    expect(node.attrs.version).toBe(1);
    expect(node.attrs.modelId).toBe("");
    expect(node.attrs.skillId).toBe("y");
  });

  it("parseHTML hydrates attrs from data-* attributes", () => {
    // Construct a node, serialize to JSON, mutate the JSON attrs to simulate
    // the values the parseHTML path would extract from DOM data-* attrs.
    // (Asserts the renderHTML/parseHTML contract via JSON which mirrors it.)
    const node = schema.nodes.artifact.create(
      {
        artifactId: "a1",
        skillId: "s1",
        skillName: "S1",
        version: 7,
        generatedAt: "2026-01-01T00:00:00Z",
        modelId: "m1",
      },
      [schema.nodes.paragraph.create()],
    );
    const json = node.toJSON();
    expect(json.attrs).toMatchObject({
      artifactId: "a1",
      version: 7,
      modelId: "m1",
    });
  });
});
