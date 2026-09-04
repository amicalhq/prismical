/**
 * TranscriberLive — pure dispatch over the three engine
 * lanes. The engine arrives per call (frozen by the producer), so the seam
 * holds no per-recording state of its own; whatever state a lane needs
 * (resampler, prompt context, worker handle) lives inside that lane.
 * Requires the three lane tags for CloudTranscriberLive, LocalWhisperLive, and
 * ByokTranscriberLive.
 */
import { Effect, Layer } from 'effect';
import {
  ByokTranscriberLane,
  CloudTranscriberLane,
  LocalTranscriberLane,
  Transcriber,
  type TranscriberApi,
} from './service';

export const TranscriberLive: Layer.Layer<
  Transcriber,
  never,
  CloudTranscriberLane | LocalTranscriberLane | ByokTranscriberLane
> = Layer.effect(
  Transcriber,
  Effect.gen(function* () {
    const lanes = {
      cloud: yield* CloudTranscriberLane,
      local: yield* LocalTranscriberLane,
      byok: yield* ByokTranscriberLane,
    } as const;
    const api: TranscriberApi = {
      transcribeChunk: (recordingId, params, audio, engine) =>
        lanes[engine.engine].transcribeChunk(recordingId, params, audio, engine),
    };
    return api;
  })
);
