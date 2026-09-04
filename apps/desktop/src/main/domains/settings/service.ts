import { Context, type Effect, type SubscriptionRef } from 'effect';
import type { DeviceSettings } from '@prismical/desktop-contracts';
import type { DbError } from '../../infra/operational-db/service';

/**
 * The SettingsService is the boot-scoped owner of the
 * device-local preferences (DeviceSettings), backed by the OperationalDb KV
 * table under the `pref:` key prefix (one JSON-encoded row per field; SecureStore's
 * `secure:` prefix never collides). Device settings are GLOBAL — not
 * account/session-scoped — so this mounts in the BootLayer (like OperationalDb),
 * outliving every sign-in/out.
 *
 * `settings` is the observable current state: the settings IPC push fiber fans
 * every change to the renderer, and a main-side consumer like the meeting-widget
 * visibility policy re-projects its stream off it. `set` merges a partial
 * patch — clamping `widgetNormalizedY` to [0,1] and dropping invalid enums —
 * persists each CHANGED field, then publishes the merged value on the ref (a
 * persist DbError propagates typed and the ref is left untouched, so the observed
 * settings never claim a change that did not durably land).
 */
export interface SettingsServiceApi {
  /** The observable current settings — replayed to new subscribers of `.changes`. */
  readonly settings: SubscriptionRef.SubscriptionRef<DeviceSettings>;
  /** The current settings (reads the ref). */
  readonly get: Effect.Effect<DeviceSettings>;
  /** Merge + clamp + validate a patch, persist each changed field, publish it. */
  readonly set: (patch: Partial<DeviceSettings>) => Effect.Effect<void, DbError>;
  /**
   * Clear every persisted `pref:*` row and publish the defaults (app
   * reset). Delete-then-publish like `set`: a DbError leaves the ref untouched.
   * The keychain/secure-store is out of scope (that is sign-out territory).
   */
  readonly reset: Effect.Effect<void, DbError>;
}

export class SettingsService extends Context.Tag('desktop/settings/SettingsService')<
  SettingsService,
  SettingsServiceApi
>() {}
