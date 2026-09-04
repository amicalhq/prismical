import { Effect, Layer } from 'effect';
import { defaultLocale, matchSupportedLocale } from '@prismical/app-i18n';
import { initializeDesktopI18n } from '../../../shared/application-i18n';
import { SettingsService } from '../settings/service';
import { ElectronApp } from '../../infra/electron/service';
import { DesktopI18n, type DesktopI18nServiceApi } from './service';

export const DesktopI18nLive: Layer.Layer<DesktopI18n, never, ElectronApp | SettingsService> =
  Layer.effect(
    DesktopI18n,
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp;
      const settings = yield* SettingsService;

      // Electron's language APIs are ready-gated. Waiting here also means every
      // dependent layer (tray, IPC, notification builders) receives the final
      // startup locale before it creates user-visible UI.
      yield* electronApp.whenReady;
      const [current, preferredSystemLanguages] = yield* Effect.all([
        settings.get,
        electronApp.preferredSystemLanguages,
      ]);
      const resolvedSystemLocale =
        preferredSystemLanguages
          .map(matchSupportedLocale)
          .find((locale): locale is NonNullable<typeof locale> => locale !== undefined) ??
        defaultLocale;
      const preferredLocale = matchSupportedLocale(current.language) ?? resolvedSystemLocale;
      const { instance, locale } = initializeDesktopI18n(preferredLocale);

      return {
        locale,
        systemLocale: resolvedSystemLocale,
        t: instance.t,
      } satisfies DesktopI18nServiceApi;
    })
  );
