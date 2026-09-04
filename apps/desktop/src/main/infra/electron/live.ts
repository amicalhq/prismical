import { app, powerMonitor, session } from 'electron';
import { Effect, Layer, Queue } from 'effect';
import { MainLogger } from '../logging/service';
import { ElectronApp, type ElectronAppService } from './service';

const QUEUE_CAPACITY = 32;

interface Listeners {
  readonly secondInstance: (event: Electron.Event, argv: string[]) => void;
  readonly openUrl: (event: Electron.Event, url: string) => void;
  readonly activate: () => void;
  readonly beforeQuit: (event: Electron.Event) => void;
  readonly windowAllClosed: () => void;
}

export const ElectronAppLive: Layer.Layer<ElectronApp, never, MainLogger> = Layer.scoped(
  ElectronApp,
  Effect.gen(function* () {
    const log = (yield* MainLogger).scoped('electron');

    const secondInstance = yield* Queue.sliding<{ argv: ReadonlyArray<string> }>(QUEUE_CAPACITY);
    const openUrl = yield* Queue.sliding<{ url: string }>(QUEUE_CAPACITY);
    const activate = yield* Queue.sliding<void>(QUEUE_CAPACITY);
    const beforeQuit = yield* Queue.sliding<void>(QUEUE_CAPACITY);
    const windowAllClosed = yield* Queue.sliding<void>(QUEUE_CAPACITY);
    const powerResume = yield* Queue.sliding<void>(QUEUE_CAPACITY);

    yield* Effect.acquireRelease(
      Effect.sync((): Listeners => {
        const listeners: Listeners = {
          secondInstance: (_event, argv) => {
            Queue.unsafeOffer(secondInstance, { argv: [...argv] });
          },
          openUrl: (event, url) => {
            event.preventDefault();
            Queue.unsafeOffer(openUrl, { url });
          },
          activate: () => {
            Queue.unsafeOffer(activate, undefined);
          },
          beforeQuit: event => {
            // Always prevented: the quit path runs through the
            // ShutdownCoordinator → runtime.dispose() → app.exit(0).
            event.preventDefault();
            Queue.unsafeOffer(beforeQuit, undefined);
          },
          windowAllClosed: () => {
            Queue.unsafeOffer(windowAllClosed, undefined);
          },
        };
        app.on('second-instance', listeners.secondInstance);
        app.on('open-url', listeners.openUrl);
        app.on('activate', listeners.activate);
        app.on('before-quit', listeners.beforeQuit);
        app.on('window-all-closed', listeners.windowAllClosed);
        return listeners;
      }).pipe(Effect.tap(() => log.info('app event streams attached'))),
      listeners =>
        Effect.sync(() => {
          app.removeListener('second-instance', listeners.secondInstance);
          app.removeListener('open-url', listeners.openUrl);
          app.removeListener('activate', listeners.activate);
          app.removeListener('before-quit', listeners.beforeQuit);
          app.removeListener('window-all-closed', listeners.windowAllClosed);
        }).pipe(Effect.zipRight(log.info('app event streams detached')))
    );

    // powerMonitor is ready-gated in Electron, so its listener attaches from a
    // scoped fiber after whenReady (scope close interrupts the fiber FIRST,
    // then the finalizer removes the listener — registration can never outlive
    // removal). Same parse+enqueue rule as the app listeners above.
    const powerResumeListener = () => {
      Queue.unsafeOffer(powerResume, undefined);
    };
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.sync(() => {
        powerMonitor.removeListener('resume', powerResumeListener);
      })
    );
    yield* Effect.forkScoped(
      Effect.promise(() => app.whenReady()).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            powerMonitor.on('resume', powerResumeListener);
          })
        ),
        Effect.zipRight(log.info('power monitor stream attached'))
      )
    );

    const service: ElectronAppService = {
      whenReady: Effect.promise(() => app.whenReady()).pipe(Effect.asVoid),
      preferredSystemLanguages: Effect.sync(() => [...app.getPreferredSystemLanguages()]),
      quit: Effect.sync(() => {
        app.quit();
      }),
      exit: code =>
        Effect.sync(() => {
          app.exit(code);
        }),
      clearRendererStorage: Effect.promise(() => session.defaultSession.clearStorageData()),
      events: { secondInstance, openUrl, activate, beforeQuit, windowAllClosed, powerResume },
    };
    return service;
  })
);
