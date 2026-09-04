import { Context, type Effect } from 'effect';

/**
 * OperationalDb KV key for the persisted anonymous device id (distinct from the
 * settings `pref:` and SecureStore `secure:` prefixes). Shared: the main client
 * mints it; env:get exposes it so the renderer's posthog-js bootstraps the SAME
 * distinct-id.
 */
export const DEVICE_ID_KEY = 'telemetry:deviceId';

/** Main-origin event properties (mirrors the renderer AnalyticsPort's shape). */
export type TelemetryEventProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

/** The signed-in identity telemetry attaches events to (from the auth session). */
export interface TelemetryIdentity {
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
  readonly orgId?: string;
}

/**
 * TelemetryService — the boot-scoped owner of the main-process
 * posthog-node client. Captures MAIN-ORIGIN events only (app launch, updater,
 * native crashes, exceptions); the renderer captures product events + session
 * replay through its own posthog-js with no double-counting. Identity is
 * mirrored from AuthService.sessionState so main events attach to the same person
 * as the renderer, keyed off the shared anonymous device id.
 *
 * Disabled (no analytics key, or E2E) ⇒ every method is an inert no-op and no
 * client is constructed, so dev/e2e stay silent.
 */
export interface TelemetryServiceApi {
  /** Capture a main-origin event with the current distinct-id + super-properties. */
  readonly capture: (
    event: string,
    properties?: TelemetryEventProperties
  ) => Effect.Effect<void>;
  /** Capture a caught main-process exception under the current distinct-id. */
  readonly captureException: (
    error: unknown,
    properties?: TelemetryEventProperties
  ) => Effect.Effect<void>;
  /** Point telemetry at a signed-in user (aliases the device id via $anon_distinct_id). */
  readonly identify: (identity: TelemetryIdentity) => Effect.Effect<void>;
  /** Return telemetry to the anonymous device id (logout / account switch). */
  readonly reset: Effect.Effect<void>;
}

export class TelemetryService extends Context.Tag('desktop/telemetry/TelemetryService')<
  TelemetryService,
  TelemetryServiceApi
>() {}
