import { Context, type Effect, type SubscriptionRef } from 'effect';
import type { UpdateRequirement } from '@prismical/desktop-contracts';

export interface RemoteConfigApi {
  readonly requirement: SubscriptionRef.SubscriptionRef<UpdateRequirement | null>;
  readonly isUpdateRequired: Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<void>;
}

export class RemoteConfig extends Context.Tag('desktop/RemoteConfig')<
  RemoteConfig,
  RemoteConfigApi
>() {}
