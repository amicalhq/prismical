/**
 * Client-side tag-name rule.
 *
 * Web restricts new tag names to LETTERS + NUMBERS ONLY (`^[A-Za-z0-9]+$`, max 50) — a deliberately
 * stricter subset of the backend charset (`^[A-Za-z0-9][A-Za-z0-9_-]*$` in
 * the server, which the `/me` create lane ENFORCES by rejecting with a 400).
 * Because our charset is a subset, any name the picker produces always passes that server rule, so
 * the create POST never 400s on the name.
 *
 * The picker enforces the charset INLINE: `sanitizeTagNameInput` strips every disallowed keystroke
 * (space, `-`, `_`, punctuation, emoji, …) as the user types, so the field can only ever hold a
 * valid name and the "Create '<name>'" row shows the typed name verbatim (no normalization preview).
 *
 * Existing tags that predate this rule (or came from desktop/mobile, which allow `-`/`_`) still
 * render and remain selectable; they simply can't be RE-created by typing here.
 *
 * (The regex is duplicated from the backend because the client cannot import server code; a future
 * `@prismical/tag-name` shared package would remove the duplication.)
 */

/** Max tag-name length. Matches the backend cap. */
export const TAG_NAME_MAX_LENGTH = 50;

/** Web charset: ASCII letters and digits only (a subset of the backend rule). */
export const TAG_NAME_PATTERN = /^[A-Za-z0-9]+$/;

/** True when `name` is a valid web tag name (non-empty, letters/numbers only, ≤ max length). */
export function isValidTagName(name: string): boolean {
  return name.length > 0 && name.length <= TAG_NAME_MAX_LENGTH && TAG_NAME_PATTERN.test(name);
}

/**
 * Inline-enforce transform for the tag input: drop every character outside `[A-Za-z0-9]` and cap the
 * length. TOTAL — the result is either empty (nothing typeable survived) or a valid tag name.
 * Applied on every keystroke (`onValueChange`) so the field can only ever hold letters and numbers.
 */
export function sanitizeTagNameInput(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "").slice(0, TAG_NAME_MAX_LENGTH);
}
