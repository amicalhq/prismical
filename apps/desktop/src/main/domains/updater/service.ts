import { Context, type Effect, type SubscriptionRef } from 'effect';
import type { UpdatePublicState, UpdaterStateView } from './machine';

/**
 * The auto-updater domain — Electron's built-in autoUpdater (Squirrel.Mac
 * / Squirrel.Windows) against core's `/update` + `/update-meta` endpoints
 * (Core selects artifacts from GitHub Releases). The state
 * machine itself is `machine.ts`; this service owns its lifecycle, scheduling
 * and the renderer-facing observable view.
 *
 * Hard-gated OFF unless (app.isPackaged && !PRISMICAL_E2E) — `enabled` false
 * means `state` stays at its initial view and `checkForUpdates` resolves
 * `disabled`.
 */
export interface UpdaterServiceApi {
  readonly enabled: boolean;
  /** The observable renderer-facing view (status/staged/prompt) — IPC push reads this. */
  readonly state: SubscriptionRef.SubscriptionRef<UpdaterStateView>;
  /**
   * Run a user-initiated check and resolve once the cycle settles (metadata +
   * native check answered, or a download started): the resolved value is the
   * settled public status (`disabled` when the updater is gated off).
   */
  readonly checkForUpdates: Effect.Effect<UpdatePublicState | 'disabled'>;
  /** Restart into a staged update (no-op with a warn when nothing is staged). */
  readonly quitAndInstall: Effect.Effect<void>;
  /** Dismiss the current update prompt (force prompts cannot be dismissed). */
  readonly dismissPrompt: Effect.Effect<void>;
  /** Number of completed check attempts (observability + cadence tests). */
  readonly checkCount: Effect.Effect<number>;
}

export class UpdaterService extends Context.Tag('desktop/UpdaterService')<
  UpdaterService,
  UpdaterServiceApi
>() {}
