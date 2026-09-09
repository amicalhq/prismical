import { MainLogger } from '@desktop/logging';
import { makeTestLogger } from '../helpers/test-layers';
import { describe, expect, it } from 'vitest';
import { Effect, SubscriptionRef } from 'effect';
import { makeProcessFailureReporter } from '../../src/main/domains/telemetry/process-failure-reporter';
import type { TelemetryServiceApi } from '../../src/main/domains/telemetry/service';

describe('process failure ownership', () => {
  it('drops disabled incidents and retains the occurrence revision across deferred execution', async () => {
    const observed: number[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* SubscriptionRef.make({
            available: true,
            enabled: false,
            signedIn: false,
            preference: false,
            canChangePreference: true,
            revision: 0,
          });
          const telemetry: TelemetryServiceApi = {
            state,
            getState: SubscriptionRef.get(state),
            getDeviceId: Effect.succeed('test-device-id'),
            identifyPlan: () => Effect.void,
            capture: () => Effect.void,
            captureException: (_error, _props, _source, revision) =>
              Effect.sync(() => {
                observed.push(revision!);
              }),
          };
          const report = yield* makeProcessFailureReporter(
            telemetry,
            (yield* MainLogger).scopedSync('test')
          );
          report(new Error('disabled'));
          yield* SubscriptionRef.update(state, s => ({ ...s, enabled: true, revision: 1 }));
          report(new Error('enabled'));
          yield* SubscriptionRef.update(state, s => ({ ...s, revision: 2 }));
          for (let i = 0; i < 5; i++) yield* Effect.yieldNow();
        }).pipe(Effect.provide(makeTestLogger().layer))
      )
    );
    expect(observed).toEqual([1]);
  });
  it('bounds pending reports and persists overflow counts when its scope closes', async () => {
    const logger = makeTestLogger();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* SubscriptionRef.make({
            available: true,
            enabled: true,
            signedIn: false,
            preference: true,
            canChangePreference: true,
            revision: 0,
          });
          const report = yield* makeProcessFailureReporter(
            {
              state,
              getState: SubscriptionRef.get(state),
              getDeviceId: Effect.succeed('test-device-id'),
              identifyPlan: () => Effect.void,
              capture: () => Effect.void,
              captureException: () => Effect.never,
            },
            (yield* MainLogger).scopedSync('test')
          );
          for (let i = 0; i < 40; i++) report(new Error('worker failed'));
        }).pipe(Effect.provide(logger.layer))
      )
    );
    expect(
      logger.find(entry => entry.message === 'Process failure reports suppressed')?.data
    ).toEqual({ count: 8 });
  });
});
