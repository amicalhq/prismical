import { Clock, Effect, Layer, Option, Queue, Ref, Stream, SubscriptionRef } from 'effect';
import { MicActivity } from '../../infra/mic-detector/service';
import { RecordingService } from '../recording/service';
import { DetectionBridge } from './bridge';
import { DetectionService, type DetectionServiceApi } from './service';
import {
  idleDetectionState,
  initialReducerState,
  project,
  reduce,
  type DetectionEvent,
  type DetectionState,
} from './policy';

const EVENT_QUEUE_CAPACITY = 128;

const isActiveStatus = (status: string): boolean =>
  status === 'starting' || status === 'recording' || status === 'paused' || status === 'stopping';

const sameDetectionState = (a: DetectionState, b: DetectionState): boolean =>
  a.status === b.status &&
  (a.detection === b.detection ||
    (a.detection !== null &&
      b.detection !== null &&
      a.detection.bundleId === b.detection.bundleId &&
      a.detection.since === b.detection.since));

export const DetectionServiceLive: Layer.Layer<
  DetectionService,
  never,
  RecordingService | MicActivity | DetectionBridge
> = Layer.scoped(
  DetectionService,
  Effect.gen(function* () {
    const recording = yield* RecordingService;
    const micActivity = yield* MicActivity;
    const bridge = yield* DetectionBridge;

    const stateRef = yield* Ref.make(initialReducerState);
    const observable = yield* SubscriptionRef.make<DetectionState>(idleDetectionState);
    const events = yield* Queue.sliding<DetectionEvent>(EVENT_QUEUE_CAPACITY);

    const publish = (next: DetectionState): Effect.Effect<void> =>
      SubscriptionRef.get(observable).pipe(
        Effect.flatMap(prev =>
          sameDetectionState(prev, next) ? Effect.void : SubscriptionRef.set(observable, next)
        )
      );

    const applyEvent = (event: DetectionEvent): Effect.Effect<void> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap(now =>
          Ref.modify(stateRef, prev => {
            const next = reduce(prev, event, now);
            return [project(next), next] as const;
          })
        ),
        Effect.flatMap(publish)
      );

    yield* Effect.forkScoped(Stream.fromQueue(events).pipe(Stream.runForEach(applyEvent)));
    yield* Effect.forkScoped(
      micActivity.latest.changes.pipe(
        Stream.filterMap(Option.map(({ snapshot }) => ({ _tag: 'snapshot', snapshot }) as const)),
        Stream.runForEach(event => Queue.offer(events, event).pipe(Effect.asVoid))
      )
    );
    yield* Effect.forkScoped(
      recording.state.changes.pipe(
        Stream.map(state => isActiveStatus(state.status)),
        Stream.changes,
        Stream.runForEach(active =>
          Queue.offer(events, { _tag: 'recordingActive', active }).pipe(Effect.asVoid)
        )
      )
    );

    const api: DetectionServiceApi = {
      state: observable,
      dismiss: Queue.offer(events, { _tag: 'dismiss' }).pipe(Effect.asVoid),
    };
    yield* bridge.register(api);
    return api;
  })
);
