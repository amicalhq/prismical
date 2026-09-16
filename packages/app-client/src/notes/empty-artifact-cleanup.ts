import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { ARTIFACT_NODE_NAME, ARTIFACT_INLINE_NODE_NAME } from "@prismical/editor-schema";

// Empty text containers and line breaks do not carry generated content. Keep non-text
// leaves (images, emoji, horizontal rules) even when their textContent is empty.
function hasContent(node: PMNode): boolean {
  if (node.isText) return Boolean(node.text?.trim());
  if (node.isLeaf) return !node.isTextblock && node.type.name !== "hardBreak";
  let present = false;
  node.forEach(child => { present ||= hasContent(child); });
  return present;
}

export const EmptyArtifactCleanup = Extension.create({
  name: "emptyArtifactCleanup",
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _oldState, state) {
        if (!transactions.some(transaction => transaction.docChanged)) return null;
        const empty: Array<{ pos: number; node: PMNode }> = [];
        state.doc.descendants((node, pos) => {
          if ((node.type.name === ARTIFACT_NODE_NAME || node.type.name === ARTIFACT_INLINE_NODE_NAME)
            && !hasContent(node)) {
            empty.push({ pos, node });
            return false;
          }
          return true;
        });
        if (!empty.length) return null;
        const tr = state.tr;
        // Unwrap from the end so positions stay valid and the user's blank lines remain editable.
        for (const { pos, node } of empty.reverse()) {
          tr.replaceWith(pos, pos + node.nodeSize, node.content);
        }
        return tr;
      },
    })];
  },
});
