import { Context, type Effect, type Queue } from 'effect';

export interface SecondInstanceEvent {
  readonly argv: ReadonlyArray<string>;
}
export interface OpenUrlEvent {
  readonly url: string;
}

/**
 * The `app` module behind typed event streams: Electron callbacks
 * enqueue typed events; Effects consume queues). Every queue is bounded
 * (sliding) and fed by listeners registered in the layer's acquire and removed
 * in its release finalizer. NO business logic lives in the callbacks.
 */
export interface ElectronAppService {
  readonly whenReady: Effect.Effect<void>;
  /** Ordered `app.getPreferredSystemLanguages()` after readiness; consumed once by DesktopI18n. */
  readonly preferredSystemLanguages: Effect.Effect<ReadonlyArray<string>>;
  readonly quit: Effect.Effect<void>;
  readonly exit: (code: number) => Effect.Effect<void>;
  /**
   * Wipe every renderer storage on the default session: run
   * at boot, before any window exists, when a destructive reset was applied —
   * a live renderer's sync poll could otherwise write back into a partition the
   * in-process wipe had just cleared. Requires app ready.
   */
  readonly clearRendererStorage: Effect.Effect<void>;
  readonly events: {
    readonly secondInstance: Queue.Dequeue<SecondInstanceEvent>;
    readonly openUrl: Queue.Dequeue<OpenUrlEvent>;
    readonly activate: Queue.Dequeue<void>;
    /**
     * Every before-quit is preventDefault-ed at the listener; the
     * ShutdownCoordinator consumes the first signal and exits via app.exit(0)
     * after the runtime is disposed, so the prevented default never hangs a
     * quit because quit awaits scope closure.
     */
    readonly beforeQuit: Queue.Dequeue<void>;
    readonly windowAllClosed: Queue.Dequeue<void>;
    /** powerMonitor 'resume' — the auth domain re-checks token freshness after sleep. */
    readonly powerResume: Queue.Dequeue<void>;
  };
}

export class ElectronApp extends Context.Tag('desktop/ElectronApp')<
  ElectronApp,
  ElectronAppService
>() {}
