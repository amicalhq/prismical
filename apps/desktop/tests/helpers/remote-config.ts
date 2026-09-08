import { Effect, Layer, SubscriptionRef } from 'effect';
import type { UpdateRequirement } from '@prismical/desktop-contracts';
import { RemoteConfig } from '../../src/main/domains/remote-config/service';

export const testRemoteConfigLayer = Layer.effect(
  RemoteConfig,
  Effect.gen(function* () {
    const requirement = yield* SubscriptionRef.make<UpdateRequirement | null>(null);
    return { requirement, isUpdateRequired: Effect.succeed(false), refresh: Effect.void };
  })
);
