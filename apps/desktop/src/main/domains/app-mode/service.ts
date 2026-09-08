import { Context, Effect, SubscriptionRef } from 'effect';

/**
 * The app's operating mode decides the data
 * plane, identity and reachable UI surfaces. Orthogonal to the transcription
 * engine and the LLM provider (axes B/C) — a single "logged in?" boolean would
 * fight "cloud mode can use local whisper".
 */
export type AppMode = 'local' | 'cloud';

/**
 * The AppModeService is the boot-scoped owner of the
 * chosen mode. Resolved ONCE from the operational store when the layer builds
 * and immutable for the process lifetime: a mode switch is a destructive
 * reset + relaunch, never a live re-mount, so nothing ever
 * observes a mode change mid-process. The workspace lifecycle keys the
 * (mode, identity) reconciliation on this value; env:get forwards it to the
 * renderer. The first choice of that same mode can be persisted without relaunch.
 */
export interface AppModeApi {
  readonly mode: AppMode;
  /**
   * Whether the mode was ever CHOSEN — the `app:mode` row exists and is
   * valid. A fresh install resolves 'cloud' by default with
   * `chosen: false`; the renderer's first-run chooser keys on it.
   */
  readonly chosenState: SubscriptionRef.SubscriptionRef<boolean>;
}

export class AppModeService extends Context.Tag('desktop/app-mode/AppModeService')<
  AppModeService,
  AppModeApi
>() {}

/** The mode stays immutable; its first durable choice is shared observable state. */
export const makeAppMode = (mode: AppMode, chosen: boolean): Effect.Effect<AppModeApi> =>
  SubscriptionRef.make(chosen).pipe(Effect.map(chosenState => ({ mode, chosenState })));
