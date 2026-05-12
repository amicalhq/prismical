import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $parseSerializedNode,
  createCommand,
  type LexicalCommand,
  type LexicalEditor,
  type SerializedLexicalNode,
} from "lexical";
import {
  $createArtifactNode,
  type ArtifactNodeMetadata,
} from "../nodes/artifact-node";
import {
  $createArtifactInlineNode,
  type ArtifactInlineNodeMetadata,
} from "../nodes/artifact-inline-node";

// -------------------------------------------------------------------------
// Command payloads
// -------------------------------------------------------------------------

// `content` is the array of serialized Lexical children that will become the
// node's body. The runtime (Plan 3) produces this by piping the agent's
// markdown output through markdownToLexicalStateJson and extracting its
// `root.children`.
export interface InsertArtifactNodePayload extends ArtifactNodeMetadata {
  content: SerializedLexicalNode[];
}

export interface InsertArtifactInlineNodePayload
  extends ArtifactInlineNodeMetadata {
  content: SerializedLexicalNode[];
}

export const INSERT_ARTIFACT_NODE_COMMAND: LexicalCommand<InsertArtifactNodePayload> =
  createCommand("INSERT_ARTIFACT_NODE_COMMAND");

export const INSERT_ARTIFACT_INLINE_NODE_COMMAND: LexicalCommand<InsertArtifactInlineNodePayload> =
  createCommand("INSERT_ARTIFACT_INLINE_NODE_COMMAND");

// -------------------------------------------------------------------------
// Command registration (non-React; tests use this directly)
// -------------------------------------------------------------------------

export function registerArtifactNodeCommands(editor: LexicalEditor): () => void {
  const unregisterBlock = editor.registerCommand<InsertArtifactNodePayload>(
    INSERT_ARTIFACT_NODE_COMMAND,
    (payload) => {
      const node = $createArtifactNode({
        artifactId: payload.artifactId,
        skillId: payload.skillId,
        skillName: payload.skillName,
        version: payload.version,
        generatedAt: payload.generatedAt,
        modelId: payload.modelId,
      });
      const children = payload.content.map((serialized) =>
        $parseSerializedNode(serialized),
      );
      for (const child of children) {
        node.append(child);
      }
      $getRoot().append(node);
      return true;
    },
    0, // priority: low — feature plugins (lists, code blocks) take precedence
  );

  const unregisterInline = editor.registerCommand<InsertArtifactInlineNodePayload>(
    INSERT_ARTIFACT_INLINE_NODE_COMMAND,
    (payload) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;

      const inline = $createArtifactInlineNode({
        artifactId: payload.artifactId,
        skillId: payload.skillId,
        skillName: payload.skillName,
      });
      const children = payload.content.map((serialized) =>
        $parseSerializedNode(serialized),
      );
      for (const child of children) {
        inline.append(child);
      }

      // Replace the selected range with the inline node. Lexical's
      // RangeSelection.insertNodes handles splitting the surrounding text.
      selection.insertNodes([inline]);
      return true;
    },
    0,
  );

  return () => {
    unregisterBlock();
    unregisterInline();
  };
}

// -------------------------------------------------------------------------
// React plugin — mount this inside <LexicalComposer>
// -------------------------------------------------------------------------

export function ArtifactNodeCommandsPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerArtifactNodeCommands(editor), [editor]);
  return null;
}
