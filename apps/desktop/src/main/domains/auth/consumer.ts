/**
 * The OAuth drain, forked (forkScoped) by the boot program, watches
 * DeepLinks.pendingOAuth and feeds every parked entry — callback OR provider
 * error — through AuthService exactly once. Entries are popped atomically
 * BEFORE processing, so buffered change notifications can never double-consume;
 * unknown/expired/duplicate entries are removed and counted.
 */
import { Effect, Option, Ref, Stream, SubscriptionRef } from 'effect';
import { MainLogger } from '../../infra/logging/service';
import { DeepLinks, type PendingOAuthEntry } from '../deep-link/service';
import { AuthService } from './service';

export const runAuthConsumer: Effect.Effect<void, never, AuthService | DeepLinks | MainLogger> =
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const deepLinks = yield* DeepLinks;
    const log = (yield* MainLogger).scoped('auth');
    const rejected = yield* Ref.make(0);

    // SubscriptionRef.modify publishes a change even for a no-op — an
    // unconditional pop would feed the very stream that wakes this consumer
    // (a hot self-wake loop). Read first; modify only when something is there.
    const popEntry: Effect.Effect<Option.Option<PendingOAuthEntry>> = SubscriptionRef.get(
      deepLinks.pendingOAuth
    ).pipe(
      Effect.flatMap(entries =>
        entries.length === 0
          ? Effect.succeed(Option.none<PendingOAuthEntry>())
          : SubscriptionRef.modify(deepLinks.pendingOAuth, current =>
              current.length === 0
                ? ([Option.none<PendingOAuthEntry>(), current] as const)
                : ([Option.some(current[0]), current.slice(1)] as const)
            )
      )
    );

    const drain: Effect.Effect<void> = Effect.suspend(() =>
      popEntry.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: entry =>
              auth.consumePendingEntry(entry).pipe(
                Effect.flatMap(verdict =>
                  verdict === 'rejected'
                    ? Ref.updateAndGet(rejected, count => count + 1).pipe(
                        Effect.flatMap(total =>
                          // Rejected and counted. Values already logged
                          // (prefix-only) inside consumePendingEntry.
                          log.warn('oauth entry rejected', { totalRejected: total })
                        )
                      )
                    : Effect.void
                ),
                Effect.zipRight(drain)
              ),
          })
        )
      )
    );

    // changes emits the current backlog first (entries parked before this
    // consumer forked — the cold-start path), then every arrival.
    yield* Stream.runForEach(deepLinks.pendingOAuth.changes, () => drain);
  });
