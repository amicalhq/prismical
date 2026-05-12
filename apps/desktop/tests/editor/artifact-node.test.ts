import { describe, expect, it } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";

describe("editor/nodes/artifact-node", () => {
  it("exportJSON round-trips through importJSON preserving metadata + children", async () => {
    const { ArtifactNode, $createArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );

    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });
    let jsonOut: unknown;

    editor.update(
      () => {
        const root = $getRoot();
        const node = $createArtifactNode({
          artifactId: "abc-123",
          skillId: "enhance",
          skillName: "Enhance",
          version: 2,
          generatedAt: new Date("2026-05-11T12:00:00Z").toISOString(),
          modelId: "claude-opus-4-7",
        });
        const para = $createParagraphNode();
        para.append($createTextNode("Summary line"));
        node.append(para);
        root.append(node);
      },
      { discrete: true },
    );

    editor.read(() => {
      jsonOut = editor.getEditorState().toJSON();
    });

    const editor2 = createHeadlessEditor({ nodes: [ArtifactNode] });
    const restored = editor2.parseEditorState(JSON.stringify(jsonOut));
    editor2.setEditorState(restored);

    editor2.read(() => {
      const root = $getRoot();
      const first = root.getFirstChildOrThrow();
      expect(first.getType()).toBe("artifact");
      // @ts-expect-error - intentional inspect of node-specific fields
      expect(first.getArtifactId()).toBe("abc-123");
      // @ts-expect-error
      expect(first.getSkillId()).toBe("enhance");
      // @ts-expect-error
      expect(first.getSkillName()).toBe("Enhance");
      // @ts-expect-error
      expect(first.getVersion()).toBe(2);
      // @ts-expect-error
      expect(first.getModelId()).toBe("claude-opus-4-7");
      // @ts-expect-error
      expect(first.getGeneratedAt()).toBe("2026-05-11T12:00:00.000Z");
      // Children survive: the paragraph + text inside.
      // @ts-expect-error
      const para = first.getFirstChildOrThrow();
      expect(para.getType()).toBe("paragraph");
      expect(para.getTextContent()).toBe("Summary line");
    });
  });

  it("clone copies all metadata fields", async () => {
    const { ArtifactNode, $createArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });

    editor.update(
      () => {
        const node = $createArtifactNode({
          artifactId: "x",
          skillId: "y",
          skillName: "Y",
          version: 5,
          generatedAt: "2026-01-01T00:00:00Z",
          modelId: "m",
        });
        const copy = ArtifactNode.clone(node);
        expect(copy.getArtifactId()).toBe("x");
        expect(copy.getSkillId()).toBe("y");
        expect(copy.getSkillName()).toBe("Y");
        expect(copy.getVersion()).toBe(5);
        expect(copy.getGeneratedAt()).toBe("2026-01-01T00:00:00Z");
        expect(copy.getModelId()).toBe("m");
        // Clone produces a new node with the SAME key — Lexical convention
        // for in-place mutations.
        expect(copy.getKey()).toBe(node.getKey());
      },
      { discrete: true },
    );
  });

  it("updateMetadata replaces version + generatedAt + modelId in place (Lexical writable)", async () => {
    const { ArtifactNode, $createArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });

    let key = "";
    editor.update(
      () => {
        const node = $createArtifactNode({
          artifactId: "a1",
          skillId: "s1",
          skillName: "S1",
          version: 1,
          generatedAt: "2026-01-01T00:00:00Z",
          modelId: "m1",
        });
        $getRoot().append(node);
        key = node.getKey();
      },
      { discrete: true },
    );

    editor.update(
      () => {
        const node = $getRoot().getFirstChildOrThrow() as InstanceType<
          typeof ArtifactNode
        >;
        node.updateMetadata({
          version: 2,
          generatedAt: "2026-02-01T00:00:00Z",
          modelId: "m2",
        });
        expect(node.getKey()).toBe(key);
        expect(node.getVersion()).toBe(2);
        expect(node.getGeneratedAt()).toBe("2026-02-01T00:00:00Z");
        expect(node.getModelId()).toBe("m2");
        // skillId, skillName, artifactId are stable — only the regen-related
        // fields change.
        expect(node.getArtifactId()).toBe("a1");
        expect(node.getSkillId()).toBe("s1");
        expect(node.getSkillName()).toBe("S1");
      },
      { discrete: true },
    );
  });
});
