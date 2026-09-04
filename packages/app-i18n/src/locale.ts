export const supportedLocales = ['en', 'de', 'es', 'ja', 'zh-TW'] as const;

export type SupportedLocale = (typeof supportedLocales)[number];
export type LocalePreference = SupportedLocale | 'system';

export const defaultLocale: SupportedLocale = 'en';
export const defaultLocalePreference: LocalePreference = 'system';

export function matchSupportedLocale(locale?: string | null): SupportedLocale | undefined {
  if (!locale) return undefined;

  const normalized = locale.trim().replace(/_/g, '-');
  if (!normalized) return undefined;

  const exact = supportedLocales.find(
    supported => supported.toLowerCase() === normalized.toLowerCase()
  );
  if (exact) return exact;

  const base = normalized.split('-')[0]?.toLowerCase();
  const baseMatch = supportedLocales.find(supported => supported.toLowerCase() === base);
  if (baseMatch) return baseMatch;

  const lowercase = normalized.toLowerCase();
  if (
    lowercase === 'zh' ||
    lowercase === 'zh-hk' ||
    lowercase === 'zh-mo' ||
    lowercase.startsWith('zh-hant')
  ) {
    return 'zh-TW';
  }

  return undefined;
}

export function decodeLocalePreference(value: unknown): LocalePreference {
  if (value === 'system') return 'system';
  if (typeof value !== 'string') return defaultLocalePreference;
  return matchSupportedLocale(value) ?? defaultLocalePreference;
}

export function resolveLocale(
  preference: LocalePreference,
  systemLocale?: string | null
): SupportedLocale {
  return preference === 'system'
    ? (matchSupportedLocale(systemLocale) ?? defaultLocale)
    : preference;
}
