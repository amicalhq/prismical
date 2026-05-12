import { describe, expect, it } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";

describe("editor/nodes/artifact-inline-node", () => {
  it("exportJSON round-trips through importJSON preserving metadata + inline children", async () => {
    const { ArtifactInlineNode, $createArtifactInlineNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-inline-node"
    );
    const editor = createHeadlessEditor({ nodes: [ArtifactInlineNode] });

    let jsonOut: unknown;
    editor.update(
      () => {
        const para = $createParagraphNode();
        const inline = $createArtifactInlineNode({
          artifactId: "i1",
          skillId: "fix-grammar",
          skillName: "Fix grammar",
        });
        inline.append($createTextNode("Rewritten span"));
        para.append($createTextNode("Before "), inline, $createTextNode(" after"));
        $getRoot().append(para);
      },
      { discrete: true },
    );

    editor.read(() => {
      jsonOut = editor.getEditorState().toJSON();
    });

    const editor2 = createHeadlessEditor({ nodes: [ArtifactInlineNode] });
    const restored = editor2.parseEditorState(JSON.stringify(jsonOut));
    editor2.setEditorState(restored);

    editor2.read(() => {
      const para = $getRoot().getFirstChildOrThrow();
      // Children of the paragraph: TextNode, ArtifactInlineNode, TextNode
      const children = (para as InstanceType<typeof ArtifactInlineNode> /* lying for inspection */)
        // @ts-expect-error - peek into ElementNode's children
        .getChildren();
      expect(children).toHaveLength(3);
      const inline = children[1];
      expect(inline.getType()).toBe("artifact-inline");
      expect(inline.getArtifactId()).toBe("i1");
      expect(inline.getSkillId()).toBe("fix-grammar");
      expect(inline.getSkillName()).toBe("Fix grammar");
      expect(inline.getTextContent()).toBe("Rewritten span");
    });
  });

  it("isInline() returns true and the node merges into surrounding text flow", async () => {
    const { ArtifactInlineNode, $createArtifactInlineNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-inline-node"
    );
    const editor = createHeadlessEditor({ nodes: [ArtifactInlineNode] });

    editor.update(
      () => {
        const node = $createArtifactInlineNode({
          artifactId: "x",
          skillId: "y",
          skillName: "Y",
        });
        expect(node.isInline()).toBe(true);
      },
      { discrete: true },
    );
  });
});
