/**
 * The floating-note global hotkey — a boot-scoped consumer
 * projecting the `dockHotkey` device setting onto Electron's globalShortcut:
 *
 *   press  → TOGGLE the float: open the slot when closed, collapse when open.
 *
 * Registration is settings-reactive: each `dockHotkey` change unregisters the
 * previous accelerator and registers the new one ('' = disabled). An invalid
 * accelerator (or an OS-level registration conflict — globalShortcut.register
 * returns false when another app holds it) logs a warning and leaves the
 * hotkey off; the settings UI stays the source of truth, never crashes boot.
 * Gated behind the `global-shortcuts` capability renderer-side; main just
 * honors the persisted setting, while FloatBridge checks the active plan.
 */
import { globalShortcut } from 'electron';
import { Effect, FiberSet, Stream, SubscriptionRef, type Scope } from 'effect';
import { SettingsService } from '../../domains/settings/service';
import { MainLogger } from '../../infra/logging/service';
import { FloatBridge } from './float-bridge';

type HotkeyEnv = SettingsService | FloatBridge | MainLogger;

export const runDockHotkey: Effect.Effect<void, never, HotkeyEnv | Scope.Scope> = Effect.gen(
  function* () {
    const settings = yield* SettingsService;
    const floatBridge = yield* FloatBridge;
    const log = (yield* MainLogger).scoped('dock-hotkey');

    const runToggle = yield* FiberSet.makeRuntime();

    const toggle = SubscriptionRef.get(floatBridge.state).pipe(
      Effect.flatMap(current =>
        current.open ? floatBridge.collapse : floatBridge.open(null).pipe(Effect.asVoid)
      )
    );

    let registeredAccelerator: string | null = null;
    const unregisterCurrent = Effect.sync(() => {
      if (registeredAccelerator !== null && globalShortcut.isRegistered(registeredAccelerator)) {
        globalShortcut.unregister(registeredAccelerator);
      }
      registeredAccelerator = null;
    });

    const apply = (accelerator: string): Effect.Effect<void> =>
      unregisterCurrent.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (accelerator === '') {
              yield* log.info('dock hotkey disabled');
              return;
            }
            const ok = yield* Effect.try({
              try: () =>
                globalShortcut.register(accelerator, () => {
                  // Yield until FiberSet registers the callback, so a toggle
                  // that closes the scope cannot outlive its owner.
                  runToggle(Effect.yieldNow.pipe(Effect.andThen(toggle)));
                }),
              catch: () => false as const, // an invalid accelerator throws
            }).pipe(Effect.catch(() => Effect.succeed(false as const)));
            if (ok) {
              registeredAccelerator = accelerator;
              yield* log.info('dock hotkey registered', { context: { accelerator } });
            } else {
              yield* log.warn('dock hotkey registration failed — hotkey off', { context: { accelerator } });
            }
          })
        )
      );

    // Settings-reactive lifetime: apply per distinct value; the layer-scope
    // finalizer unregisters whatever is held when the boot scope closes.
    yield* Effect.addFinalizer(() => unregisterCurrent);
    yield* Effect.forkScoped(
      SubscriptionRef.changes(settings.settings).pipe(
        Stream.map(current => current.dockHotkey),
        Stream.changes,
        Stream.runForEach(accelerator =>
          apply(accelerator).pipe(
            Effect.catchDefect(defect =>
              log.error('dock hotkey apply failed — fiber continues', { error: defect })
            )
          )
        )
      )
    );
  }
);
