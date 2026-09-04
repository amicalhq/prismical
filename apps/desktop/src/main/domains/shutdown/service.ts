import { Context, type Effect } from 'effect';

/**
 * Shutdown coordination: quit awaits scope closure.
 *
 * Quit flow: before-quit (preventDefault-ed in the ElectronApp listener) →
 * awaitQuitSignal resolves → the boot program returns → its scope closes
 * (windows, IPC handlers, forked fibers) → start.ts (the ONLY dispose caller)
 * runs disposeAndExit: runtime.dispose() with a 5s deadline → app.exit(0).
 *
 * The layer also wires window-all-closed → quit on non-darwin (standard mac
 * behavior otherwise).
 */
export interface ShutdownCoordinatorApi {
  /** Resolves when the first quit signal (before-quit) arrives. */
  readonly awaitQuitSignal: Effect.Effect<void>;
}

export class ShutdownCoordinator extends Context.Tag('desktop/ShutdownCoordinator')<
  ShutdownCoordinator,
  ShutdownCoordinatorApi
>() {}
