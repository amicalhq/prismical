/**
 * Client-side tag-name rule — mirrors the server's `/me` normalization:
 * ASCII letters and digits only, max 50,
 * case-insensitive uniqueness. Enforced BEFORE the wire so an optimistic write
 * can never flicker back normalized; parity with the server transform is
 * pinned by the server's client-contract test ("client sanitize ≡ server normalize").
 * One deliberate difference: a name that sanitizes to
 * EMPTY is refused by callers (the server's total-function fallback to the
 * literal 'tag' is unreachable from this client).
 */
export const TAG_NAME_MAX = 50;

/** Strip disallowed chars + clamp length — safe to apply keystroke-by-keystroke. */
export const sanitizeTagNameInput = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9]/g, "").slice(0, TAG_NAME_MAX);
