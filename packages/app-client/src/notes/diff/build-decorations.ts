// Builds a DecorationSet visualizing a skill-run's pending changes on the live (unmodified) doc:
//   - deletions         → inline or whole-node decoration `prismical-diff-delete`
//   - text/block inserts → widget decoration rendering the inserted slice `prismical-diff-insert`
//
// The doc itself is NOT mutated. Accept applies the normal command (insertArtifactBlock /
// insertArtifactInline / setContent) and the diff plugin clears its state; Reject just clears.

import { ChangeSet, simplifyChanges } from "prosemirror-changeset";
import { DOMSerializer, Mark, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Transform } from "@tiptap/pm/transform";
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
  inlineRange?: { from: number; to: number } | null
): Transaction | null {
  const { schema } = state;
  const tr = state.tr;

  try {
    if (candidate.mode === "append-section") {
      const artifactType = schema.nodes[ARTIFACT_NODE_NAME];
      if (!artifactType) return null;
      const children = candidate.content.map(c => schema.nodeFromJSON(c));

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
      const children = candidate.content.map(c => schema.nodeFromJSON(c));
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
        candidate.content.map(c => schema.nodeFromJSON(c))
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

interface Block {
  node: PMNode;
  from: number;
  to: number;
}

function blocks(doc: PMNode): Block[] {
  const result: Block[] = [];
  doc.forEach((node, from) => result.push({ node, from, to: from + node.nodeSize }));
  return result;
}

// Match intact blocks before looking at characters. Otherwise a shared word in a paragraph and
// a new list can align across their structural boundaries and produce open, truncated widgets.
function matchingBlocks(a: Block[], b: Block[]): [number, number][] {
  const matches: [number, number][] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start]!.node.eq(b[start]!.node)) {
    matches.push([start, start]);
    start++;
  }
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1]!.node.eq(b[endB - 1]!.node)) {
    endA--;
    endB--;
  }
  const n = endA - start,
    m = endB - start;
  // Large rewrites use one complete changed region between equal prefix/suffix blocks. Bound the
  // alignment table rather than allocating quadratic memory for a very long note.
  if ((n + 1) * (m + 1) <= 250_000) {
    const width = m + 1;
    const lengths = new Uint32Array((n + 1) * width);
    const keysA = a.slice(start, endA).map(({ node }) => JSON.stringify(node.toJSON()));
    const keysB = b.slice(start, endB).map(({ node }) => JSON.stringify(node.toJSON()));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[i * width + j] =
          keysA[i] === keysB[j]
            ? 1 + lengths[(i + 1) * width + j + 1]!
            : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }
    let i = 0,
      j = 0;
    while (i < n && j < m) {
      if (keysA[i] === keysB[j]) {
        matches.push([start + i++, start + j++]);
      } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
        i++;
      } else {
        j++;
      }
    }
  }
  while (endA < a.length && endB < b.length) matches.push([endA++, endB++]);
  return matches;
}

function textOnly(node: PMNode): boolean {
  // The changeset compares UTF-16 units. Keep emoji and combining-character clusters intact.
  let result =
    node.isTextblock &&
    !/[\uD800-\uDBFF\u200D]/.test(node.textContent) &&
    !/\p{M}/u.test(node.textContent);
  node.forEach(child => {
    result &&= child.isText;
  });
  return result;
}

type TextToken = { char: number; marks: readonly Mark[] } | string;

// Compute visual changes without mutating the live document or the candidate transaction.
export function buildDiffDecorations(
  originalDoc: PMNode,
  candidateTr: Transaction,
  schema: Schema
): DecorationSet {
  if (candidateTr.steps.length === 0 || originalDoc.eq(candidateTr.doc)) return DecorationSet.empty;
  const original = blocks(originalDoc),
    proposed = blocks(candidateTr.doc);
  const decorations: Decoration[] = [];
  const serializer = DOMSerializer.fromSchema(schema);

  const insert = (position: number, content: PMNode["content"], block: boolean) => {
    decorations.push(
      Decoration.widget(
        position,
        () => {
          const wrapper = document.createElement(block ? "div" : "span");
          wrapper.className = "prismical-diff-insert";
          wrapper.contentEditable = "false";
          wrapper.appendChild(serializer.serializeFragment(content));
          return wrapper;
        },
        // Rebuild the DOM for each proposal; positional keys can reuse a stale same-length draft.
        // The serialized candidate owns its marks; never inherit marks from adjacent source text.
        { side: 1, ignoreSelection: true, marks: [] }
      )
    );
  };

  const inline = (oldBlock: Block, newBlock: Block) => {
    const tr = new Transform(oldBlock.node).replaceWith(
      0,
      oldBlock.node.content.size,
      newBlock.node.content
    );
    const changes = ChangeSet.create(oldBlock.node, undefined, {
      // Marks are part of the proposed change too: the default encoder ignores them.
      encodeCharacter: (char, marks): TextToken => ({ char, marks }),
      encodeNodeStart: node => node.type.name,
      encodeNodeEnd: node => node.type.name,
      compareTokens: (a: TextToken, b: TextToken) =>
        typeof a === "string" || typeof b === "string"
          ? a === b
          : a.char === b.char && Mark.sameSet(a.marks, b.marks),
    }).addSteps(tr.doc, tr.mapping.maps, null);
    for (const change of simplifyChanges(changes.changes, tr.doc)) {
      const offset = oldBlock.from + 1;
      if (change.toA > change.fromA) {
        decorations.push(
          Decoration.inline(offset + change.fromA, offset + change.toA, {
            class: "prismical-diff-delete",
          })
        );
      }
      if (change.toB > change.fromB) {
        // Both roots are textblocks containing only text/marks, so this is a closed inline slice.
        insert(offset + change.toA, tr.doc.slice(change.fromB, change.toB).content, false);
      }
    }
  };

  let fromA = 0,
    fromB = 0;
  for (const [toA, toB] of [
    ...matchingBlocks(original, proposed),
    [original.length, proposed.length] as [number, number],
  ]) {
    const oldBlocks = original.slice(fromA, toA),
      newBlocks = proposed.slice(fromB, toB);
    if (
      oldBlocks.length === 1 &&
      newBlocks.length === 1 &&
      textOnly(oldBlocks[0]!.node) &&
      textOnly(newBlocks[0]!.node) &&
      oldBlocks[0]!.node.sameMarkup(newBlocks[0]!.node)
    ) {
      inline(oldBlocks[0]!, newBlocks[0]!);
    } else {
      for (const block of oldBlocks) {
        // The editor's lone empty paragraph is a caret/placeholder host, not deleted content.
        if (
          original.length === 1 &&
          block.node.type.name === "paragraph" &&
          block.node.content.size === 0
        )
          continue;
        decorations.push(Decoration.node(block.from, block.to, { class: "prismical-diff-delete" }));
      }
      if (newBlocks.length) {
        const start = newBlocks[0]!.from,
          end = newBlocks[newBlocks.length - 1]!.to;
        // Complete top-level nodes only: lists, tables, headings and artifact wrappers retain their
        // structure, and a block widget always lands between blocks, never inside a paragraph.
        const position = original[toA]?.from ?? originalDoc.content.size;
        insert(position, candidateTr.doc.slice(start, end).content, true);
      }
    }
    fromA = toA + 1;
    fromB = toB + 1;
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
