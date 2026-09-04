import { describe, expect, it } from 'vitest';
import { createApplicationI18nSync, type SupportedLocale } from '@prismical/app-i18n';
import { formatDefaultNoteTitle } from './default-note-title';

describe('formatDefaultNoteTitle', () => {
  it('uses a localized placeholder for a new empty note', () => {
    const date = new Date(2026, 7, 26);
    const expected: Record<SupportedLocale, string> = {
      en: 'Untitled note',
      de: 'Unbenannte Notiz',
      es: 'Nota sin título',
      ja: '無題のノート',
      'zh-TW': '未命名筆記',
    };

    for (const locale of Object.keys(expected) as SupportedLocale[]) {
      const i18n = createApplicationI18nSync(locale);
      expect(formatDefaultNoteTitle(date, locale, i18n.t)).toBe(expected[locale]);
    }
  });
});
