import path from 'node:path';
import { Menu, Tray, app, nativeImage } from 'electron';
import { Effect, Layer, Queue } from 'effect';
import { AppConfig, type AppConfigService } from '../../infra/config/service';
import { DesktopI18n } from '../i18n/service';
import { ElectronApp } from '../../infra/electron/service';
import { MainLogger } from '../../infra/logging/service';
import { TrayService, type TrayCommand, type TrayServiceApi } from './service';

const COMMAND_CAPACITY = 16;

// Template icon from assets/. Packaged builds carry assets/ via
// forge packagerConfig.extraResource; dev/bundle runs read the repo copy.
const trayIconPath = (config: AppConfigService): string =>
  config.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'iconTemplate.png')
    : path.join(app.getAppPath(), 'assets', 'iconTemplate.png');

export const TrayServiceLive: Layer.Layer<
  TrayService,
  never,
  AppConfig | DesktopI18n | ElectronApp | MainLogger
> = Layer.scoped(
  TrayService,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const i18n = yield* DesktopI18n;
    const electronApp = yield* ElectronApp;
    const log = (yield* MainLogger).scoped('tray');

    // Tray requires the ready app.
    yield* electronApp.whenReady;

    const commands = yield* Queue.sliding<TrayCommand>(COMMAND_CAPACITY);

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const icon = nativeImage.createFromPath(trayIconPath(config));
        icon.setTemplateImage(true);
        const tray = new Tray(icon);
        tray.setToolTip(i18n.t('desktop.tray.tooltip'));
        const onClick = () => {
          Queue.unsafeOffer(commands, 'open');
        };
        tray.on('click', onClick);
        tray.setContextMenu(
          Menu.buildFromTemplate([
            {
              label: i18n.t('desktop.tray.open'),
              click: () => {
                Queue.unsafeOffer(commands, 'open');
              },
            },
            { type: 'separator' },
            {
              label: i18n.t('desktop.tray.quit'),
              click: () => {
                Queue.unsafeOffer(commands, 'quit');
              },
            },
          ])
        );
        return { tray, onClick };
      }).pipe(Effect.tap(() => log.info('tray created'))),
      ({ tray, onClick }) =>
        Effect.sync(() => {
          // The tray is not destroyed on release: destroying it during macOS
          // quit can race the menubar teardown; process exit reclaims the item.
          // We still detach everything we attached so the scope leaks no
          // listeners or menu closures.
          if (!tray.isDestroyed()) {
            tray.removeListener('click', onClick);
            tray.setContextMenu(null);
          }
        }).pipe(Effect.zipRight(log.info('tray listeners detached (tray intentionally kept)')))
    );

    const service: TrayServiceApi = { commands };
    return service;
  })
);
