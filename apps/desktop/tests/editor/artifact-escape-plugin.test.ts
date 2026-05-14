import { describe, expect, it } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from "lexical";

describe("editor/artifact-escape-plugin", () => {
  it("appends a trailing paragraph after an ArtifactNode at the end of the root", async () => {
    const { ArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const {
      INSERT_ARTIFACT_NODE_COMMAND,
      registerArtifactNodeCommands,
    } = await import(
      "@/renderer/main/components/editor/commands/artifact-commands"
    );
    const { registerArtifactEscape } = await import(
      "@/renderer/main/components/editor/artifact-escape-plugin"
    );

    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });
    const disposeCmds = registerArtifactNodeCommands(editor);
    const disposeEsc = registerArtifactEscape(editor);

    try {
      const childContent = [
        {
          type: "paragraph",
          version: 1,
          children: [
            { type: "text", version: 1, text: "Body", format: 0, detail: 0, mode: "normal", style: "" },
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
        generatedAt: "2026-05-13T00:00:00Z",
        modelId: "m",
        content: childContent,
      });

      editor.read(() => {
        const root = $getRoot();
        expect(root.getChildrenSize()).toBe(2);
        expect(root.getChildAtIndex(0)!.getType()).toBe("artifact");
        const last = root.getChildAtIndex(1)!;
        expect(last.getType()).toBe("paragraph");
        expect(last.getTextContent()).toBe("");
      });
    } finally {
      disposeEsc();
      disposeCmds();
    }
  });

  it("appends a trailing paragraph when an artifact-terminated state is loaded", async () => {
    const { ArtifactNode, $createArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const { registerArtifactEscape } = await import(
      "@/renderer/main/components/editor/artifact-escape-plugin"
    );

    const source = createHeadlessEditor({ nodes: [ArtifactNode] });
    let json: string;
    source.update(
      () => {
        const node = $createArtifactNode({
          artifactId: "a1",
          skillId: "s1",
          skillName: "S",
          version: 1,
          generatedAt: "2026-05-13T00:00:00Z",
          modelId: "m",
        });
        node.append($createParagraphNode().append($createTextNode("hi")));
        $getRoot().append(node);
      },
      { discrete: true },
    );
    source.read(() => {
      json = JSON.stringify(source.getEditorState().toJSON());
    });

    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });
    const dispose = registerArtifactEscape(editor);
    try {
      const parsed = editor.parseEditorState(json!);
      editor.setEditorState(parsed);
      editor.update(
        () => {
          const root = $getRoot();
          const node = root.getFirstChildOrThrow();
          node.markDirty();
        },
        { discrete: true },
      );

      editor.read(() => {
        const root = $getRoot();
        expect(root.getChildrenSize()).toBe(2);
        expect(root.getChildAtIndex(1)!.getType()).toBe("paragraph");
      });
    } finally {
      dispose();
    }
  });

  it("Enter on an empty paragraph that is the last child of an ArtifactNode escapes to the trailing paragraph", async () => {
    const { ArtifactNode, $createArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const { registerArtifactEscape, $tryEscapeArtifactDown } = await import(
      "@/renderer/main/components/editor/artifact-escape-plugin"
    );

    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });
    const dispose = registerArtifactEscape(editor);

    try {
      let trailingKey = "";
      editor.update(
        () => {
          const node = $createArtifactNode({
            artifactId: "a1", skillId: "s", skillName: "S",
            version: 1, generatedAt: "2026-05-13T00:00:00Z", modelId: "m",
          });
          node.append($createParagraphNode().append($createTextNode("body")));
          // Empty paragraph at the end — what the user lands in after exiting a list.
          const empty = $createParagraphNode();
          node.append(empty);
          $getRoot().append(node);
          // Place the caret in the empty paragraph.
          empty.selectStart();
        },
        { discrete: true },
      );

      // Trigger another tick so Task 1's transform appends the trailing paragraph.
      editor.update(() => {}, { discrete: true });
      editor.read(() => {
        const root = $getRoot();
        expect(root.getChildrenSize()).toBe(2);
        trailingKey = root.getChildAtIndex(1)!.getKey();
      });

      let consumed = false;
      editor.update(
        () => {
          consumed = $tryEscapeArtifactDown();
        },
        { discrete: true },
      );
      expect(consumed).toBe(true);

      editor.read(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) throw new Error("expected range selection");
        // Selection should now be in the trailing paragraph.
        const anchorBlock = sel.anchor.getNode().getTopLevelElementOrThrow();
        expect(anchorBlock.getKey()).toBe(trailingKey);
      });
    } finally {
      dispose();
    }
  });

  it("Arrow-Down at the end of an artifact's last non-empty paragraph escapes to the trailing paragraph", async () => {
    const { ArtifactNode, $createArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const { registerArtifactEscape, $tryEscapeArtifactDown } = await import(
      "@/renderer/main/components/editor/artifact-escape-plugin"
    );

    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });
    const dispose = registerArtifactEscape(editor);

    try {
      editor.update(
        () => {
          const node = $createArtifactNode({
            artifactId: "a1", skillId: "s", skillName: "S",
            version: 1, generatedAt: "2026-05-13T00:00:00Z", modelId: "m",
          });
          const last = $createParagraphNode().append($createTextNode("end"));
          node.append(last);
          $getRoot().append(node);
          last.selectEnd();
        },
        { discrete: true },
      );
      editor.update(() => {}, { discrete: true }); // run transform

      let consumed = false;
      editor.update(
        () => {
          consumed = $tryEscapeArtifactDown(false);
        },
        { discrete: true },
      );
      expect(consumed).toBe(true);

      editor.read(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) throw new Error("expected range selection");
        const block = sel.anchor.getNode().getTopLevelElementOrThrow();
        // Caret should now be in the paragraph appended *after* the artifact.
        expect(block.getType()).toBe("paragraph");
        expect(block.getKey()).toBe(
          $getRoot().getChildAtIndex(1)!.getKey(),
        );
      });
    } finally {
      dispose();
    }
  });

  it("Enter at the end of a non-empty paragraph inside an artifact does not escape (so list-exit / new-paragraph still works)", async () => {
    const { ArtifactNode, $createArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const { registerArtifactEscape, $tryEscapeArtifactDown } = await import(
      "@/renderer/main/components/editor/artifact-escape-plugin"
    );

    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });
    const dispose = registerArtifactEscape(editor);
    try {
      editor.update(
        () => {
          const node = $createArtifactNode({
            artifactId: "a1", skillId: "s", skillName: "S",
            version: 1, generatedAt: "2026-05-13T00:00:00Z", modelId: "m",
          });
          const p = $createParagraphNode().append($createTextNode("body"));
          node.append(p);
          $getRoot().append(node);
          p.selectEnd();
        },
        { discrete: true },
      );
      editor.update(() => {}, { discrete: true });

      let consumed = false;
      editor.update(
        () => {
          consumed = $tryEscapeArtifactDown(true); // Enter semantics
        },
        { discrete: true },
      );
      expect(consumed).toBe(false);
    } finally {
      dispose();
    }
  });

  it("Arrow-Up at the start of an artifact's first paragraph escapes to the previous sibling (creating one if needed)", async () => {
    const { ArtifactNode, $createArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const { registerArtifactEscape, $tryEscapeArtifactUp } = await import(
      "@/renderer/main/components/editor/artifact-escape-plugin"
    );

    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });
    const dispose = registerArtifactEscape(editor);
    try {
      editor.update(
        () => {
          const node = $createArtifactNode({
            artifactId: "a1", skillId: "s", skillName: "S",
            version: 1, generatedAt: "2026-05-13T00:00:00Z", modelId: "m",
          });
          const first = $createParagraphNode().append($createTextNode("first"));
          node.append(first);
          $getRoot().append(node);
          first.selectStart();
        },
        { discrete: true },
      );
      editor.update(() => {}, { discrete: true }); // run transform (adds trailing)

      let consumed = false;
      editor.update(
        () => {
          consumed = $tryEscapeArtifactUp(false);
        },
        { discrete: true },
      );
      expect(consumed).toBe(true);

      editor.read(() => {
        const root = $getRoot();
        // Now: [paragraph (new, above artifact), artifact, paragraph (trailing)]
        expect(root.getChildrenSize()).toBe(3);
        expect(root.getChildAtIndex(0)!.getType()).toBe("paragraph");
        expect(root.getChildAtIndex(1)!.getType()).toBe("artifact");
        expect(root.getChildAtIndex(2)!.getType()).toBe("paragraph");

        const sel = $getSelection();
        if (!$isRangeSelection(sel)) throw new Error("expected range selection");
        const block = sel.anchor.getNode().getTopLevelElementOrThrow();
        expect(block.getKey()).toBe(root.getChildAtIndex(0)!.getKey());
      });
    } finally {
      dispose();
    }
  });

  it("Backspace at the start of an artifact's first paragraph escapes upward and does not delete the artifact's content", async () => {
    const { ArtifactNode, $createArtifactNode } = await import(
      "@/renderer/main/components/editor/nodes/artifact-node"
    );
    const { registerArtifactEscape, $tryEscapeArtifactUp } = await import(
      "@/renderer/main/components/editor/artifact-escape-plugin"
    );

    const editor = createHeadlessEditor({ nodes: [ArtifactNode] });
    const dispose = registerArtifactEscape(editor);
    try {
      editor.update(
        () => {
          // Pre-existing paragraph above so Task 1's transform is a no-op above.
          $getRoot().append(
            $createParagraphNode().append($createTextNode("above")),
          );
          const node = $createArtifactNode({
            artifactId: "a1", skillId: "s", skillName: "S",
            version: 1, generatedAt: "2026-05-13T00:00:00Z", modelId: "m",
          });
          const first = $createParagraphNode().append($createTextNode("artifact body"));
          node.append(first);
          $getRoot().append(node);
          first.selectStart();
        },
        { discrete: true },
      );
      editor.update(() => {}, { discrete: true });

      let consumed = false;
      editor.update(
        () => {
          consumed = $tryEscapeArtifactUp(false);
        },
        { discrete: true },
      );
      expect(consumed).toBe(true);

      editor.read(() => {
        const root = $getRoot();
        const artifact = root.getChildren().find((c) => c.getType() === "artifact")!;
        expect(artifact.getTextContent()).toBe("artifact body");

        const sel = $getSelection();
        if (!$isRangeSelection(sel)) throw new Error("expected range selection");
        expect(sel.anchor.getNode().getTextContent()).toBe("above");
      });
    } finally {
      dispose();
    }
  });
});
