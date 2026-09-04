/**
 * Pure helpers for the Ask composer's `@`-mention autocomplete. The composer is a plain `<textarea>`,
 * so a mention is detected from the raw text + caret and committed as inline text (`@<Title>`), while
 * the matching note/folder/tag is also added as a context chip (see `ask-mention.tsx`).
 */

export interface MentionQuery {
  /** Index of the triggering `@` in the value. */
  start: number;
  /** Caret index — the end (exclusive) of the typed query. */
  end: number;
  /** The text typed after `@` (may be empty when the user has just typed `@`). */
  query: string;
}

/**
 * Detect an active `@`-mention being typed: an `@` at the start of the value or right after
 * whitespace, followed by a run of non-whitespace characters up to the caret. Returns null when the
 * caret isn't inside such a token — so an email address (`a@b`) or a committed mention that contains a
 * space (`@Q3 Roadmap`) doesn't re-trigger.
 */
export function parseMention(value: string, caret: number): MentionQuery | null {
  if (caret < 1 || caret > value.length) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i]!;
    if (ch === "@") break;
    if (/\s/.test(ch)) return null; // hit whitespace before any '@' → not a mention
    i--;
  }
  if (i < 0 || value[i] !== "@") return null;
  // The '@' must start the value or follow whitespace (not be part of e.g. an email).
  if (i > 0 && !/\s/.test(value[i - 1]!)) return null;
  return { start: i, end: caret, query: value.slice(i + 1, caret) };
}

/**
 * Replace the active mention token (`@query`) with `@<label>` (the resolved title). Adds a trailing
 * space only when one isn't already there, and returns the caret position just after the inserted
 * text (before any pre-existing trailing space).
 */
export function applyMention(
  value: string,
  mention: { start: number; end: number },
  label: string,
): { value: string; caret: number } {
  const core = `@${label}`;
  const needsSpace = mention.end >= value.length || !/\s/.test(value[mention.end]!);
  const insert = needsSpace ? `${core} ` : core;
  const next = value.slice(0, mention.start) + insert + value.slice(mention.end);
  return { value: next, caret: mention.start + insert.length };
}
