import { Context, type Effect } from 'effect';
import type { CAPTURE_SAMPLE_RATE } from '../recording/chunker';
import type {
  RecordingLaneResult,
  RecordingSegment,
  TranscribeChunkParams,
} from '../transport/service';
import type { RecordingEngine } from './engine';

/**
 * The Transcriber is the one seam the recording lane
 * transcribes through. Both chunk producers (the live RecordingService and the
 * recovery drain) hand every chunk here as 48 kHz Float32 PCM plus the frozen
 * per-recording engine; the seam dispatches to the engine's lane:
 *
 *   cloud → CloudTranscriberLane  (WAV-encode + WorkspaceBackend.uploadTranscriptionChunk)
 *   local → LocalTranscriberLane  (on-device whisper.cpp)
 *   byok  → ByokTranscriberLane   (OpenAI-compatible endpoint)
 *
 * The contract mirrors the cloud upload's so the cursor/ack/drain semantics
 * stay untouched: NEVER fails (E = never), resolves a RecordingLaneResult the
 * caller branches on, and yields either [] (silent/empty chunk) or exactly ONE
 * segment per non-empty chunk minted with the server's math (segment.ts) so
 * the store's (recordingId, segmentOrder) upsert identity and the drain's
 * idempotency hold for every engine.
 *
 * Workspace-scoped (sharedWorkspaceServices): one memoized instance provided
 * to BOTH RecordingServiceLive and RecoveryDrainLive, like the RecordingStore.
 */

/** One chunk's audio exactly as the chunker cuts it: 48 kHz mono Float32. */
export interface ChunkAudio {
  readonly samples: Float32Array;
  readonly sampleRate: typeof CAPTURE_SAMPLE_RATE;
}

export interface TranscriberApi {
  /**
   * Transcribe one chunk under `engine` (resolved + frozen by the caller at
   * recording start / drain-pass start — see engine.ts). Never fails; the
   * result classifies retryability exactly like the cloud upload does.
   */
  readonly transcribeChunk: (
    recordingId: string,
    params: TranscribeChunkParams,
    audio: ChunkAudio,
    engine: RecordingEngine
  ) => Effect.Effect<RecordingLaneResult<readonly RecordingSegment[]>>;
}

export class Transcriber extends Context.Tag('desktop/Transcriber')<
  Transcriber,
  TranscriberApi
>() {}

/**
 * One engine's lane — the same shape as the seam, so TranscriberLive is pure
 * dispatch. Three tags let production swap placeholder local/BYOK lanes for the
 * real LocalWhisperLive / ByokTranscriberLive in sharedWorkspaceServices
 * without touching the seam or its consumers.
 */
export type TranscriberLaneApi = TranscriberApi;

export class CloudTranscriberLane extends Context.Tag('desktop/transcriber/CloudLane')<
  CloudTranscriberLane,
  TranscriberLaneApi
>() {}

export class LocalTranscriberLane extends Context.Tag('desktop/transcriber/LocalLane')<
  LocalTranscriberLane,
  TranscriberLaneApi
>() {}

export class ByokTranscriberLane extends Context.Tag('desktop/transcriber/ByokLane')<
  ByokTranscriberLane,
  TranscriberLaneApi
>() {}
