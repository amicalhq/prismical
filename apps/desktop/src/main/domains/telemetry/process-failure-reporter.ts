import { makeSuppressionCounter } from './suppression-counter';
import type { SyncScopedLog } from '@desktop/logging';
import { Effect, FiberSet, SubscriptionRef } from 'effect';
import type { TelemetryServiceApi, TelemetryEventProperties } from './service';

/** A native host reports unexpected process failures once, within its own scope. */
export const makeProcessFailureReporter = (telemetry: TelemetryServiceApi, log: SyncScopedLog) =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime();
    let pending = 0;
    const recordDrop = yield* makeSuppressionCounter(log, 'Process failure reports suppressed');
    return (error: unknown, properties: TelemetryEventProperties = {}): void => {
      const policy = SubscriptionRef.getUnsafe(telemetry.state);
      if (!policy.enabled) return;
      if (pending >= 32) {
        recordDrop();
        return;
      }
      pending++;
      run(
        // Register the callback before reporting can resume a closing owner.
        Effect.yieldNow.pipe(
          Effect.andThen(
            telemetry.captureException(
              error,
              { source: 'child-process', ...properties },
              'main',
              policy.revision
            )
          ),
          Effect.catchCause(() => Effect.void),
          Effect.ensuring(
            Effect.sync(() => {
              pending--;
            })
          )
        )
      );
    };
  });
