import {
  createApplicationI18nSync,
  defaultLocale,
  matchSupportedLocale,
} from '@prismical/app-i18n';

/**
 * The fatal import boundary runs before the operational database is guaranteed
 * to exist, so it cannot safely read the saved preference. Localize this one
 * pre-boot dialog from the host locale and retain a literal English fallback in
 * entry.ts in case this localization module is itself what failed to load.
 */
export const fatalDialogCopy = (locale = Intl.DateTimeFormat().resolvedOptions().locale) => {
  const t = createApplicationI18nSync(matchSupportedLocale(locale) ?? defaultLocale).t;
  return {
    title: t('desktop.fatal.title'),
    description: t('desktop.fatal.description'),
    detailsLabel: t('desktop.fatal.detailsLabel'),
  };
};

export const fatalDialogTitle = (locale = Intl.DateTimeFormat().resolvedOptions().locale): string =>
  fatalDialogCopy(locale).title;
