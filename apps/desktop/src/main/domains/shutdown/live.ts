import { Effect, Layer, Queue } from 'effect';
import { AppConfig } from '../../infra/config/service';
import { ElectronApp } from '../../infra/electron/service';
import { MainLogger } from '../../infra/logging/service';
import { ShutdownCoordinator, type ShutdownCoordinatorApi } from './service';

export const ShutdownCoordinatorLive: Layer.Layer<
  ShutdownCoordinator,
  never,
  AppConfig | ElectronApp | MainLogger
> = Layer.scoped(
  ShutdownCoordinator,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const electronApp = yield* ElectronApp;
    const log = (yield* MainLogger).scoped('shutdown');

    // window-all-closed → quit on non-darwin; standard macOS behavior (stay
    // resident, tray/dock reopens) otherwise.
    yield* Effect.forkScoped(
      Queue.take(electronApp.events.windowAllClosed).pipe(
        Effect.flatMap(() =>
          config.platform === 'darwin'
            ? log.info('all windows closed (darwin: staying resident)')
            : log.info('all windows closed — quitting').pipe(Effect.zipRight(electronApp.quit))
        ),
        Effect.forever
      )
    );

    const service: ShutdownCoordinatorApi = {
      awaitQuitSignal: Queue.take(electronApp.events.beforeQuit).pipe(
        Effect.zipLeft(log.info('quit signal received')),
        Effect.asVoid
      ),
    };
    return service;
  })
);
