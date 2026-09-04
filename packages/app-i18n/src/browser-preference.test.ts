import { describe, expect, it } from 'vitest';
import {
  INTERFACE_LOCALE_STORAGE_KEY,
  getBrowserSystemLocale,
  readLocalePreference,
  writeLocalePreference,
  type LocaleStorage,
} from './browser-preference';

function memoryStorage(initial?: string): LocaleStorage & {
  value: string | null;
} {
  return {
    value: initial ?? null,
    getItem(key) {
      expect(key).toBe(INTERFACE_LOCALE_STORAGE_KEY);
      return this.value;
    },
    setItem(key, value) {
      expect(key).toBe(INTERFACE_LOCALE_STORAGE_KEY);
      this.value = value;
    },
  };
}

describe('browser locale preference', () => {
  it("uses the browser's first declared locale", () => {
    expect(getBrowserSystemLocale({ languages: ['de-DE', 'en'], language: 'en' })).toBe('de-DE');
    expect(getBrowserSystemLocale({ languages: [], language: 'ja-JP' })).toBe('ja-JP');
    expect(getBrowserSystemLocale(undefined)).toBeUndefined();
  });

  it('reads a supported persisted preference', () => {
    expect(readLocalePreference(memoryStorage('de'))).toBe('de');
    expect(readLocalePreference(memoryStorage('zh-TW'))).toBe('zh-TW');
  });

  it('treats unsupported, absent, and inaccessible storage as system', () => {
    expect(readLocalePreference(memoryStorage('fr'))).toBe('system');
    expect(readLocalePreference(memoryStorage())).toBe('system');
    expect(
      readLocalePreference({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => undefined,
      })
    ).toBe('system');
  });

  it('persists a validated locale preference', () => {
    const storage = memoryStorage();
    writeLocalePreference(storage, 'es');
    expect(storage.value).toBe('es');
    writeLocalePreference(storage, 'system');
    expect(storage.value).toBe('system');
  });

  it('propagates persistence errors so the UI can report them', () => {
    const error = new Error('quota');
    expect(() =>
      writeLocalePreference(
        {
          getItem: () => null,
          setItem: () => {
            throw error;
          },
        },
        'ja'
      )
    ).toThrow(error);
  });
});
