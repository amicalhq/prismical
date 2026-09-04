// Builds a DecorationSet visualizing a skill-run's pending changes on the live (unmodified) doc:
//   - text deletions    → inline decoration `prismical-diff-delete`
//   - text/block inserts → widget decoration rendering the inserted slice `prismical-diff-insert`
//
// The doc itself is NOT mutated. Accept applies the normal command (insertArtifactBlock /
// insertArtifactInline / setContent) and the diff plugin clears its state; Reject just clears.

import { ChangeSet } from "prosemirror-changeset";
import { DOMSerializer, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { ARTIFACT_NODE_NAME, ARTIFACT_INLINE_NODE_NAME } from "@prismical/editor-schema";
import type { ArtifactNodeMetadata } from "../artifact-node-commands";
import type { SkillDiffCandidate } from "./skill-diff-store";

// Materialize a transaction that *would* commit the candidate. We never dispatch this tr — we use
// its `doc` + `steps` to feed prosemirror-changeset. Returns null if the candidate can't apply
// (e.g. unsupported mode, or an inline range that no longer exists) so the caller degrades to no
// decorations rather than crashing.
//
// `inlineRange` is the candidate's selection anchors ALREADY resolved against `state` by the
// caller (resolveSelectionAnchors needs the editor's y-sync plugin state; keeping the resolution
// out of here leaves this module pure and unit-testable). Required for inline-rewrite; ignored
// otherwise.
export function buildCandidateTransaction(
  state: EditorState,
  candidate: SkillDiffCandidate,
  inlineRange?: { from: number; to: number } | null,
): Transaction | null {
  const { schema } = state;
  const tr = state.tr;

  try {
    if (candidate.mode === "append-section") {
      const artifactType = schema.nodes[ARTIFACT_NODE_NAME];
      if (!artifactType) return null;
      const children = candidate.content.map((c) => schema.nodeFromJSON(c));

      // Regen invariant: replace an existing artifact for the same skill in place; else append.
      let existingPos: number | null = null;
      state.doc.descendants((node, pos) => {
        if (existingPos !== null) return false;
        if (node.type.name === ARTIFACT_NODE_NAME && node.attrs.skillId === candidate.skillId) {
          existingPos = pos;
          return false;
        }
        return true;
      });

      if (existingPos !== null) {
        const existing = state.doc.nodeAt(existingPos);
        if (existing) {
          // Reuse the EXISTING artifact's attrs so the changeset diffs the body children, not the
          // wrapper's (placeholder) audit attrs. Accept overwrites attrs with server-allocated meta.
          const artifactNode = artifactType.create(existing.attrs, children);
          tr.replaceWith(existingPos, existingPos + existing.nodeSize, artifactNode);
        }
      } else {
        const artifactNode = artifactType.create(pickBlockMetadata(candidate), children);
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
      // A missing/collapsed range means the target text is gone (deleted locally or by a
      // collaborator) — no preview; the caller clears the candidate with an explanatory toast.
      if (!inlineRange || inlineRange.from >= inlineRange.to) return null;
      const { from, to } = inlineRange;
      if (from < 0 || to > state.doc.content.size) return null;
      // The wrapper is inline-only: the range must still sit inside ONE textblock.
      const $from = state.doc.resolve(from);
      const $to = state.doc.resolve(to);
      if (!$from.parent.inlineContent || !$from.sameParent($to)) return null;

      const inlineType = schema.nodes[ARTIFACT_INLINE_NODE_NAME];
      if (!inlineType) return null;
      const inlineNode = inlineType.create(
        // Pre-accept placeholders, same rationale as pickBlockMetadata.
        { artifactId: "", skillId: candidate.skillId, skillName: candidate.skillName },
        candidate.content.map((c) => schema.nodeFromJSON(c)),
      );
      tr.replaceWith(from, to, inlineNode);
      return tr;
    }
  } catch (err) {
    // Schema mismatch or malformed payload — fail closed.
    console.warn("buildCandidateTransaction failed", err);
    return null;
  }

  // Unknown mode → no preview.
  return null;
}

// Compute the DecorationSet for `originalDoc` reflecting the changes `candidateTr` would apply.
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
    // Deletions: span the removed range in the original doc with the delete class.
    if (change.toA > change.fromA) {
      decorations.push(
        Decoration.inline(change.fromA, change.toA, { class: "prismical-diff-delete" }),
      );
    }

    // Insertions: render the post-doc slice as a widget at the original landing position. Wrapper
    // tag depends on context — a <div> inside a textblock (<p>) is invalid HTML and breaks
    // selection geometry, so a textblock parent always gets a <span>.
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
          // Render the insert AFTER any same-position deletion: "old (struck-through) → new".
          side: 1,
          ignoreSelection: true,
          key: `ins-${change.fromA}-${change.fromB}-${change.toB}`,
        }),
      );
    }
  }

  return DecorationSet.create(originalDoc, decorations);
}

function pickBlockMetadata(c: SkillDiffCandidate): ArtifactNodeMetadata {
  // Pre-accept placeholders — the audit row isn't written yet. The diff only needs the structural
  // shape; Accept writes the real values via insertArtifactBlock with server-allocated meta.
  return {
    artifactId: "",
    skillId: c.skillId,
    skillName: c.skillName,
    version: 0,
    generatedAt: "",
    modelId: c.modelId,
  };
}
