import { diffChars, type Change } from "diff";

export interface DiffSpan {
  text: string;
  kind: "equal" | "insert" | "delete";
}

/**
 * Wraps diff's char-level diff into a flat array of spans, preserving order.
 * Caller renders inserts in blue and deletes in red strikethrough.
 */
export function computeTextDiff(before: string, after: string): DiffSpan[] {
  const changes: Change[] = diffChars(before, after);
  return changes.map((c) => ({
    text: c.value,
    kind: c.added ? "insert" : c.removed ? "delete" : "equal",
  }));
}
