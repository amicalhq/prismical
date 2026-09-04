import { autoUpdater, net } from 'electron';
import { Duration, Effect, Layer, Ref, Runtime, Stream, SubscriptionRef } from 'effect';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import { SettingsService } from '../settings/service';
import {
  UpdaterMachine,
  type NativeUpdaterFacade,
  type UpdaterStateView,
} from './machine';
import { UpdaterService, type UpdaterServiceApi } from './service';

/**
 * Auto-updater lifecycle. The machine in machine.ts is
 * event-driven and timer-free; this layer owns everything temporal and
 * everything Electron:
 *
 * - initial check after a platform-appropriate delay (10s mac / 60s win),
 *   then a periodic loop whose interval stretches from
 *   60min to 9h once an install is staged;
 * - the SettingsService update-channel subscription (deferral for in-flight
 *   cycles lives in the machine);
 * - the renderer-facing SubscriptionRef view (the updater:stateChanged push
 *   fiber in main-window-handlers reads it);
 * - native autoUpdater listeners, removed again when the layer scope closes.
 *
 * Disabled (dev/E2E) builds return an inert api: initial view forever,
 * checkForUpdates resolves `disabled`.
 */

const CHECK_INTERVAL = Duration.minutes(60);
const CHECK_INTERVAL_AFTER_DOWNLOAD = Duration.hours(9);
const SETTLE_TIMEOUT = Duration.seconds(30);

const INITIAL_VIEW: UpdaterStateView = {
  status: 'not-available',
  staged: false,
  stagedVersion: null,
  prompt: null,
};

const DISABLED_VIEW: UpdaterStateView = {
  status: 'disabled',
  staged: false,
  stagedVersion: null,
  prompt: null,
};

export const UpdaterServiceLive: Layer.Layer<
  UpdaterService,
  never,
  AppConfig | MainLogger | SettingsService
> = Layer.scoped(
  UpdaterService,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* MainLogger;
    const log = logger.scoped('updater');
    const logUnsafe = logger.scopedUnsafe('updater');
    const settings = yield* SettingsService;
    const count = yield* Ref.make(0);
    const state = yield* SubscriptionRef.make(
      config.updaterEnabled ? INITIAL_VIEW : DISABLED_VIEW,
    );

    if (!config.updaterEnabled) {
      yield* log.info('updater disabled', {
        isPackaged: config.isPackaged,
        isE2E: config.isE2E,
      });
      const disabled: UpdaterServiceApi = {
        enabled: false,
        state,
        checkForUpdates: Effect.succeed('disabled' as const),
        quitAndInstall: log.warn('quitAndInstall ignored: updater disabled'),
        dismissPrompt: Effect.void,
        checkCount: Ref.get(count),
      };
      return disabled;
    }

    const runtime = yield* Effect.runtime<never>();

    const machine = new UpdaterMachine({
      // The public update endpoints use the server root, with no /apps prefix.
      updateServerUrl: config.endpoints.coreApiUrl,
      appVersion: config.appVersion,
      platform: config.platform,
      arch: process.arch,
      native: autoUpdater as NativeUpdaterFacade,
      fetchFn: (url, init) => net.fetch(url, init),
      log: (level, message, data) => logUnsafe[level](message, data),
      onChanged: () => {
        // Machine callbacks fire from native updater events / async fetch
        // continuations — bridge into the runtime like the window focus ref
        // (SubscriptionRef.set is sync-safe). `machine` is closure-safe here:
        // no callback fires during construction.
        Runtime.runSync(runtime)(SubscriptionRef.set(state, machine.getStateView()));
      },
    });

    const initialSettings = yield* settings.get;
    machine.initialize(initialSettings.updateChannel);
    yield* Effect.addFinalizer(() => Effect.sync(() => machine.dispose()));

    // Channel changes: SubscriptionRef.changes replays the current value first;
    // the machine no-ops when the channel already matches, so no drop needed.
    yield* Effect.forkScoped(
      Stream.runForEach(
        settings.settings.changes.pipe(
          Stream.map(s => s.updateChannel),
          Stream.changes
        ),
        channel => Effect.sync(() => machine.onChannelChanged(channel))
      ).pipe(
        Effect.catchAllDefect(defect =>
          log.error('updater channel subscription died', { defect: String(defect) })
        )
      )
    );

    // One completed check attempt: machine.checkForUpdates never rejects.
    const runCheck = (userInitiated: boolean) =>
      Effect.promise(() => machine.checkForUpdates(userInitiated)).pipe(
        Effect.zipRight(Ref.update(count, n => n + 1))
      );

    // Initial check + periodic loop. The interval is re-read per iteration so a
    // staged install stretches the cadence on the next tick. One extra 60-min
    // check post-download is harmless — background
    // checks while staged are allowed and effectiveVersion prevents
    // re-downloads).
    const initialDelay = config.platform === 'darwin' ? Duration.seconds(10) : Duration.minutes(1);
    const periodic = Effect.gen(function* () {
      yield* Effect.sleep(initialDelay);
      yield* runCheck(false);
      while (true) {
        yield* Effect.sleep(machine.isStaged() ? CHECK_INTERVAL_AFTER_DOWNLOAD : CHECK_INTERVAL);
        yield* runCheck(false);
      }
    });
    yield* Effect.forkScoped(
      periodic.pipe(
        Effect.catchAllDefect(defect =>
          log.error('updater check loop died', { defect: String(defect) })
        )
      )
    );
    yield* log.info('updater initialized', {
      channel: initialSettings.updateChannel,
      feed: config.endpoints.coreApiUrl,
    });

    // The one-shot IPC check: trigger, then wait for the cycle to settle out of
    // 'checking' (an in-flight download reports 'available'; a bounded timeout
    // returns whatever the view says so the renderer is never left hanging).
    const settledStatus = state.changes.pipe(
      Stream.filter(view => view.status !== 'checking'),
      Stream.runHead,
      Effect.map(view => (view._tag === 'Some' ? view.value.status : machine.getStateView().status)),
      Effect.timeout(SETTLE_TIMEOUT),
      Effect.catchAll(() => Effect.sync(() => machine.getStateView().status))
    );

    const api: UpdaterServiceApi = {
      enabled: true,
      state,
      checkForUpdates: runCheck(true).pipe(Effect.zipRight(settledStatus)),
      quitAndInstall: Effect.sync(() => {
        machine.quitAndInstall();
      }),
      dismissPrompt: Effect.sync(() => machine.dismissUpdatePrompt()),
      checkCount: Ref.get(count),
    };
    return api;
  })
);
