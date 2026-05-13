import * as Diff from "diff";

interface Change {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface DiffSpan {
  text: string;
  kind: "equal" | "insert" | "delete";
}

/**
 * Word-level diff with whitespace preserved as part of the diff token. Char
 * diff (which we started with) looked clean for short Mem-style edits but
 * exploded into interleaved red/blue scribbles on multi-paragraph rewrites,
 * because every reordered word or stray space cascades through char-by-char.
 * Word-level keeps each changed word as one delete + one insert span and
 * unchanged words stay unchanged — much closer to how users mentally diff
 * prose.
 *
 * `diffWordsWithSpace` preserves whitespace between words (vs. `diffWords`
 * which collapses it), so markdown structure (`## `, `- `, blank lines)
 * survives the diff cleanly.
 *
 * Caller renders inserts in blue and deletes in red strikethrough.
 */
export function computeTextDiff(before: string, after: string): DiffSpan[] {
  // diff@7 doesn't ship type defs; namespace-import lets us reach
  // `diffWordsWithSpace` without tripping the type checker.
  const changes = (Diff as unknown as {
    diffWordsWithSpace: (a: string, b: string) => Change[];
  }).diffWordsWithSpace(before, after);
  return changes.map((c) => ({
    text: c.value,
    kind: c.added ? "insert" : c.removed ? "delete" : "equal",
  }));
}
