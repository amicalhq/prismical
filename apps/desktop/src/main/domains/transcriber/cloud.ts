/**
 * CloudTranscriberLive — the cloud lane behind the
 * Transcriber seam: exactly what the two call sites did before the seam
 * existed, moved here so ONLY the cloud lane pays for a WAV. Encodes the
 * chunk's 48 kHz Float32 samples to the canonical mono PCM16 WAV (wav.ts) and
 * hands it to WorkspaceBackend.uploadTranscriptionChunk with the SAME
 * (recordingId, params, wav) triple — byte-identical on the wire, and the
 * server keeps minting the segments. In local mode the LocalBackend's stub
 * answers this call (it acks []), but the seam never routes 'cloud' there:
 * engine resolution coerces local mode to the local lane.
 */
import { Effect, Layer } from 'effect';
import { encodeWavPcm16 } from '../recording/wav';
import { WorkspaceBackend } from '../transport/service';
import { CloudTranscriberLane, type TranscriberLaneApi } from './service';

export const CloudTranscriberLive: Layer.Layer<CloudTranscriberLane, never, WorkspaceBackend> =
  Layer.effect(
    CloudTranscriberLane,
    Effect.map(
      WorkspaceBackend,
      (coreClient): TranscriberLaneApi => ({
        transcribeChunk: (recordingId, params, audio) =>
          Effect.suspend(() =>
            coreClient.uploadTranscriptionChunk(
              recordingId,
              params,
              encodeWavPcm16(audio.samples, audio.sampleRate)
            )
          ),
      })
    )
  );
