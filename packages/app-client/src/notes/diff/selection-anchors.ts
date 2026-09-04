import type { EditorState } from "@tiptap/pm/state";
import * as Y from "yjs";
// IMPORTANT: import from @tiptap/y-tiptap (TipTap v3's y-prosemirror fork), NOT y-prosemirror.
// The Collaboration extension registers ITS fork's ySyncPlugin; the vanilla package's PluginKey is
// a different instance, so its getState() returns undefined against this editor.
import {
  ySyncPluginKey,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";

// Yjs relative positions anchoring an inline-rewrite's target range.
//
// Why not plain {from,to} integers (the desktop's approach)? Absolute positions are only valid
// against the doc version they were captured on. Here the doc keeps moving under a staged
// candidate — the user can type during the (unlocked) model run, and remote collaborators edit at
// any time (SkillDiffEditorLock deliberately lets y-sync transactions through). Stale integers
// don't go out of range, they silently SHIFT — and accept would rewrite the wrong span. Relative
// positions are the CRDT-native anchor (same primitive as collaborative cursors): they re-resolve
// correctly through concurrent edits, offline buffering, and even editor re-creation (switching
// notes and back), and a deleted target collapses to an empty range we can detect and refuse.
export interface SelectionAnchors {
  /** `Y.relativePositionToJSON` of the range start — plain JSON, safe to hold in zustand. */
  relFrom: unknown;
  /** `Y.relativePositionToJSON` of the range end. */
  relTo: unknown;
}

/** Encode [from,to] of `state`'s doc as relative anchors. null ⇒ no y-sync binding (shouldn't
 * happen in the collab editor; callers fail the run rather than fall back to raw integers). */
export function captureSelectionAnchors(
  state: EditorState,
  from: number,
  to: number,
): SelectionAnchors | null {
  const ystate = ySyncPluginKey.getState(state);
  if (!ystate?.type || !ystate.binding) return null;
  try {
    return {
      relFrom: Y.relativePositionToJSON(
        absolutePositionToRelativePosition(from, ystate.type, ystate.binding.mapping),
      ),
      relTo: Y.relativePositionToJSON(
        absolutePositionToRelativePosition(to, ystate.type, ystate.binding.mapping),
      ),
    };
  } catch (err) {
    console.warn("captureSelectionAnchors failed", err);
    return null;
  }
}

/** Resolve anchors against the CURRENT doc. null ⇒ unresolvable (no y-sync state / malformed).
 * A resolved-but-collapsed range (from === to) means the target text was deleted — callers must
 * treat that as "the selection no longer exists", not as a valid empty target.
 * Prefer resolveVerifiedRange: raw anchor resolution has boundary-association quirks. */
export function resolveSelectionAnchors(
  state: EditorState,
  anchors: SelectionAnchors,
): { from: number; to: number } | null {
  const ystate = ySyncPluginKey.getState(state);
  if (!ystate?.type || !ystate.binding || !ystate.doc) return null;
  try {
    const from = relativePositionToAbsolutePosition(
      ystate.doc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchors.relFrom),
      ystate.binding.mapping,
    );
    const to = relativePositionToAbsolutePosition(
      ystate.doc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchors.relTo),
      ystate.binding.mapping,
    );
    if (from == null || to == null || from > to) return null;
    return { from, to };
  } catch (err) {
    console.warn("resolveSelectionAnchors failed", err);
    return null;
  }
}

/**
 * Resolve anchors AND verify the range still spells exactly `selectionText` — the contract the
 * rewrite was generated against. Returns the range only when that text is intact:
 *
 *  - Anchors at a textblock's edge stick to the block, not a character, so a remote insert at the
 *    boundary lands INSIDE the raw resolved range (observed live: a collaborator's prefix typed at
 *    paragraph start got swallowed — accepting would have deleted their text). When the resolved
 *    text mismatches but the original selection text still exists intact and uniquely within the
 *    containing textblock, snap to it.
 *  - If someone edited INSIDE the target text, no exact match exists — return null. Replacing
 *    would stomp their edit with a rewrite of stale text; the caller fails with a "re-run" toast.
 */
export function resolveVerifiedRange(
  state: EditorState,
  anchors: SelectionAnchors,
  selectionText: string,
): { from: number; to: number } | null {
  if (!selectionText) return null;
  const range = resolveSelectionAnchors(state, anchors);
  if (!range) return null;
  return verifyRangeAgainstDoc(state.doc, range, selectionText);
}

/** The pure verify/snap half of resolveVerifiedRange (split out for unit tests). */
export function verifyRangeAgainstDoc(
  doc: EditorState["doc"],
  range: { from: number; to: number },
  selectionText: string,
): { from: number; to: number } | null {
  const read = (a: number, b: number) => doc.textBetween(a, b, " ");

  if (range.from < range.to && read(range.from, range.to) === selectionText) return range;

  // Snap: re-find the exact selection text inside the textblock the range resolved into.
  const $probe = doc.resolve(Math.min(range.from, doc.content.size));
  const parent = $probe.parent;
  if (!parent.isTextblock) return null;
  const blockStart = $probe.start();
  const blockText = read(blockStart, blockStart + parent.content.size);
  // Atom/leaf nodes make text offsets diverge from doc positions — refuse rather than guess.
  if (blockText.length !== parent.content.size) return null;
  const first = blockText.indexOf(selectionText);
  if (first === -1) return null;
  // Ambiguous (text appears twice) — refuse to guess which occurrence was selected.
  if (blockText.indexOf(selectionText, first + 1) !== -1) return null;
  return { from: blockStart + first, to: blockStart + first + selectionText.length };
}
