/**
 * Spoken-to-written replacement.
 *
 * Provider hints (hints.ts) only make the right spelling MORE LIKELY. This pass is what makes a
 * `misheard → correct` entry a guarantee: after the transcript comes back, every whole-word
 * occurrence of the left side is rewritten to the right side, for every provider, on both the live
 * chunk lane and the finalize batch pass.
 *
 * Two properties the implementation exists to hold:
 *
 *  1. NO CASCADES. All sources compile into ONE alternation, applied in a single scan. A rule's
 *     output is therefore never re-examined by another rule, so `a→b` plus `b→c` cannot silently
 *     become `a→c`, and a rule whose output contains its own input cannot loop.
 *  2. LONGEST MATCH WINS. JS alternation takes the first branch that matches at a position, so
 *     sources are ordered longest-first — otherwise `acme` would shadow `acme corp` and the more
 *     specific phrase rule would never fire.
 */

import type { VocabularyTerm } from './vocabulary-term.js';

export interface ReplacementHit {
  id: string;
  scope: VocabularyTerm['scope'];
  count: number;
}

export interface ReplacementResult {
  text: string;
  /** Terms that actually fired, with occurrence counts — the source of the `usage_count` bump. */
  hits: ReplacementHit[];
}

/**
 * Ceiling on compiled rules. Far above any real dictionary; it bounds the regex the request
 * compiles so a pathological (or hostile) vocabulary can't turn one chunk into a pathological scan.
 */
export const MAX_REPLACEMENT_RULES = 500;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Unicode-aware word boundaries. `\b` is ASCII-only, so it would refuse to fire on the accented
 * and non-Latin terms this feature exists for; these lookarounds treat any letter/number/underscore
 * as "inside a word" for every script.
 */
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

const hasUppercase = (value: string) => value !== value.toLowerCase();

/**
 * Re-case the replacement to match how the source appeared.
 *
 * Only ALL-LOWERCASE replacements are adjusted. Any uppercase in what the user typed is deliberate
 * spelling ("iPhone", "eBay", "gRPC"), and "fixing" it would corrupt the exact thing they added the
 * entry to get right.
 */
export function matchCase(matched: string, replacement: string): string {
  if (hasUppercase(replacement)) return replacement;
  if (matched.length > 1 && matched === matched.toUpperCase() && matched !== matched.toLowerCase()) {
    return replacement.toUpperCase();
  }
  const first = matched[0];
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

interface CompiledRules {
  pattern: RegExp;
  /**
   * Source → owning term, keyed by BOTH the lowercased source and the original spelling.
   *
   * Lowercase alone is not a safe key: `'İ'.toLowerCase()` expands to two code points (i + U+0307),
   * and regex simple case folding cannot fold `İ` to that — so a Turkish `İstanbul → Istanbul` rule
   * keyed only by its lowercase form compiles a pattern that matches neither the text the user
   * typed nor its lowercase. Keeping the original spelling as an alternation branch and a lookup key
   * makes those rules fire.
   */
  bySource: Map<string, VocabularyTerm>;
}

/**
 * Whitespace inside a source is matched flexibly: a phrase pasted with a double space ("acme  corp")
 * would otherwise never match provider output, which always emits single spaces.
 */
function sourcePattern(source: string): string {
  return source
    .split(/\s+/)
    .map(escapeRegExp)
    .join('\\s+');
}

/**
 * Lookup key for a source or a matched span. Internal whitespace runs collapse to one space so the
 * flexible `\s+` pattern above and the `bySource` lookup agree — otherwise a phrase stored with a
 * double space would MATCH the text and then fail to resolve back to its term, silently leaving the
 * text unchanged.
 */
function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Compile the replacement rules, or null when the vocabulary holds none. */
export function compileReplacements(terms: VocabularyTerm[]): CompiledRules | null {
  const bySource = new Map<string, VocabularyTerm>();
  const rules: string[] = [];
  for (const term of terms) {
    if (!term.isReplacement) continue;
    const source = term.word.trim();
    const target = term.replacementWord?.trim();
    if (!source || !target) continue;
    // A rule that rewrites a word to ITSELF is a no-op that would still inflate usage counts.
    // Compared exactly, not case-insensitively: `acme → Acme` is a capitalization fix, one of the
    // most common entries people add, and folding case here would silently discard it.
    if (source === target) continue;
    // Cap checked BEFORE mutating, so the map can never carry an entry the alternation lacks.
    if (rules.length >= MAX_REPLACEMENT_RULES) break;
    const exact = normalizeKey(source);
    const folded = exact.toLowerCase();
    // Personal-wins is already settled upstream in mergeScopes; first writer keeps the source.
    if (bySource.has(exact) || bySource.has(folded)) continue;
    bySource.set(folded, term);
    // Only when the two differ — the common all-lowercase case adds no second key.
    if (exact !== folded) bySource.set(exact, term);
    rules.push(exact);
  }
  if (rules.length === 0) return null;

  // Longest-first so a phrase rule is never shadowed by a shorter rule that prefixes it. Both the
  // original and lowercased spellings go into the alternation (deduped) for the folding reason above.
  const branches = [...new Set(rules.flatMap(s => (s === s.toLowerCase() ? [s] : [s, s.toLowerCase()])))].sort(
    (a, b) => b.length - a.length || a.localeCompare(b)
  );
  const alternation = branches.map(sourcePattern).join('|');
  return {
    pattern: new RegExp(`${BOUNDARY_BEFORE}(?:${alternation})${BOUNDARY_AFTER}`, 'giu'),
    bySource,
  };
}

/** One scan of one fragment, accumulating hits into a caller-owned map. */
function scan(text: string, rules: CompiledRules, counts: Map<string, ReplacementHit>): string {
  // `pattern` is a global regex reused across fragments; String.replace resets lastIndex itself,
  // so successive calls are independent.
  return text.replace(rules.pattern, matched => {
    // Try the exact spelling first, then the folded one. Reachable-miss case: case-insensitive
    // matching can land on a spelling whose `toLowerCase()` is neither key (e.g. 'ſ' matching an
    // 's' rule), so fall through to leaving the text alone rather than guessing.
    const key = normalizeKey(matched);
    const term = rules.bySource.get(key) ?? rules.bySource.get(key.toLowerCase());
    if (!term || !term.replacementWord) return matched;
    const replaced = matchCase(matched, term.replacementWord.trim());
    // A rule that produced exactly what was already there did no work — counting it would inflate
    // "uses" for capitalization rules on text that was already correct.
    if (replaced === matched) return matched;
    const hit = counts.get(term.id);
    if (hit) hit.count += 1;
    else counts.set(term.id, { id: term.id, scope: term.scope, count: 1 });
    return replaced;
  });
}

/**
 * Apply the vocabulary's replacements to a transcript fragment. Returns the text unchanged (and no
 * hits) when the vocabulary carries no replacement rules — the overwhelmingly common case, which
 * costs nothing beyond the compile check.
 */
export function applyReplacements(text: string, terms: VocabularyTerm[]): ReplacementResult {
  if (!text) return { text, hits: [] };
  const rules = compileReplacements(terms);
  if (!rules) return { text, hits: [] };
  const counts = new Map<string, ReplacementHit>();
  return { text: scan(text, rules, counts), hits: [...counts.values()] };
}

/**
 * Apply replacements across many fragments (the finalize pass's diarized turns), compiling the
 * rules ONCE and aggregating usage across the whole transcript — a term used in five turns is five
 * uses of one entry, not five separate hits to reconcile.
 */
export function applyReplacementsAcross(
  texts: string[],
  terms: VocabularyTerm[]
): { texts: string[]; hits: ReplacementHit[] } {
  const rules = compileReplacements(terms);
  if (!rules) return { texts, hits: [] };
  const counts = new Map<string, ReplacementHit>();
  return { texts: texts.map(text => (text ? scan(text, rules, counts) : text)), hits: [...counts.values()] };
}
