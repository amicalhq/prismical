/**
 * Minimal ambient type declaration for the `diff` package (v7).
 * The package ships no bundled types and @types/diff@8 is an empty stub.
 */
declare module "diff" {
  export interface Change {
    /** The text content of the change. */
    value: string;
    /** True if this range was added. */
    added?: boolean;
    /** True if this range was removed. */
    removed?: boolean;
    /** Number of lines in the change (for line-level diffs). */
    count?: number;
  }

  /** Character-level diff. Returns an array of Change objects. */
  export function diffChars(
    oldStr: string,
    newStr: string,
    options?: { ignoreCase?: boolean },
  ): Change[];

  /** Word-level diff. */
  export function diffWords(oldStr: string, newStr: string): Change[];

  /** Line-level diff. */
  export function diffLines(oldStr: string, newStr: string): Change[];
}
