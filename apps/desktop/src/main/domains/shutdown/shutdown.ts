import { Duration, Effect } from 'effect';

export const DISPOSE_DEADLINE = Duration.seconds(5);

export interface DisposeAndExitOptions {
  /** Close the program scope, then dispose the runtime; start.ts owns this sequence. */
  readonly dispose: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly onTimeout?: () => void;
  readonly onFailure?: (error: unknown) => void;
  readonly deadline?: Duration.Duration;
}

/**
 * Run the cleanup sequence with a bounded deadline, then exit(0) — ALWAYS exits,
 * whether dispose succeeded, failed, or timed out (a wedged finalizer must not
 * wedge quit). Clock-driven timeout so tests drive it with TestClock.
 */
export const disposeAndExit = (options: DisposeAndExitOptions): Effect.Effect<void> =>
  Effect.tryPromise({
    try: options.dispose,
    catch: cause => cause,
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.deadline ?? DISPOSE_DEADLINE,
      orElse: () => Effect.fail('dispose-timeout' as const),
    }),
    Effect.tapError(error =>
      Effect.sync(() => {
        if (error === 'dispose-timeout') options.onTimeout?.();
        else options.onFailure?.(error);
      })
    ),
    Effect.ignore,
    Effect.andThen(
      Effect.sync(() => {
        options.exit(0);
      })
    )
  );
