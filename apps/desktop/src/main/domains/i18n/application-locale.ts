import { defaultLocale, matchSupportedLocale, type SupportedLocale } from '@prismical/app-i18n';

let applicationLocale: SupportedLocale =
  matchSupportedLocale(Intl.DateTimeFormat().resolvedOptions().locale) ?? defaultLocale;

/** The process locale is resolved from device settings during desktop startup. */
export const getApplicationLocale = (): SupportedLocale => applicationLocale;

export const setApplicationLocale = (locale: SupportedLocale): void => {
  applicationLocale = locale;
};
