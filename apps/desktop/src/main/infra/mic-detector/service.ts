import { Context, type Option, type SubscriptionRef } from "effect";
import type { MicActivitySnapshotEvent } from "@/types/meeting-start-notifications";

export interface LatestMicActivity {
  readonly snapshot: MicActivitySnapshotEvent;
  readonly receivedAtMs: number;
}

export interface MicActivityApi {
  readonly latest: SubscriptionRef.SubscriptionRef<
    Option.Option<LatestMicActivity>
  >;
}

export class MicActivity extends Context.Tag("desktop/MicActivity")<
  MicActivity,
  MicActivityApi
>() {}
