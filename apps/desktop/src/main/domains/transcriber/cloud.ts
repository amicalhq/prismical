/**
 * Encode cloud uploads as 16 kHz mono PCM16 WAV after anti-aliased downsampling.
 * Live and recovery use this same conversion. Native capture/recovery WAVs stay
 * at 48 kHz; chunk indices, source offsets and returned segments stay unchanged.
 */
import { Effect, Layer } from 'effect';
import { downsample48To16 } from '../../infra/audio/downsample-48-to-16';
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
              encodeWavPcm16(downsample48To16(audio.samples), 16_000)
            )
          ),
      })
    )
  );
