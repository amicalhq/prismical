import { describe, expect, it } from 'vitest';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { pendingRecording, recordingSkillCopy } from './recording-skill';

const row = (id: string, over: Partial<{ folded: boolean; lines: unknown[]; processing: boolean }> = {}) => ({
  id,
  folded: false,
  lines: [{}],
  ...over,
});

describe('pendingRecording', () => {
  it('offers the newest recording once its transcript is ready and it is not in the note', () => {
    expect(pendingRecording([row('new'), row('old')])?.id).toBe('new');
  });

  it.each([
    ['folded', row('new', { folded: true })],
    ['still processing', row('new', { processing: true })],
    ['without transcript lines', row('new', { lines: [] })],
  ])('offers nothing when the newest recording is %s, even if an older one is pending', (_, newest) => {
    expect(pendingRecording([newest, row('old')])).toBeNull();
  });

  it('offers nothing without recordings', () => {
    expect(pendingRecording([])).toBeNull();
  });
});

describe('recordingSkillCopy', () => {
  it('says Generate on an empty body and Enhance once the note has text, in every locale', () => {
    for (const locale of ['en', 'de', 'es', 'ja', 'zh-TW'] as const) {
      const { t } = createApplicationI18nSync(locale);
      const generate = recordingSkillCopy(true, t);
      const enhance = recordingSkillCopy(false, t);
      expect(generate.label, locale).not.toBe(enhance.label);
      expect(generate.hint, locale).not.toBe(enhance.hint);
      for (const copy of [generate, enhance]) {
        expect(copy.label.trim().length, locale).toBeGreaterThan(0);
        expect(copy.hint.trim().length, locale).toBeGreaterThan(0);
      }
    }
  });

  it('reads Generate notes / Enhance notes in English', () => {
    const { t } = createApplicationI18nSync('en');
    expect(recordingSkillCopy(true, t).label).toBe('Generate notes');
    expect(recordingSkillCopy(false, t).label).toBe('Enhance notes');
  });
});
