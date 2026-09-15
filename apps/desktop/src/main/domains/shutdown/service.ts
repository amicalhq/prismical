import { Context, type Effect } from 'effect';

/**
 * Shutdown coordination: quit awaits scope closure.
 *
 * Quit flow: before-quit (preventDefault-ed in the ElectronApp listener) →
 * awaitQuitSignal resolves → the boot program returns → start.ts runs
 * disposeAndExit with one 5s deadline for program-scope close (windows, IPC
 * handlers, forked fibers) and then runtime.dispose() → app.exit(0).
 *
 * The layer also wires window-all-closed → quit on non-darwin (standard mac
 * behavior otherwise).
 */
export interface ShutdownCoordinatorApi {
  /** Resolves when the first quit signal (before-quit) arrives. */
  readonly awaitQuitSignal: Effect.Effect<void>;
}

export class ShutdownCoordinator extends Context.Service<
  ShutdownCoordinator,
  ShutdownCoordinatorApi
>()('desktop/ShutdownCoordinator') {}
