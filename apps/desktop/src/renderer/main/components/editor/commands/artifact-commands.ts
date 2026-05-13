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
  $isArtifactNode,
  type ArtifactNodeMetadata,
} from "../nodes/artifact-node";
import {
  $createArtifactInlineNode,
  $isArtifactInlineNode,
  type ArtifactInlineNode,
  type ArtifactInlineNodeMetadata,
} from "../nodes/artifact-inline-node";

// -------------------------------------------------------------------------
// Command payloads
// -------------------------------------------------------------------------

// `content` is the array of serialized Lexical children that will become the
// node's body. The runtime produces this by piping the agent's markdown
// output through markdownToLexicalStateJson and extracting its
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
      const root = $getRoot();
      const children = payload.content.map((serialized) =>
        $parseSerializedNode(serialized),
      );

      // Regen invariant: re-running an `append-section` skill walks the doc
      // for an existing `ArtifactNode` with matching `skill_id` and replaces
      // its children + bumps its metadata in place. This keeps the node's
      // identity stable (Yjs key, cursor position, scroll anchor)
      // and ensures the same skill never produces duplicate blocks in the
      // doc. If no matching node exists (first run), fall through to append.
      const existing = root
        .getChildren()
        .find(
          (child): child is ReturnType<typeof $createArtifactNode> =>
            $isArtifactNode(child) && child.getSkillId() === payload.skillId,
        );

      if (existing) {
        existing.updateMetadata({
          artifactId: payload.artifactId,
          version: payload.version,
          generatedAt: payload.generatedAt,
          modelId: payload.modelId,
        });
        // Replace children: remove all current children, then append the new
        // ones. Lexical's ElementNode doesn't expose `clear()` directly, so
        // walk and remove.
        for (const child of existing.getChildren()) {
          child.remove();
        }
        for (const child of children) {
          existing.append(child);
        }
        return true;
      }

      const node = $createArtifactNode({
        artifactId: payload.artifactId,
        skillId: payload.skillId,
        skillName: payload.skillName,
        version: payload.version,
        generatedAt: payload.generatedAt,
        modelId: payload.modelId,
      });
      for (const child of children) {
        node.append(child);
      }
      root.append(node);
      return true;
    },
    0, // priority: low — feature plugins (lists, code blocks) take precedence
  );

  const unregisterInline = editor.registerCommand<InsertArtifactInlineNodePayload>(
    INSERT_ARTIFACT_INLINE_NODE_COMMAND,
    (payload) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;

      const children = payload.content.map((serialized) =>
        $parseSerializedNode(serialized),
      );

      // Regen invariant (inline): re-running the same inline-rewrite skill
      // should replace the existing wrapper in place rather than nest or
      // insert a sibling. Look for an `ArtifactInlineNode` ancestor of the
      // selection's anchor or focus whose `skillId` matches the payload.
      const existing = findInlineAncestorForSkill(selection, payload.skillId);
      if (existing) {
        existing.updateArtifactId(payload.artifactId);
        for (const child of existing.getChildren()) {
          child.remove();
        }
        for (const child of children) {
          existing.append(child);
        }
        return true;
      }

      const inline = $createArtifactInlineNode({
        artifactId: payload.artifactId,
        skillId: payload.skillId,
        skillName: payload.skillName,
      });
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

// Walk up from the selection's anchor and focus, looking for the nearest
// `ArtifactInlineNode` ancestor whose `skillId` matches `skillId`. Returns
// the first match (anchor wins if both ancestors match different artifacts —
// extremely unlikely in practice). Returns null if neither side is inside
// any inline artifact of this skill.
function findInlineAncestorForSkill(
  selection: ReturnType<typeof $getSelection>,
  skillId: string,
): ArtifactInlineNode | null {
  if (!selection || !$isRangeSelection(selection)) return null;
  for (const endpoint of [selection.anchor, selection.focus]) {
    let node: ReturnType<typeof selection.anchor.getNode> | null =
      endpoint.getNode();
    while (node) {
      if ($isArtifactInlineNode(node) && node.getSkillId() === skillId) {
        return node;
      }
      node = node.getParent();
    }
  }
  return null;
}

// -------------------------------------------------------------------------
// React plugin — mount this inside <LexicalComposer>
// -------------------------------------------------------------------------

export function ArtifactNodeCommandsPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerArtifactNodeCommands(editor), [editor]);
  return null;
}
