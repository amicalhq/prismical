import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import type { ResolvedPos } from "@tiptap/pm/model";
import { ARTIFACT_NODE_NAME } from "./nodes/artifact-node";

// Find the closest ancestor of `$pos` that is an artifact node. Returns the
// depth at which the artifact lives, or null if `$pos` is outside any artifact.
function findArtifactDepth($pos: ResolvedPos): number | null {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === ARTIFACT_NODE_NAME) return d;
  }
  return null;
}

// Caret is on the top edge of the artifact if every node between the leaf
// and the artifact is the first child of its parent, AND the offset within
// the leaf is 0.
function isAtTopEdge($pos: ResolvedPos, aDepth: number): boolean {
  for (let d = aDepth + 1; d <= $pos.depth; d++) {
    if ($pos.index(d - 1) !== 0) return false;
  }
  return $pos.parentOffset === 0;
}

// Caret is on the bottom edge of the artifact if every node between the
// leaf and the artifact is the last child of its parent, AND the offset
// within the leaf is at the end of the parent's content.
function isAtBottomEdge($pos: ResolvedPos, aDepth: number): boolean {
  for (let d = aDepth + 1; d <= $pos.depth; d++) {
    const parent = $pos.node(d - 1);
    if ($pos.index(d - 1) !== parent.childCount - 1) return false;
  }
  return $pos.parentOffset === $pos.parent.content.size;
}

const artifactEscapeKey = new PluginKey("prismical-artifact-escape");

export const ArtifactEscape = Extension.create({
  name: "artifactEscape",

  addKeyboardShortcuts() {
    const tryEscapeUp = (requireEmpty: boolean) => {
      return ({ editor }: { editor: Editor }): boolean => {
        const { state, view } = editor;
        const { $from, empty } = state.selection;
        if (!empty) return false;

        const aDepth = findArtifactDepth($from);
        if (aDepth === null) return false;
        if (!isAtTopEdge($from, aDepth)) return false;
        if (requireEmpty && $from.parent.content.size !== 0) return false;

        const artifactStart = $from.before(aDepth);
        const tr = state.tr;
        const sel = Selection.near(tr.doc.resolve(artifactStart), -1);

        // If `near` lands us back inside the artifact (no preceding
        // sibling — e.g. the artifact is the first block in the doc),
        // insert a paragraph before it and land in it. Walk sel.$from's
        // own depth chain rather than indexing at `aDepth` directly,
        // since Selection.near may return a node selection at a shallower
        // depth than the original — `node(aDepth)` would throw in that
        // case.
        let stillInArtifact = false;
        for (let d = sel.$from.depth; d > 0; d--) {
          if (sel.$from.node(d).type.name === ARTIFACT_NODE_NAME) {
            stillInArtifact = true;
            break;
          }
        }
        if (stillInArtifact) {
          const para = state.schema.nodes.paragraph.createAndFill();
          if (!para) return false;
          tr.insert(artifactStart, para);
          tr.setSelection(
            TextSelection.near(tr.doc.resolve(artifactStart + 1), -1),
          );
        } else {
          tr.setSelection(sel);
        }
        view.dispatch(tr);
        return true;
      };
    };

    const tryEscapeDown = (requireEmpty: boolean) => {
      return ({ editor }: { editor: Editor }): boolean => {
        const { state, view } = editor;
        const { $from, empty } = state.selection;
        if (!empty) return false;

        const aDepth = findArtifactDepth($from);
        if (aDepth === null) return false;
        if (!isAtBottomEdge($from, aDepth)) return false;
        if (requireEmpty && $from.parent.content.size !== 0) return false;

        const artifactEnd = $from.after(aDepth);
        const tr = state.tr;
        const after = state.doc.nodeAt(artifactEnd);
        if (!after) {
          // Defensive: the appendTransaction below normally creates a
          // trailing paragraph; insert one inline if for some reason it
          // hasn't fired yet.
          const para = state.schema.nodes.paragraph.createAndFill();
          if (!para) return false;
          tr.insert(artifactEnd, para);
          tr.setSelection(
            TextSelection.near(tr.doc.resolve(artifactEnd + 1), 1),
          );
        } else {
          tr.setSelection(
            Selection.near(state.doc.resolve(artifactEnd + 1), 1),
          );
        }
        view.dispatch(tr);
        return true;
      };
    };

    return {
      // Enter only escapes from an empty leaf at the bottom edge; otherwise
      // we'd block normal newline insertion at the end of a non-empty paragraph.
      Enter: tryEscapeDown(true),
      ArrowDown: tryEscapeDown(false),
      ArrowUp: tryEscapeUp(false),
      // Backspace at the top edge always escapes — we don't distinguish
      // Shift-Backspace here, treating both as "leave the artifact"
      // rather than swallowing them as a no-op delete.
      Backspace: tryEscapeUp(false),
    };
  },

  addProseMirrorPlugins() {
    return [
      // Mirror of the Lexical node-transform: every artifact must have a
      // trailing block-level sibling so the caret has somewhere to land
      // when escaping downward. Runs on every transaction; idempotent.
      new Plugin({
        key: artifactEscapeKey,
        appendTransaction: (_transactions, _oldState, newState) => {
          const insertions: number[] = [];
          newState.doc.forEach((child, offset) => {
            if (child.type.name !== ARTIFACT_NODE_NAME) return;
            const end = offset + child.nodeSize;
            const next = newState.doc.nodeAt(end);
            if (!next) insertions.push(end);
          });
          if (insertions.length === 0) return null;

          const tr = newState.tr;
          // Apply insertions in reverse so earlier offsets remain valid.
          for (let i = insertions.length - 1; i >= 0; i--) {
            const para = newState.schema.nodes.paragraph.createAndFill();
            if (!para) continue;
            tr.insert(insertions[i], para);
          }
          return tr;
        },
      }),
    ];
  },
});
