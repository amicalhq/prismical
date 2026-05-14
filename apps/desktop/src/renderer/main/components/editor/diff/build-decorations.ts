// Builds a DecorationSet that visualizes a skill-run's pending changes on
// the live (unmodified) doc:
//   - text deletions  → inline decoration with `prismical-diff-delete`
//   - text/block inserts → widget decoration rendering the inserted slice
//     with `prismical-diff-insert`
//
// The doc itself isn't mutated. Accept applies the normal command
// (insertArtifactBlock / insertArtifactInline / setContent) and the diff
// plugin clears its state; Reject just clears.

import { ChangeSet } from "prosemirror-changeset";
import { DOMSerializer, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import {
  ARTIFACT_NODE_NAME,
  type ArtifactNodeMetadata,
} from "@/renderer/main/components/editor/nodes/artifact-node";
import {
  ARTIFACT_INLINE_NODE_NAME,
  type ArtifactInlineNodeMetadata,
} from "@/renderer/main/components/editor/nodes/artifact-inline-node";
import type { SkillDiffCandidate } from "./skill-diff-store";

// Materialize a transaction that *would* commit the candidate. We never
// dispatch this tr — we just use its `doc` + `steps` to feed
// prosemirror-changeset. Returns null if the candidate cannot be applied
// against the current state (e.g. stale inline selection).
export function buildCandidateTransaction(
  state: EditorState,
  candidate: SkillDiffCandidate,
): Transaction | null {
  const { schema } = state;
  const tr = state.tr;

  try {
    if (candidate.mode === "append-section") {
      const children = candidate.content.map((c) => schema.nodeFromJSON(c));

      // Regen invariant: replace an existing artifact for the same skill in
      // place; otherwise append at end.
      let existingPos: number | null = null;
      state.doc.descendants((node, pos) => {
        if (existingPos !== null) return false;
        if (
          node.type.name === ARTIFACT_NODE_NAME &&
          node.attrs.skillId === candidate.skillId
        ) {
          existingPos = pos;
          return false;
        }
        return true;
      });

      if (existingPos !== null) {
        const existing = state.doc.nodeAt(existingPos);
        if (existing) {
          // Reuse the EXISTING artifact's attrs for the diff. The audit row
          // hasn't been written yet, so we don't have new artifactId /
          // version / generatedAt — and using placeholders would make the
          // changeset see an attribute change at the wrapper level and
          // visualize the whole subtree as deleted+re-inserted. Carrying
          // existing attrs forward focuses the diff on the body children,
          // which is what changed. Accept overwrites attrs with server-
          // allocated audit meta via insertArtifactBlock.
          const artifactNode = schema.nodes[ARTIFACT_NODE_NAME].create(
            existing.attrs,
            children,
          );
          tr.replaceWith(
            existingPos,
            existingPos + existing.nodeSize,
            artifactNode,
          );
        }
      } else {
        const artifactNode = schema.nodes[ARTIFACT_NODE_NAME].create(
          pickBlockMetadata(candidate),
          children,
        );
        tr.insert(state.doc.content.size, artifactNode);
      }
      return tr;
    }

    if (candidate.mode === "replace-doc") {
      const children = candidate.content.map((c) => schema.nodeFromJSON(c));
      tr.replaceWith(0, state.doc.content.size, children);
      return tr;
    }

    if (candidate.mode === "inline-rewrite") {
      const meta = pickInlineMetadata(candidate);
      const childNodes = candidate.content.map((c) => schema.nodeFromJSON(c));
      const inlineNode = schema.nodes[ARTIFACT_INLINE_NODE_NAME].create(
        meta,
        childNodes,
      );

      const range = candidate.selectionPoints;
      if (!range) return null;
      // Defend against stale positions from a snapshot taken before the
      // user typed elsewhere.
      const docSize = state.doc.content.size;
      if (
        range.from < 0 ||
        range.to > docSize ||
        range.from > range.to
      ) {
        return null;
      }
      tr.replaceWith(range.from, range.to, inlineNode);
      return tr;
    }
  } catch (err) {
    // Schema mismatch or malformed payload — fail closed so the action bar
    // can degrade to no decorations rather than crashing the editor.
    console.warn("buildCandidateTransaction failed", err);
    return null;
  }

  return null;
}

// Compute the DecorationSet for `originalDoc` reflecting the changes that
// `candidateTr` would apply.
export function buildDiffDecorations(
  originalDoc: PMNode,
  candidateTr: Transaction,
  schema: Schema,
): DecorationSet {
  if (candidateTr.steps.length === 0) return DecorationSet.empty;

  const cs = ChangeSet.create(originalDoc).addSteps(
    candidateTr.doc,
    candidateTr.mapping.maps,
    null,
  );

  const decorations: Decoration[] = [];
  const serializer = DOMSerializer.fromSchema(schema);

  for (const change of cs.changes) {
    // Deletions: span the removed range in the original doc with the
    // delete class. ProseMirror's inline decorations apply to text content
    // only; widget decorations carry block-level deletions.
    if (change.toA > change.fromA) {
      decorations.push(
        Decoration.inline(change.fromA, change.toA, {
          class: "prismical-diff-delete",
        }),
      );
    }

    // Insertions: render the post-doc slice as a widget at the original
    // position where the new content would land. Pick the wrapper element
    // based on BOTH the insertion's content AND the surrounding context —
    // a <div> wrapper inside a textblock (<p>) produces invalid HTML and
    // makes the browser silently close the paragraph early, breaking
    // selection geometry. When the resolved parent is a textblock we
    // always use <span>, even if the inserted slice carries blocks (which
    // wouldn't be valid in that position anyway).
    if (change.toB > change.fromB) {
      const slice = candidateTr.doc.slice(change.fromB, change.toB);
      const $pos = originalDoc.resolve(change.fromA);
      const inlineContext = $pos.parent.isTextblock;
      const insertedIsBlock = slice.content.firstChild?.isBlock ?? false;
      const tag = !inlineContext && insertedIsBlock ? "div" : "span";

      const widget = (): HTMLElement => {
        const wrapper = document.createElement(tag);
        wrapper.className = "prismical-diff-insert";
        wrapper.contentEditable = "false";
        wrapper.appendChild(serializer.serializeFragment(slice.content));
        return wrapper;
      };

      decorations.push(
        Decoration.widget(change.fromA, widget, {
          // Render the insert AFTER any same-position deletion so the
          // visual order is "old (struck-through) → new".
          side: 1,
          ignoreSelection: true,
          // Stable key so React/ProseMirror reuses the DOM if the user
          // refines and the same insertion point persists.
          key: `ins-${change.fromA}-${change.fromB}-${change.toB}`,
        }),
      );
    }
  }

  return DecorationSet.create(originalDoc, decorations);
}

function pickBlockMetadata(
  c: SkillDiffCandidate,
): ArtifactNodeMetadata {
  // The pre-accept candidate has placeholder values for artifactId / version
  // / generatedAt (the audit row hasn't been written yet). The diff just
  // needs the structural shape — the *real* values get written when Accept
  // dispatches insertArtifactBlock with the server-allocated meta.
  return {
    artifactId: "",
    skillId: c.skillId,
    skillName: c.skillName,
    version: 0,
    generatedAt: "",
    modelId: c.modelId,
  };
}

function pickInlineMetadata(
  c: SkillDiffCandidate,
): ArtifactInlineNodeMetadata {
  return {
    artifactId: "",
    skillId: c.skillId,
    skillName: c.skillName,
  };
}
