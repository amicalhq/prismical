import type { AppleCalendarStatus } from '@prismical/desktop-contracts';
import { Context, type Effect } from 'effect';

export interface EventKitServiceApi {
  readonly getStatus: Effect.Effect<AppleCalendarStatus>;
  readonly enable: Effect.Effect<AppleCalendarStatus>;
  readonly refresh: Effect.Effect<AppleCalendarStatus>;
}

export class EventKitService extends Context.Tag('desktop/eventkit/EventKitService')<
  EventKitService,
  EventKitServiceApi
>() {}
