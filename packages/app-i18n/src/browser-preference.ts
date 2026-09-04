import { decodeLocalePreference, type LocalePreference } from './locale';

export const INTERFACE_LOCALE_STORAGE_KEY = 'prismical:interface-locale:v1';

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrowserLocaleSource {
  readonly languages?: ReadonlyArray<string>;
  readonly language?: string;
}

export function getBrowserSystemLocale(
  source: BrowserLocaleSource | undefined
): string | undefined {
  return source?.languages?.[0] || source?.language || undefined;
}

export function readLocalePreference(storage: LocaleStorage): LocalePreference {
  try {
    return decodeLocalePreference(storage.getItem(INTERFACE_LOCALE_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function writeLocalePreference(storage: LocaleStorage, preference: LocalePreference): void {
  storage.setItem(INTERFACE_LOCALE_STORAGE_KEY, preference);
}
