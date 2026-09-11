import { assert, it } from '@effect/vitest';
import { Context, Effect, Layer, SubscriptionRef } from 'effect';
import { makeRecordingBridgeLive, RecordingBridge } from '../../src/main/domains/recording/bridge';
import {
  idleRecordingState,
  type RecordingServiceApi,
  type RecordingState,
} from '../../src/main/domains/recording/service';

it.scoped(
  'required updates deny all new recordings, focus main, and let existing recordings finish',
  () =>
    Effect.gen(function* () {
      const required = yield* SubscriptionRef.make(false);
      let focuses = 0;
      let starts = 0;
      const stopped: string[] = [];
      const state = yield* SubscriptionRef.make<RecordingState>({
        ...idleRecordingState,
        status: 'recording' as const,
        recordingId: 'rec_1',
      });
      const service: RecordingServiceApi = {
        setLanguage: () => Effect.succeed(false),
        state,
        level: yield* SubscriptionRef.make(0),
        start: () =>
          Effect.sync(() => {
            starts++;
            return 'rec_1';
          }),
        stop: id =>
          Effect.sync(() => {
            stopped.push(id);
          }),
        pause: () => Effect.succeed(true),
        resume: () => Effect.succeed(true),
        pauseFromPrompt: () => Effect.succeed(true),
        keepRecording: () => Effect.succeed(true),
        claimCompletion: () => Effect.succeed(true),
        resolveCompletion: () => Effect.void,
      };
      const bridge = Context.get(
        yield* Layer.build(
          makeRecordingBridgeLive(
            SubscriptionRef.get(required),
            Effect.sync(() => {
              focuses++;
            })
          )
        ),
        RecordingBridge
      );
      yield* bridge.register(service);
      assert.deepEqual(yield* bridge.start({ captureMode: 'mic' }), {
        ok: true,
        recordingId: 'rec_1',
      });
      yield* SubscriptionRef.set(required, true);
      assert.deepEqual(yield* bridge.start({ captureMode: 'mic' }), {
        ok: false,
        reason: 'update-required',
      });
      assert.equal(starts, 1);
      assert.equal(focuses, 1);
      assert.isTrue(yield* bridge.pause('rec_1'));
      assert.isTrue(yield* bridge.resume('rec_1'));
      yield* bridge.stopActive;
      assert.deepEqual(stopped, ['rec_1']);
      assert.isTrue(yield* bridge.claimCompletion('rec_1'));
      yield* SubscriptionRef.set(required, false);
      assert.isTrue((yield* bridge.start({ captureMode: 'mic' })).ok);
      assert.equal(starts, 2);
    })
);
