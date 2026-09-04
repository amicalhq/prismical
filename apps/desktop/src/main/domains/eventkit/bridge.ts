import type { AppleCalendarStatus } from '@prismical/desktop-contracts';
import { Context, Effect, Layer, Option, Ref, type Scope } from 'effect';
import type { EventKitServiceApi } from './service';
import { unavailableAppleCalendarStatus } from '../../infra/eventkit/client';

export interface EventKitBridgeApi {
  readonly register: (service: EventKitServiceApi) => Effect.Effect<void, never, Scope.Scope>;
  readonly getStatus: Effect.Effect<AppleCalendarStatus>;
  readonly enable: Effect.Effect<AppleCalendarStatus>;
  readonly refresh: Effect.Effect<AppleCalendarStatus>;
}

export class EventKitBridge extends Context.Tag('desktop/eventkit/EventKitBridge')<
  EventKitBridge,
  EventKitBridgeApi
>() {}

export const EventKitBridgeLive: Layer.Layer<EventKitBridge> = Layer.effect(
  EventKitBridge,
  Effect.gen(function* () {
    const current = yield* Ref.make<Option.Option<EventKitServiceApi>>(Option.none());
    const withService = (
      run: (service: EventKitServiceApi) => Effect.Effect<AppleCalendarStatus>
    ): Effect.Effect<AppleCalendarStatus> =>
      Ref.get(current).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(unavailableAppleCalendarStatus),
            onSome: run,
          })
        )
      );
    return {
      register: service =>
        Effect.acquireRelease(Ref.set(current, Option.some(service)), () =>
          Ref.update(current, active =>
            Option.exists(active, value => value === service) ? Option.none() : active
          )
        ).pipe(Effect.asVoid),
      getStatus: withService(service => service.getStatus),
      enable: withService(service => service.enable),
      refresh: withService(service => service.refresh),
    };
  })
);
