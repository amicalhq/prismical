import { Context, type Effect, type SubscriptionRef } from 'effect';
import type { DetectionState } from './policy';

/**
 * The DetectionService turns the shared MicActivity feed
 * into an observable "a meeting is happening" signal. It feeds 1 Hz snapshots
 * through the pure `policy` reducer (app-weighting, a ~4 s sustained-activity
 * delay, a ~5 min per-app cooldown, active-recording suppression), and publishes
 * the result on `state`.
 *
 * Mounted in the SignedInRuntime (workspace-layer.ts): the mic-detector child is
 * a session-scoped resource, so sign-out / org-switch / quit interrupts the
 * supervisor and reaps the child — detection only runs while signed in, never
 * orphaning a process.
 *
 * The widget reads `state` (show/hide + render the pill) and calls `dismiss` for
 * the pill's X. It offers "Take notes" → RecordingService.start
 * via the existing RecordingBridge; this service never starts a recording itself
 * because the pill only acts after the user confirms.
 */
export interface DetectionServiceApi {
  /**
   * The observable detection state for the widget. `status: 'detected'` with the
   * detected app while a qualifying meeting is sustained; `idle` otherwise.
   */
  readonly state: SubscriptionRef.SubscriptionRef<DetectionState>;
  /**
   * Dismiss the current detection (the pill's X): clears the pill and starts the
   * per-app cooldown so the same app doesn't re-fire for ~5 min. A no-op when
   * nothing is detected.
   */
  readonly dismiss: Effect.Effect<void>;
}

export class DetectionService extends Context.Tag('desktop/detection/DetectionService')<
  DetectionService,
  DetectionServiceApi
>() {}
