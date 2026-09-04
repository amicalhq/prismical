import {
  createApplicationI18nSync,
  defaultLocale,
  matchSupportedLocale,
  type SupportedLocale,
} from '@prismical/app-i18n';
import type { i18n } from 'i18next';

export type DesktopI18nFactory = (locale: SupportedLocale) => i18n;

export interface InitializedDesktopI18n {
  readonly instance: i18n;
  readonly locale: SupportedLocale;
}

/**
 * Initialize a desktop surface in its preferred locale. A broken localized
 * catalog must not prevent Electron from presenting recovery UI, so retry once
 * with the complete English source catalog before surfacing the error.
 */
export function initializeDesktopI18n(
  preferredLocale?: string | null,
  createI18n: DesktopI18nFactory = createApplicationI18nSync
): InitializedDesktopI18n {
  const locale = matchSupportedLocale(preferredLocale) ?? defaultLocale;
  try {
    return { instance: createI18n(locale), locale };
  } catch (preferredError) {
    if (locale === defaultLocale) throw preferredError;
    return { instance: createI18n(defaultLocale), locale: defaultLocale };
  }
}
