import { describe, expect, it } from 'vitest';
import {
  decodeLocalePreference,
  defaultLocale,
  matchSupportedLocale,
  resolveLocale,
  supportedLocales,
} from './locale';

describe('application locale', () => {
  it('exposes only the five launch locales with English as the fallback', () => {
    expect(supportedLocales).toEqual(['en', 'de', 'es', 'ja', 'zh-TW']);
    expect(defaultLocale).toBe('en');
  });

  it.each([
    ['en', 'en'],
    ['de-DE', 'de'],
    ['es_MX', 'es'],
    ['ja-JP', 'ja'],
    ['zh-TW', 'zh-TW'],
    ['zh_HK', 'zh-TW'],
    ['zh-Hant-HK', 'zh-TW'],
    ['zh-MO', 'zh-TW'],
  ] as const)('matches %s to %s', (input, expected) => {
    expect(matchSupportedLocale(input)).toBe(expected);
  });

  it('rejects empty and unsupported locales', () => {
    expect(matchSupportedLocale(undefined)).toBeUndefined();
    expect(matchSupportedLocale(null)).toBeUndefined();
    expect(matchSupportedLocale('  ')).toBeUndefined();
    expect(matchSupportedLocale('fr-CA')).toBeUndefined();
  });

  it('resolves a system preference through the system locale and then English', () => {
    expect(resolveLocale('system', 'es-MX')).toBe('es');
    expect(resolveLocale('system', 'fr-CA')).toBe('en');
    expect(resolveLocale('de', 'ja-JP')).toBe('de');
  });

  it('decodes persisted values without exposing an unsupported locale', () => {
    expect(decodeLocalePreference('system')).toBe('system');
    expect(decodeLocalePreference('zh-TW')).toBe('zh-TW');
    expect(decodeLocalePreference('de-DE')).toBe('de');
    expect(decodeLocalePreference('fr')).toBe('system');
    expect(decodeLocalePreference(42)).toBe('system');
  });
});
