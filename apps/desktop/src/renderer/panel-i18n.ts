import type { SupportedLocale } from '@prismical/app-i18n';
import { initializeDesktopI18n, type DesktopI18nFactory } from '../shared/application-i18n';

/**
 * Pull an initial sanitized snapshot only after the preload has attached. Main
 * may have emitted its first push before that preload existed, so boot cannot
 * depend on replay alone. React mounts only after this resolves, preventing an
 * untranslated frame; the app component owns live pushes after mount.
 */
export const bootstrapPanelI18n = async <T extends { readonly locale: SupportedLocale }>(
  getState: () => Promise<T>,
  createI18n?: DesktopI18nFactory
) => {
  const initialState = await getState();
  return {
    initialState,
    ...initializeDesktopI18n(initialState.locale, createI18n),
  };
};
