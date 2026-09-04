import { createInstance, type i18n, type InitOptions } from 'i18next';
import {
  defaultLocale,
  matchSupportedLocale,
  supportedLocales,
  type SupportedLocale,
} from './locale';
import { catalogs, resources } from './resources';

export interface ApplicationI18nOptions {
  readonly onMissingKey?: (key: string) => void;
}

function requestedLocale(locale?: string | null): SupportedLocale {
  return matchSupportedLocale(locale) ?? defaultLocale;
}

function cloneResources(): typeof resources {
  return structuredClone(resources);
}

export function getI18nOptions(
  locale?: string | null,
  options: ApplicationI18nOptions = {}
): InitOptions {
  const resolvedLocale = requestedLocale(locale);
  return {
    resources: cloneResources(),
    lng: resolvedLocale,
    fallbackLng: defaultLocale,
    supportedLngs: [...supportedLocales],
    load: 'currentOnly',
    interpolation: { escapeValue: false },
    initImmediate: false,
    showSupportNotice: false,
    returnEmptyString: false,
    returnNull: false,
    parseMissingKeyHandler: key => {
      options.onMissingKey?.(key);
      return catalogs[resolvedLocale].common.errors.generic;
    },
  };
}

export async function createApplicationI18n(
  locale?: string | null,
  options: ApplicationI18nOptions = {}
): Promise<i18n> {
  const instance = createInstance();
  await instance.init(getI18nOptions(locale, options));
  return instance;
}

/**
 * Renderer roots need an initialized instance during their first React render.
 * i18next guarantees synchronous initialization when `initImmediate` is false,
 * which is part of `getI18nOptions` above.
 */
export function createApplicationI18nSync(
  locale?: string | null,
  options: ApplicationI18nOptions = {}
): i18n {
  const instance = createInstance();
  let initializationError: Error | undefined;
  void instance.init(getI18nOptions(locale, options), error => {
    initializationError = error ?? undefined;
  });
  if (initializationError) throw initializationError;
  if (!instance.isInitialized) {
    throw new Error('Application i18n did not initialize synchronously');
  }
  return instance;
}
