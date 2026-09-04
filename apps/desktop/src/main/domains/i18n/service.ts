import { Context } from 'effect';
import type { ApplicationTFunction, SupportedLocale } from '@prismical/app-i18n';

/**
 * One immutable interface locale for the Electron process. Main-owned chrome
 * and every renderer root share this value so a saved language change never
 * leaves the running app half-translated; it takes effect after relaunch.
 */
export interface DesktopI18nServiceApi {
  readonly locale: SupportedLocale;
  readonly systemLocale: SupportedLocale;
  readonly t: ApplicationTFunction;
}

export class DesktopI18n extends Context.Tag('desktop/i18n/DesktopI18n')<
  DesktopI18n,
  DesktopI18nServiceApi
>() {}
