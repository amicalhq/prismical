import { describe, expect, it } from 'vitest';
import {
  AI_ERROR_COPY,
  AI_ERROR_COPY_LOCALES,
  describeAiError,
  matchAiErrorCopyLocale,
} from './ai-error-copy.js';

const tokens = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]).sort();

describe('AI error copy catalogs', () => {
  it('every locale carries every key, non-empty, with the same interpolation tokens as English', () => {
    const en = AI_ERROR_COPY.en as unknown as Record<string, unknown>;
    for (const locale of AI_ERROR_COPY_LOCALES) {
      const copy = AI_ERROR_COPY[locale] as unknown as Record<string, unknown>;
      expect(Object.keys(copy).sort(), locale).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(en)) {
        const other = copy[key];
        if (typeof value === 'object' && value !== null) {
          const ev = value as Record<string, string>;
          const ov = other as Record<string, string>;
          expect(Object.keys(ov).sort(), `${locale}.${key}`).toEqual(Object.keys(ev).sort());
          for (const [k, s] of Object.entries(ev)) {
            expect(ov[k]?.trim().length, `${locale}.${key}.${k}`).toBeGreaterThan(0);
            expect(tokens(ov[k]!), `${locale}.${key}.${k}`).toEqual(tokens(s));
          }
        }
      }
    }
  });

  it('never uses em-dashes in product copy', () => {
    for (const locale of AI_ERROR_COPY_LOCALES) {
      expect(JSON.stringify(AI_ERROR_COPY[locale]), locale).not.toContain('—');
    }
  });
});

describe('describeAiError', () => {
  it('names the provider and offers key + cloud actions on a rejected BYOK key', () => {
    const d = describeAiError({
      code: 'PROVIDER_KEY_INVALID',
      details: { lane: 'your-key', provider: 'openai' },
      surface: 'skill',
      skillName: 'Cleanup',
    });
    expect(d.title).toBe('Your OpenAI key was rejected.');
    expect(d.severity).toBe('warning');
    expect(d.actions.map(a => a.kind)).toEqual(['open-ai-models', 'use-cloud']);
  });

  it('never offers "use cloud" on the cloud lane, and does not name the managed provider', () => {
    const d = describeAiError({
      code: 'PROVIDER_UNAVAILABLE',
      details: { lane: 'prismical-cloud', retryable: true },
      surface: 'ask',
    });
    expect(d.title).toBe('Prismical Cloud is having trouble right now.');
    expect(d.actions.map(a => a.kind)).toEqual(['retry']);
  });

  it('local recovery copy and actions never suggest Cloud, in every locale', () => {
    for (const locale of AI_ERROR_COPY_LOCALES) {
      for (const code of [
        'PROVIDER_KEY_INVALID',
        'PROVIDER_KEY_MISSING',
        'PROVIDER_QUOTA_EXCEEDED',
        'PROVIDER_MODEL_NOT_FOUND',
        'INSTANCE_NOT_FOUND',
        'MODEL_NOT_CONFIGURED',
      ]) {
        const description = describeAiError({
          code,
          locale,
          surface: 'ask',
          cloudAvailable: false,
          details: { lane: 'your-key', provider: 'openai' },
        });
        expect(description.title + description.body).not.toContain('Prismical Cloud');
        expect(description.actions.map(action => action.kind)).not.toContain('use-cloud');
        expect(description.actions.length).toBeGreaterThan(0);
      }
    }
    expect(
      describeAiError({
        code: 'MODEL_NOT_CONFIGURED',
        surface: 'ask',
        cloudAvailable: false,
      }).body
    ).toContain('local runtime');
  });

  it('turns the reasoning-budget overrun into actionable copy with no Retry', () => {
    const d = describeAiError({
      code: 'OUTPUT_TOO_LONG',
      details: { lane: 'prismical-cloud' },
      surface: 'skill',
      skillName: 'Enhance',
      mode: 'replace-doc',
    });
    expect(d.title).toBe('This note is too long for Enhance to rewrite in one go.');
    expect(d.actions.map(a => a.kind)).toEqual(['append-instead']);
    expect(
      describeAiError({ code: 'OUTPUT_TOO_LONG', surface: 'skill', mode: 'append-section' }).actions
    ).toEqual([]);
    // Neither an inline rewrite (must keep targeting the selection) nor a title run can append.
    expect(
      describeAiError({ code: 'OUTPUT_TOO_LONG', surface: 'skill', mode: 'inline-rewrite' }).actions
    ).toEqual([]);
    expect(
      describeAiError({
        code: 'OUTPUT_TOO_LONG',
        surface: 'skill',
        mode: 'replace-doc',
        outputTarget: 'note-title',
      }).actions
    ).toEqual([]);
    expect(
      describeAiError({
        code: 'OUTPUT_TOO_LONG',
        details: { lane: 'your-key', provider: 'openrouter' },
        surface: 'skill',
      }).body
    ).toContain('larger output limit');
  });

  it('localizes and falls back to English for unknown locales and codes', () => {
    expect(matchAiErrorCopyLocale('de-AT')).toBe('de');
    expect(matchAiErrorCopyLocale('zh-Hant')).toBe('zh-TW');
    expect(matchAiErrorCopyLocale('fr')).toBe('en');
    const ja = describeAiError({
      code: 'PROVIDER_RATE_LIMITED',
      details: { lane: 'your-key', provider: 'groq' },
      surface: 'ask',
      locale: 'ja',
    });
    expect(ja.title).toBe('Groqが混み合っています。');
    const unknown = describeAiError({
      code: 'SOMETHING_NEW',
      surface: 'skill',
      skillName: 'Cleanup',
    });
    expect(unknown.title).toBe('Couldn’t run Cleanup.');
    expect(unknown.actions.map(a => a.kind)).toEqual(['retry']);
  });

  it('describes Ask outcomes: steps exhausted, truncation with Continue, cloud fallback naming the lost provider', () => {
    expect(describeAiError({ code: 'ASK_STEPS_EXHAUSTED', surface: 'ask' })).toMatchObject({
      severity: 'warning',
      actions: [{ kind: 'retry' }],
    });
    expect(describeAiError({ code: 'ASK_OUTPUT_TRUNCATED', surface: 'ask' })).toMatchObject({
      title: 'The answer was cut short.',
      actions: [{ kind: 'continue', label: 'Continue' }],
    });
    const fb = describeAiError({
      code: 'MODEL_FALLBACK_TO_CLOUD',
      surface: 'ask',
      details: { lane: 'prismical-cloud' },
    });
    expect(fb.title).toBe('The model you chose isn’t available, so this ran on Prismical Cloud.');
    expect(fb.severity).toBe('info');
    expect(fb.actions.map(a => a.kind)).toEqual(['choose-model']);
  });

  it('uses the surface subject when no skill name is given', () => {
    expect(describeAiError({ code: 'NOTE_EMPTY', surface: 'skill' }).title).toBe(
      'Add some content to this note before running This skill.'
    );
    expect(
      describeAiError({ code: 'NOTE_EMPTY', surface: 'skill', includesTranscript: true }).body
    ).toBe('Add text or record audio before running This skill.');
  });
});
