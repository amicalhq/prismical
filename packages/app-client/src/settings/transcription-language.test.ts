import { afterEach, describe, expect, it } from 'vitest';
import {
  clearTranscriptionLanguage,
  currentTranscriptionLanguage,
  guessTranscriptionLanguage,
  markTranscriptionLanguageLoading,
  publishTranscriptionLanguage,
  resolveTranscriptionLanguage,
} from './transcription-language';

describe('guessTranscriptionLanguage', () => {
  it('keeps a legacy explicit pick', () => {
    expect(guessTranscriptionLanguage('en-US', { autoDetectLanguage: false, language: 'fr' })).toBe(
      'fr'
    );
  });
  it('ignores a legacy pick that was on auto-detect or is not a supported code', () => {
    expect(guessTranscriptionLanguage('de-DE', { autoDetectLanguage: true, language: 'fr' })).toBe(
      'de'
    );
    expect(guessTranscriptionLanguage('de-DE', { autoDetectLanguage: false, language: 'xx' })).toBe(
      'de'
    );
  });
  it('uses the locale base language when the lanes know it, else English', () => {
    expect(guessTranscriptionLanguage('ko-KR')).toBe('ko');
    expect(guessTranscriptionLanguage('zh-Hant-TW')).toBe('zh');
    expect(guessTranscriptionLanguage('cy-GB')).toBe('en');
    expect(guessTranscriptionLanguage(undefined)).toBe('en');
  });
  it('maps locale tags whose base differs from the lane code', () => {
    expect(guessTranscriptionLanguage('nb-NO')).toBe('no');
    expect(guessTranscriptionLanguage('fil-PH')).toBe('tl');
    expect(guessTranscriptionLanguage('iw')).toBe('he');
    expect(guessTranscriptionLanguage('in-ID')).toBe('id');
  });
});

describe('the account language store', () => {
  afterEach(() => clearTranscriptionLanguage());
  it('prefers the published account choice over the device guess', () => {
    expect(currentTranscriptionLanguage({ autoDetectLanguage: false, language: 'fr' })).toBe('fr');
    publishTranscriptionLanguage('ko');
    expect(currentTranscriptionLanguage({ autoDetectLanguage: false, language: 'fr' })).toBe('ko');
  });
  it('waits for a loading account and takes its answer', async () => {
    markTranscriptionLanguageLoading();
    const pending = resolveTranscriptionLanguage(null, 5_000);
    publishTranscriptionLanguage('ko');
    expect(await pending).toBe('ko');
  });
  it('falls back to the device guess when the account never answers in time', async () => {
    markTranscriptionLanguageLoading();
    expect(
      await resolveTranscriptionLanguage({ autoDetectLanguage: false, language: 'de' }, 20)
    ).toBe('de');
  });
  it('does not wait at all without a provider', async () => {
    const started = Date.now();
    expect(await resolveTranscriptionLanguage(null, 5_000)).toBe('en');
    expect(Date.now() - started).toBeLessThan(500);
  });
});
