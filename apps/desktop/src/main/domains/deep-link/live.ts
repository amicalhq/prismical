import { Effect, Layer, Queue, SubscriptionRef } from 'effect';
import { ElectronApp } from '../../infra/electron/service';
import { MainLogger } from '../../infra/logging/service';
import { DeepLinks, type DeepLinksService, type PendingOAuthEntry } from './service';

const URL_QUEUE_CAPACITY = 32;

export const DeepLinksLive: Layer.Layer<DeepLinks, never, ElectronApp | MainLogger> = Layer.scoped(
  DeepLinks,
  Effect.gen(function* () {
    const electronApp = yield* ElectronApp;
    const log = (yield* MainLogger).scoped('deep-link');

    const urls = yield* Queue.sliding<string>(URL_QUEUE_CAPACITY);
    const pendingOAuth = yield* SubscriptionRef.make<ReadonlyArray<PendingOAuthEntry>>([]);

    // Layer-scoped feeder: open-url events → raw URL queue. Interrupted with
    // the layer scope (leak test asserts no consumer survives).
    yield* Effect.forkScoped(
      Queue.take(electronApp.events.openUrl).pipe(
        Effect.flatMap(({ url }) => Queue.offer(urls, url)),
        Effect.forever
      )
    );
    yield* log.info('deep-link queue attached');

    const service: DeepLinksService = {
      urls,
      offerUrl: url => Queue.offer(urls, url),
      pendingOAuth,
    };
    return service;
  })
);
