import { Context, type Effect, type SubscriptionRef } from 'effect';
import type { TelemetryState } from '@prismical/desktop-contracts';

/** Persisted UUID fallback when the hashed OS machine ID is unavailable. */
export const DEVICE_ID_KEY = 'telemetry:deviceId';
export type TelemetryEventProperties = Record<string, string | number | boolean | null | undefined>;
export type TelemetrySource = 'main' | 'renderer';

/** Main owns policy, identity and delivery for every desktop surface. */
export interface TelemetryServiceApi {
  readonly state: SubscriptionRef.SubscriptionRef<TelemetryState>;
  readonly getState: Effect.Effect<TelemetryState>;
  /** Resolve the shared machine/install ID for update rollouts without enabling telemetry. */
  readonly getDeviceId: Effect.Effect<string>;
  readonly capture: (
    event: string,
    properties?: TelemetryEventProperties,
    source?: TelemetrySource,
    revision?: number
  ) => Effect.Effect<void>;
  readonly captureException: (
    error: unknown,
    properties?: TelemetryEventProperties,
    source?: TelemetrySource,
    revision?: number
  ) => Effect.Effect<void>;
}
export class TelemetryService extends Context.Tag('desktop/telemetry/TelemetryService')<
  TelemetryService,
  TelemetryServiceApi
>() {}
