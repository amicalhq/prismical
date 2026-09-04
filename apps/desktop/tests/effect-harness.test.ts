import { assert, describe, it } from '@effect/vitest';
import { Duration, Effect, Fiber, TestClock } from 'effect';

// Proves the @effect/vitest layer is wired: it.effect provides the test
// context (TestClock et al.), so time-driven services and Schedule fibers
// are testable without wall-clock waits.
describe('effect test layer', () => {
  it.effect('TestClock drives sleeping fibers without wall-clock waits', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.sleep(Duration.minutes(5)).pipe(Effect.as('woke')));
      yield* TestClock.adjust(Duration.minutes(5));
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result, 'woke');
    })
  );
});
