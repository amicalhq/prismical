import {
  decodeLocalePreference,
  type LocalePreference,
  type SupportedLocale,
} from '@prismical/app-i18n';
import type { ApplicationLocale, MainWindowSettingsApi } from '@prismical/desktop-contracts';
import { initializeDesktopI18n } from '../../shared/application-i18n';

export interface DesktopRendererI18nBootstrap {
  readonly instance: ReturnType<typeof initializeDesktopI18n>['instance'];
  readonly locale: SupportedLocale;
  readonly preference: LocalePreference;
}

/** Build one renderer instance from main's immutable, already-normalized locale. */
export const createDesktopRendererI18n = (
  applicationLocale: ApplicationLocale,
  storedPreference: unknown
): DesktopRendererI18nBootstrap => {
  const initialized = initializeDesktopI18n(applicationLocale);
  return {
    ...initialized,
    preference: storedPreference === '' ? 'system' : decodeLocalePreference(storedPreference),
  };
};

/**
 * settings:set is intentionally fire-and-forget for ordinary preferences: a
 * DB failure is reflected by the unchanged observable state. Interface locale
 * needs stronger feedback before showing the restart prompt, so confirm the
 * value with a read after the write and reject if main kept the old truth.
 */
export async function persistDesktopLocalePreference(
  settings: Pick<MainWindowSettingsApi, 'get' | 'set'>,
  preference: LocalePreference
): Promise<void> {
  const language = preference === 'system' ? '' : preference;
  await settings.set({ language });
  const observed = await settings.get();
  if (observed.language !== language) {
    throw new Error('Desktop locale preference was not persisted');
  }
}
