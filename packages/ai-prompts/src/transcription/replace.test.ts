import { describe, expect, it } from 'vitest';
import { applyReplacements, compileReplacements, matchCase, MAX_REPLACEMENT_RULES } from './replace.js';
import type { VocabularyTerm } from './vocabulary-term.js';

let seq = 0;
function replacement(word: string, replacementWord: string, scope: 'personal' | 'team' = 'personal'): VocabularyTerm {
  return { id: `vcb_${++seq}`, scope, word, replacementWord, isReplacement: true };
}
function teachOnly(word: string): VocabularyTerm {
  return { id: `vcb_${++seq}`, scope: 'personal', word, replacementWord: null, isReplacement: false };
}

describe('applyReplacements', () => {
  it('rewrites whole-word occurrences and counts them', () => {
    const terms = [replacement('oldapp', 'Prismical')];
    const result = applyReplacements('I opened oldapp, then closed oldapp.', terms);
    expect(result.text).toBe('I opened Prismical, then closed Prismical.');
    expect(result.hits).toEqual([{ id: terms[0]!.id, scope: 'personal', count: 2 }]);
  });

  it('leaves text untouched when there are no replacement rules', () => {
    const result = applyReplacements('nothing to do here', [teachOnly('Kubernetes')]);
    expect(result.text).toBe('nothing to do here');
    expect(result.hits).toEqual([]);
  });

  it('does not match inside a larger word', () => {
    const result = applyReplacements('recall the recalled recall', [replacement('recall', 'REC')]);
    expect(result.text).toBe('REC the recalled REC');
  });

  it('prefers the longest source so a phrase rule is not shadowed', () => {
    const terms = [replacement('acme', 'Acme'), replacement('acme corp', 'Acme Corporation')];
    const result = applyReplacements('acme corp and acme', terms);
    expect(result.text).toBe('Acme Corporation and Acme');
  });

  it('applies each span once — a rule output is never re-scanned by another rule', () => {
    // b→c must not pick up the output of a→b (that would cascade 'a' all the way to 'c').
    const result = applyReplacements('alpha beta', [replacement('alpha', 'beta'), replacement('beta', 'gamma')]);
    expect(result.text).toBe('beta gamma');
  });

  it('does not loop when a replacement contains its own source', () => {
    const result = applyReplacements('ny is big', [replacement('ny', 'ny city')]);
    expect(result.text).toBe('ny city is big');
  });

  it('matches non-ASCII terms that \\b would refuse', () => {
    const result = applyReplacements('we met at café today', [replacement('café', 'Café Prismical')]);
    expect(result.text).toBe('we met at Café Prismical today');
  });

  it('escapes regex metacharacters in the source', () => {
    const result = applyReplacements('I write c++ daily', [replacement('c++', 'C++')]);
    expect(result.text).toBe('I write C++ daily');
  });

  it('reports team-scoped hits with their scope', () => {
    const term = replacement('foo', 'bar', 'team');
    expect(applyReplacements('foo', [term]).hits).toEqual([{ id: term.id, scope: 'team', count: 1 }]);
  });

  it('keeps a capitalization-only rule', () => {
    const result = applyReplacements('acme', [replacement('acme', 'Acme'), replacement('foo', 'FOO')]);
    expect(result.text).toBe('Acme');
    expect(result.hits).toHaveLength(1);
  });

  it('ignores a rule that rewrites a word to exactly itself', () => {
    expect(compileReplacements([replacement('acme', 'acme')])).toBeNull();
  });

  it('drops replacement rows with a blank right side', () => {
    const malformed: VocabularyTerm = {
      id: 'vcb_blank',
      scope: 'personal',
      word: 'acme',
      replacementWord: '   ',
      isReplacement: true,
    };
    expect(compileReplacements([malformed])).toBeNull();
  });

  // 'İ'.toLowerCase() expands to i + U+0307, which regex simple case folding
  // cannot fold back — keying rules only by their lowercase form made them unmatchable.
  it('matches a term whose lowercase form expands (Turkish dotted İ)', () => {
    const result = applyReplacements('we flew to İstanbul', [replacement('İstanbul', 'Istanbul')]);
    expect(result.text).toBe('we flew to Istanbul');
    expect(result.hits).toHaveLength(1);
  });

  it('tolerates extra whitespace inside a pasted phrase', () => {
    const result = applyReplacements('acme corp shipped', [replacement('acme  corp', 'Acme Corporation')]);
    expect(result.text).toBe('Acme Corporation shipped');
  });

  it('does not count a capitalization rule that changed nothing', () => {
    // 'Acme' is already correct — the rule matches case-insensitively but produces identical text.
    const result = applyReplacements('Acme and acme', [replacement('acme', 'Acme')]);
    expect(result.text).toBe('Acme and Acme');
    expect(result.hits).toEqual([{ id: expect.any(String), scope: 'personal', count: 1 }]);
  });

  it('caps the number of compiled rules', () => {
    const many = Array.from({ length: MAX_REPLACEMENT_RULES + 50 }, (_, i) => replacement(`w${i}`, `W${i}`));
    expect(compileReplacements(many)!.bySource.size).toBe(MAX_REPLACEMENT_RULES);
  });
});

describe('matchCase', () => {
  it('preserves a deliberately-cased replacement verbatim', () => {
    expect(matchCase('iphone', 'iPhone')).toBe('iPhone');
    expect(matchCase('IPHONE', 'iPhone')).toBe('iPhone');
    expect(matchCase('Iphone', 'iPhone')).toBe('iPhone');
  });

  it('follows the source casing when the replacement is all lowercase', () => {
    expect(matchCase('Acme', 'widget')).toBe('Widget');
    expect(matchCase('ACME', 'widget')).toBe('WIDGET');
    expect(matchCase('acme', 'widget')).toBe('widget');
  });

  it('does not uppercase a single-character match', () => {
    expect(matchCase('A', 'widget')).toBe('Widget');
  });

  it('is unaffected by caseless scripts', () => {
    expect(matchCase('東京', 'tokyo')).toBe('tokyo');
  });
});
