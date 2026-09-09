import { Effect, Layer, SubscriptionRef } from 'effect';
import { TelemetryService } from '../../src/main/domains/telemetry/service';

export const testTelemetryLayer = Layer.effect(
  TelemetryService,
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make({
      available: false,
      enabled: false,
      signedIn: false,
      preference: false,
      canChangePreference: false,
      revision: 0,
    });
    return {
      state,
      getState: SubscriptionRef.get(state),
      getDeviceId: Effect.succeed('test-device-id'),
      identifyPlan: () => Effect.void,
      capture: () => Effect.void,
      captureException: () => Effect.void,
    };
  })
);
