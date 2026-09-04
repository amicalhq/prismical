import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Queue, Scope, SubscriptionRef } from 'effect';
import { DEFAULT_DEVICE_SETTINGS, type DeviceSettings } from '@prismical/desktop-contracts';
import { DesktopI18n } from '../../src/main/domains/i18n/service';
import { DesktopI18nLive } from '../../src/main/domains/i18n/live';
import { SettingsService, type SettingsServiceApi } from '../../src/main/domains/settings/service';
import { ElectronApp, type ElectronAppService } from '../../src/main/infra/electron/service';

const makeLayer = (language: string, preferredSystemLanguages: ReadonlyArray<string>) => {
  const settings = Layer.effect(
    SettingsService,
    Effect.gen(function* () {
      const value: DeviceSettings = {
        ...DEFAULT_DEVICE_SETTINGS,
        // The malformed-row case deliberately bypasses the contract boundary.
        language: language as DeviceSettings['language'],
      };
      const ref = yield* SubscriptionRef.make(value);
      return {
        settings: ref,
        get: SubscriptionRef.get(ref),
        set: () => Effect.void,
        reset: Effect.void,
      } satisfies SettingsServiceApi;
    })
  );
  const electron = Layer.effect(
    ElectronApp,
    Effect.gen(function* () {
      const empty = yield* Queue.sliding<never>(1);
      return {
        whenReady: Effect.void,
        preferredSystemLanguages: Effect.succeed(preferredSystemLanguages),
        quit: Effect.void,
        exit: () => Effect.void,
        clearRendererStorage: Effect.void,
        events: {
          secondInstance: empty,
          openUrl: empty,
          activate: empty,
          beforeQuit: empty,
          windowAllClosed: empty,
          powerResume: empty,
        },
      } satisfies ElectronAppService;
    })
  );
  return DesktopI18nLive.pipe(Layer.provide(settings), Layer.provide(electron));
};

const readI18n = (language: string, preferredSystemLanguages: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const ctx = yield* Layer.build(makeLayer(language, preferredSystemLanguages)).pipe(
      Scope.extend(scope)
    );
    const service = Context.get(ctx, DesktopI18n);
    yield* Scope.close(scope, Exit.void);
    return service;
  });

describe('DesktopI18n', () => {
  it.effect('persisted interface locale wins over the operating-system locale', () =>
    Effect.gen(function* () {
      const service = yield* readI18n('de', ['ja-JP']);
      assert.strictEqual(service.locale, 'de');
      assert.strictEqual(service.systemLocale, 'ja');
      assert.strictEqual(service.t('desktop.tray.open'), 'Prismical öffnen');
    })
  );

  it.effect('an empty preference follows and normalizes the operating-system locale', () =>
    Effect.gen(function* () {
      const service = yield* readI18n('', ['zh-Hant-HK']);
      assert.strictEqual(service.locale, 'zh-TW');
      assert.strictEqual(service.systemLocale, 'zh-TW');
    })
  );

  it.effect('a malformed stored preference is ignored instead of becoming a mixed locale', () =>
    Effect.gen(function* () {
      const service = yield* readI18n('fr-CA', ['ja-JP']);
      assert.strictEqual(service.locale, 'ja');
    })
  );

  it.effect('unsupported operating-system locales fall back to English', () =>
    Effect.gen(function* () {
      const service = yield* readI18n('', ['fr-CA']);
      assert.strictEqual(service.locale, 'en');
      assert.strictEqual(service.systemLocale, 'en');
      assert.strictEqual(service.t('desktop.tray.quit'), 'Quit Prismical');
    })
  );

  it.effect('uses the first supported locale in the ordered operating-system preferences', () =>
    Effect.gen(function* () {
      const service = yield* readI18n('', ['fr-CA', 'de-DE', 'ja-JP']);
      assert.strictEqual(service.locale, 'de');
      assert.strictEqual(service.systemLocale, 'de');
    })
  );
});
