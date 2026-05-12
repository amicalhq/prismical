import { describe, expect, it } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $createRangeSelection,
  $setSelection,
} from "lexical";

describe("editor/commands/artifact-commands", () => {
  it("INSERT_ARTIFACT_NODE_COMMAND appends an ArtifactNode to the document with the supplied content", async () => {
    const { ArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const {
      INSERT_ARTIFACT_NODE_COMMAND,
      registerArtifactNodeCommands,
    } = await import(
      "@/renderer/main/components/editor/commands/artifact-commands"
    );

    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });
    const dispose = registerArtifactNodeCommands(editor);

    try {
      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode("user scratch")),
          );
        },
        { discrete: true },
      );

      // The `content` field carries a fully-formed children array — paragraphs,
      // lists, etc. — already converted from markdown by the caller (Plan 3
      // runtime). For this test we use a single paragraph.
      const childContent = [
        {
          type: "paragraph",
          version: 1,
          children: [
            { type: "text", version: 1, text: "Generated summary", format: 0, detail: 0, mode: "normal", style: "" },
          ],
          direction: null,
          format: "",
          indent: 0,
        },
      ];

      editor.dispatchCommand(INSERT_ARTIFACT_NODE_COMMAND, {
        artifactId: "a1",
        skillId: "enhance",
        skillName: "Enhance",
        version: 1,
        generatedAt: "2026-05-11T12:00:00Z",
        modelId: "claude-opus-4-7",
        content: childContent,
      });

      editor.read(() => {
        const root = $getRoot();
        expect(root.getChildrenSize()).toBe(2);
        const second = root.getChildAtIndex(1)!;
        expect(second.getType()).toBe("artifact");
        expect(second.getTextContent()).toBe("Generated summary");
      });
    } finally {
      dispose();
    }
  });

  it("INSERT_ARTIFACT_INLINE_NODE_COMMAND wraps the current selection in an ArtifactInlineNode", async () => {
    const { ArtifactInlineNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-inline-node"
    );
    const {
      INSERT_ARTIFACT_INLINE_NODE_COMMAND,
      registerArtifactNodeCommands,
    } = await import(
      "@/renderer/main/components/editor/commands/artifact-commands"
    );

    const editor = createHeadlessEditor({ nodes: [ArtifactInlineNode] });
    const dispose = registerArtifactNodeCommands(editor);

    try {
      let textKey = "";
      editor.update(
        () => {
          const text = $createTextNode("hello world");
          textKey = text.getKey();
          $getRoot().append($createParagraphNode().append(text));
        },
        { discrete: true },
      );

      editor.update(
        () => {
          // Select "world" — chars 6..11 of the text node.
          const sel = $createRangeSelection();
          sel.anchor.set(textKey, 6, "text");
          sel.focus.set(textKey, 11, "text");
          $setSelection(sel);
        },
        { discrete: true },
      );

      const replacementContent = [
        { type: "text", version: 1, text: "earth", format: 0, detail: 0, mode: "normal", style: "" },
      ];

      editor.dispatchCommand(INSERT_ARTIFACT_INLINE_NODE_COMMAND, {
        artifactId: "i1",
        skillId: "translate-selection",
        skillName: "Translate",
        content: replacementContent,
      });

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        const text = para.getTextContent();
        expect(text).toBe("hello earth");
        // The middle child is the inline wrapper.
        const children = (para as InstanceType<typeof ArtifactInlineNode>) // type-lying for inspection
          // @ts-expect-error
          .getChildren();
        const wrappedTypes = children.map((c: { getType: () => string }) =>
          c.getType(),
        );
        expect(wrappedTypes).toContain("artifact-inline");
      });
    } finally {
      dispose();
    }
  });
});
