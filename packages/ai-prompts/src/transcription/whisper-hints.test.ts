import { describe, expect, it } from 'vitest';
import { whisperPrompt, targetSpelling, targets } from './whisper-hints.js';
import type { VocabularyTerm } from './vocabulary-term.js';

let seq = 0;
function term(partial: Partial<VocabularyTerm>): VocabularyTerm {
  return {
    id: `vcb_${++seq}`,
    scope: 'personal',
    word: 'word',
    replacementWord: null,
    isReplacement: false,
    ...partial,
  };
}

describe('targetSpelling', () => {
  it('hints the CORRECT side of a replacement, not the misheard side', () => {
    expect(targetSpelling(term({ word: 'prismatic all', replacementWord: 'Prismical', isReplacement: true }))).toBe('Prismical');
  });

  it('hints the word itself for a teach-only entry', () => {
    expect(targetSpelling(term({ word: 'Kubernetes' }))).toBe('Kubernetes');
  });

  it('falls back to the word when a replacement row has no right side', () => {
    expect(targetSpelling(term({ word: 'acme', replacementWord: null, isReplacement: true }))).toBe('acme');
  });
});

describe('targets', () => {
  it('de-duplicates case-variant targets and preserves source order', () => {
    const terms = [
      term({ word: 'acme', replacementWord: 'Acme', isReplacement: true }),
      term({ word: 'gRPC' }),
      term({ word: 'ackme', replacementWord: 'ACME', isReplacement: true }),
      term({ word: '   ' }),
    ];
    expect(targets(terms)).toEqual(['Acme', 'gRPC']);
  });
});

describe('whisperPrompt', () => {
  it('renders a bare comma-separated list', () => {
    expect(whisperPrompt([term({ word: 'Prismical' }), term({ word: 'gRPC' })])).toBe('Prismical, gRPC');
  });

  it('is undefined when there is nothing to hint', () => {
    expect(whisperPrompt([])).toBeUndefined();
  });

  it('stays inside the character budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => term({ word: `terminology${i}` }));
    const prompt = whisperPrompt(many)!;
    expect(prompt.length).toBeLessThanOrEqual(700);
    expect(prompt.length).toBeGreaterThan(600);
  });

  it('drops an oversized term instead of shipping it, and keeps the rest', () => {
    expect(whisperPrompt([term({ word: 'a'.repeat(5000) }), term({ word: 'Prismical' })])).toBe('Prismical');
  });

  it('drops a term that would overflow rather than truncating it mid-word', () => {
    const prompt = whisperPrompt([term({ word: 'alpha' }), term({ word: 'bravocado' })], 8);
    expect(prompt).toBe('alpha');
  });
});
