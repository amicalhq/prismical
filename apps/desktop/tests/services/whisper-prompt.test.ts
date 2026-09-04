/**
 * buildWhisperPrompt tests pin the contract the local lane relies on: vocabulary
 * first, the ≤10-word / ≤60-byte prior tail last,
 * whitespace collapsed, the 800-byte cap truncating from the START on a UTF-8
 * boundary, and `undefined` when there is nothing to say.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREVIOUS_WORD_COUNT,
  MAX_PREVIOUS_CONTEXT_BYTES,
  MAX_PROMPT_BYTES,
  buildWhisperPrompt,
  sanitizeWhisperPrompt,
  utf8ByteLength,
} from '../../src/main/domains/transcriber/whisper-prompt';

describe('buildWhisperPrompt', () => {
  it('returns undefined with nothing to prompt with (no vocabulary, blank prior text)', () => {
    expect(buildWhisperPrompt({})).toBeUndefined();
    expect(buildWhisperPrompt({ vocabulary: [], previousTranscription: '' })).toBeUndefined();
    expect(buildWhisperPrompt({ vocabulary: ['  ', ''], previousTranscription: '   ' })).toBeUndefined();
    expect(buildWhisperPrompt({ previousTranscription: null, beforeText: null })).toBeUndefined();
  });

  it('joins the vocabulary with ", " (trimmed, blanks dropped) and nothing else', () => {
    expect(buildWhisperPrompt({ vocabulary: [' Prismical ', 'gRPC', '', 'roadmap'] })).toBe(
      'Prismical, gRPC, roadmap'
    );
  });

  it('layout is "<vocab>. <last N words of the prior text>"', () => {
    expect(
      buildWhisperPrompt({
        vocabulary: ['Prismical'],
        previousTranscription: 'Yes, the timeline looks tight.',
      })
    ).toBe('Prismical. Yes, the timeline looks tight.');
  });

  it(`keeps only the last ${DEFAULT_PREVIOUS_WORD_COUNT} words of the prior text (previousWordCount overrides)`, () => {
    const words = Array.from({ length: 25 }, (_, i) => `w${i + 1}`);
    expect(buildWhisperPrompt({ previousTranscription: words.join(' ') })).toBe(
      words.slice(-DEFAULT_PREVIOUS_WORD_COUNT).join(' ')
    );
    expect(
      buildWhisperPrompt({ previousTranscription: words.join(' '), previousWordCount: 3 })
    ).toBe('w23 w24 w25');
  });

  it(`caps the prior tail at ${MAX_PREVIOUS_CONTEXT_BYTES} UTF-8 bytes by shedding leading words`, () => {
    const longWords = Array.from({ length: 10 }, (_, i) => `word${i}xxxxxxxxxx`); // 15 bytes each
    const prompt = buildWhisperPrompt({ previousTranscription: longWords.join(' ') })!;
    expect(utf8ByteLength(prompt)).toBeLessThanOrEqual(MAX_PREVIOUS_CONTEXT_BYTES);
    // The TAIL survives, never the head.
    expect(prompt.endsWith('word9xxxxxxxxxx')).toBe(true);
    expect(prompt.startsWith('word0')).toBe(false);
  });

  it('a single over-long prior word is byte-truncated from the start on a character boundary', () => {
    const cjk = '語'.repeat(40); // 3 bytes each → 120 bytes, one "word"
    const prompt = buildWhisperPrompt({ previousTranscription: cjk })!;
    expect(utf8ByteLength(prompt)).toBeLessThanOrEqual(MAX_PREVIOUS_CONTEXT_BYTES);
    expect(prompt).toBe('語'.repeat(20)); // 60 bytes exactly, no mojibake
  });

  it('beforeText is the fallback ONLY when previousTranscription is empty', () => {
    expect(buildWhisperPrompt({ previousTranscription: '', beforeText: 'Dear team,' })).toBe(
      'Dear team,'
    );
    expect(buildWhisperPrompt({ previousTranscription: 'said so', beforeText: 'Dear team,' })).toBe(
      'said so'
    );
  });

  it('collapses whitespace (tabs / newlines / runs) to single spaces', () => {
    expect(
      buildWhisperPrompt({ vocabulary: ['a\tb'], previousTranscription: 'one\n\n two   three' })
    ).toBe('a b. one two three');
    expect(sanitizeWhisperPrompt('  x \n y  ')).toBe('x y');
    expect(sanitizeWhisperPrompt('   ')).toBe('');
  });

  it(`truncates the whole prompt to ${MAX_PROMPT_BYTES} bytes from the START — the prior tail survives, the vocabulary head is dropped`, () => {
    const vocabulary = Array.from({ length: 200 }, (_, i) => `term${String(i).padStart(3, '0')}`);
    const prompt = buildWhisperPrompt({ vocabulary, previousTranscription: 'the very end' })!;
    expect(utf8ByteLength(prompt)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(prompt.endsWith('. the very end')).toBe(true);
    expect(prompt.includes('term000')).toBe(false);
    expect(prompt.includes('term199')).toBe(true);
  });

  it('the byte cut lands on a UTF-8 character boundary (no replacement characters)', () => {
    const vocabulary = ['é'.repeat(500)]; // 1000 bytes, odd cut points
    const prompt = buildWhisperPrompt({ vocabulary })!;
    expect(utf8ByteLength(prompt)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(prompt.includes('�')).toBe(false);
    expect(prompt).toBe('é'.repeat(400));
  });
});
