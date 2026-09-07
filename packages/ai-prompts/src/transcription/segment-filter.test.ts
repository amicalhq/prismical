import { describe, expect, it } from 'vitest';
import {
  filterWhisperTranscript,
  shouldDropSegment,
  shouldDropWhisperSegment,
} from './segment-filter.js';

describe('shouldDropSegment', () => {
  it.each(['Thank you.', 'Thanks for watching.', 'I love you.', 'ご視聴ありがとうございました。'])(
    'drops a known phrase with silence evidence: %s',
    text => {
      expect(shouldDropSegment({ text, noSpeechProb: 0.41 })).toBe(true);
      expect(shouldDropSegment({ text, noSpeechProb: 0.4 })).toBe(false);
      expect(shouldDropSegment({ text })).toBe(false);
    }
  );
  it('normalizes case, whitespace and Unicode for phrase lookup', () => {
    expect(shouldDropSegment({ text: '  THANK YOU.  ', noSpeechProb: 0.5 })).toBe(true);
    expect(
      shouldDropSegment({
        text: 'ご視聴ありがとうございました。'.normalize('NFD'),
        noSpeechProb: 0.5,
      })
    ).toBe(true);
  });
  it('uses strict silence and joint confidence thresholds', () => {
    const text = 'Move the box.';
    expect(shouldDropSegment({ text, noSpeechProb: 0.8 })).toBe(false);
    expect(shouldDropSegment({ text, noSpeechProb: 0.81 })).toBe(true);
    expect(shouldDropSegment({ text, noSpeechProb: 0.6, avgLogprob: -1.1 })).toBe(false);
    expect(shouldDropSegment({ text, noSpeechProb: 0.61, avgLogprob: -1 })).toBe(false);
    expect(shouldDropSegment({ text, noSpeechProb: 0.61, avgLogprob: -1.1 })).toBe(true);
  });
  it('drops retry decodes unless longer speech has strong quality signals', () => {
    const quality = { avgLogprob: -0.2, compressionRatio: 1.2, noSpeechProb: 0.9 };
    expect(shouldDropSegment({ text: 'Short.', temperature: 1 })).toBe(true);
    expect(shouldDropSegment({ ...quality, text: 'x'.repeat(20), temperature: 0 })).toBe(true);
    expect(shouldDropSegment({ ...quality, text: 'x'.repeat(21), temperature: 0 })).toBe(false);
    expect(shouldDropSegment({ ...quality, text: 'x'.repeat(25), temperature: 1 })).toBe(true);
    expect(shouldDropSegment({ ...quality, text: 'x'.repeat(26), temperature: 1 })).toBe(false);
    expect(shouldDropSegment({ ...quality, text: 'Thank you for watching.', temperature: 0 })).toBe(
      true
    );
  });
  it('requires both confidence metrics for an override', () => {
    const base = { text: 'Please send the updated project schedule.', noSpeechProb: 0.9 };
    expect(shouldDropSegment({ ...base, avgLogprob: -0.2 })).toBe(true);
    expect(shouldDropSegment({ ...base, compressionRatio: 1.2 })).toBe(true);
    expect(shouldDropSegment({ ...base, avgLogprob: -0.5, compressionRatio: 1.2 })).toBe(true);
    expect(shouldDropSegment({ ...base, avgLogprob: -0.2, compressionRatio: 2 })).toBe(true);
  });
});

describe('verbose response filtering', () => {
  it('ignores unavailable or invalid quality metrics', () => {
    for (const value of [null, undefined, NaN, Infinity]) {
      expect(shouldDropWhisperSegment({ text: 'Thank you.', no_speech_prob: value })).toBe(false);
    }
  });
  it('keeps valid speech around a hallucination and never restores an all-dropped answer', () => {
    const hallucination = { text: ' Thanks for watching.', no_speech_prob: 0.7 };
    const segments = [
      { text: ' Meet at noon.', no_speech_prob: 0.1 },
      hallucination,
      { text: ' Bring the report.', no_speech_prob: 0.1 },
    ];
    expect(
      filterWhisperTranscript('Meet at noon. Thanks for watching. Bring the report.', { segments })
    ).toBe('Meet at noon. Bring the report.');
    expect(filterWhisperTranscript('Thanks for watching.', { segments: [hallucination] })).toBe('');
  });
  it('preserves script spacing and only matches whole phrases', () => {
    expect(
      shouldDropSegment({ text: 'Thank you for sending the revised budget.', noSpeechProb: 0.5 })
    ).toBe(false);
    expect(
      filterWhisperTranscript('明日Thank you.会いましょう。', {
        segments: [
          { text: '明日', no_speech_prob: 0.1 },
          { text: 'Thank you.', no_speech_prob: 0.7 },
          { text: '会いましょう。', no_speech_prob: 0.1 },
        ],
      })
    ).toBe('明日会いましょう。');
  });

  it('keeps the original text when no segment is dropped or metadata is unavailable', () => {
    for (const body of [
      null,
      {},
      { segments: [] },
      { segments: [null] },
      { segments: [{ text: 'Thank you.' }] },
    ]) {
      expect(filterWhisperTranscript(' Thank you. ', body)).toBe(' Thank you. ');
    }
  });
});
