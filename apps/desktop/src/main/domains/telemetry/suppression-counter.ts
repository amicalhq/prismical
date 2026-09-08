import type { SyncScopedLog } from '@desktop/logging';
import { Effect, Queue } from 'effect';

/** Coalesce local loss counts; remain idle until the first drop, then flush on close. */
export const makeSuppressionCounter = (log: SyncScopedLog, message: string) =>
  Effect.gen(function* () {
    const wake = yield* Queue.dropping<void>(1);
    let count = 0;
    let closed = false;
    const flush = Effect.sync(() => {
      if (count) log.warn(message, { context: { count } });
      count = 0;
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      }).pipe(Effect.zipRight(flush))
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(wake).pipe(Effect.zipRight(Effect.sleep('1 second')), Effect.zipRight(flush))
      )
    );
    return (increment = 1) => {
      if (closed) return;
      const waiting = count > 0;
      count += increment;
      if (!waiting) Queue.unsafeOffer(wake, undefined);
    };
  });
