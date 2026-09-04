/**
 * Turning vocabulary rows into whisper-class recognition hints.
 *
 * Whisper-class decoders (OpenAI ASR, Groq whisper, whisper.cpp) take an initial `prompt`, a short
 * piece of text that biases the first window. Whisper's prompt is capped at 224 tokens by the
 * architecture, so the budget here is CHARACTERS and deliberately conservative.
 *
 * Hints name the SPELLING WE WANT TO SEE, not the misheard form. For a replacement entry
 * (`misheard → correct`) that is the RIGHT side: boosting the left side would ask the decoder to
 * produce more of the very output the user asked us to correct. The left side still matters — it
 * drives the deterministic replacement pass in replace.ts, which is what actually guarantees the
 * fix. Hints are best-effort; replacements are not.
 */

import type { VocabularyTerm } from './vocabulary-term.js';

/**
 * Per-term character ceiling for any recognition hint.
 *
 * A SAFETY bound, not a style preference: the `word` column is unbounded text, so without it one
 * pathological entry (a document pasted into the word field) would dominate every hint built from
 * that vocabulary. Over-long terms are DROPPED, never truncated: half a phrase is not the phrase,
 * and hinting a meaningless prefix is worse than hinting nothing.
 */
export const MAX_HINT_TERM_CHARS = 100;

/**
 * Character budget for a whisper-class prompt. Whisper truncates at 224 TOKENS; at the usual
 * ~4-chars-per-token this leaves generous headroom, and overshooting silently drops the tail
 * (which would make the hint list order-dependent in a way nobody could see).
 */
export const WHISPER_PROMPT_MAX_CHARS = 700;

/**
 * The spelling the transcript should contain. Replacement entries target their correct spelling;
 * teach-only entries target the word itself. A replacement row with a blank right side is
 * malformed data (the UI requires it) — fall back to the word rather than emitting an empty hint.
 */
export function targetSpelling(term: VocabularyTerm): string {
  return term.isReplacement && term.replacementWord ? term.replacementWord : term.word;
}

/** Unique target spellings, source order preserved, blanks dropped. */
export function targets(terms: VocabularyTerm[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const target = targetSpelling(term).trim();
    if (!target) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * A whisper-class initial prompt: the terms as a comma-separated list. Whisper conditions on this
 * as if it were the transcript's preceding text, so a plain vocabulary list (rather than an
 * instruction like "use these words") is the form that actually biases decoding — an instruction
 * risks being transcribed back out into the output.
 *
 * Returns undefined when there is nothing to say, so callers can omit the option entirely.
 */
export function whisperPrompt(
  terms: VocabularyTerm[],
  maxChars: number = WHISPER_PROMPT_MAX_CHARS
): string | undefined {
  const included: string[] = [];
  let length = 0;
  for (const target of targets(terms)) {
    // Skip-and-continue rather than break: a single huge entry must not truncate the list.
    if (target.length > MAX_HINT_TERM_CHARS) continue;
    // +2 for the ", " separator on every term after the first.
    const cost = target.length + (included.length ? 2 : 0);
    if (length + cost > maxChars) break;
    included.push(target);
    length += cost;
  }
  return included.length ? included.join(', ') : undefined;
}
