/**
 * Cloud-mode segment mirror. When a cloud-mode recording
 * runs a NON-cloud engine, core never sees the chunks — the device transcribes
 * them — yet the transcript must reach core BEFORE the finalize PUT:
 * `recording.transcribed` (auto-enhance, automations) fires on the
 * status→'completed' transition and reads the transcript then. So each
 * locally minted segment is POSTed through the sync create dialect
 * (`POST /apps/v1/me/transcript-segments`, SyncTranscriptSegmentCreateRequestSchema's
 * field set — the client-minted tsg_ id and the SAME segmentOrder the store
 * keys on) as the chunk resolves, sequentially per recording.
 *
 * Best-effort by design: a non-2xx or the reserved INTERNAL envelope folds
 * to ONE warn per segment and the audio path continues — the segment still
 * lives in the product store, and a miss here only degrades the server copy.
 * Never called for the cloud engine (the server minted those rows itself) or
 * in local mode (there is no core).
 */
import { Effect } from 'effect';
import type { ScopedLog } from '../../infra/logging/service';
import type { RecordingSegment, WorkspaceBackendApi } from '../transport/service';

export const TRANSCRIPT_SEGMENTS_PATH = '/apps/v1/me/transcript-segments';

/** The sync create body — exactly the fields the schema names, nothing else. */
export const transcriptSegmentCreateBody = (segment: RecordingSegment) => {
  const isFinal = (segment as RecordingSegment & { readonly isFinal?: unknown }).isFinal;
  return {
    id: segment.id,
    recordingId: segment.recordingId,
    source: segment.source,
    speaker: segment.speaker,
    text: segment.text,
    startTimeMs: segment.startTimeMs,
    endTimeMs: segment.endTimeMs,
    segmentOrder: segment.segmentOrder,
    isFinal: typeof isFinal === 'boolean' ? isFinal : true,
  };
};

export const mirrorSegmentsToCore = (
  coreClient: WorkspaceBackendApi,
  log: ScopedLog,
  recordingId: string,
  segments: readonly RecordingSegment[]
): Effect.Effect<void> =>
  Effect.forEach(
    segments,
    segment =>
      coreClient
        .request({
          method: 'POST',
          path: TRANSCRIPT_SEGMENTS_PATH,
          body: transcriptSegmentCreateBody(segment),
        })
        .pipe(
          Effect.flatMap(res =>
            'ok' in res && res.status >= 200 && res.status < 300
              ? Effect.void
              : log.warn('segment mirror to core failed — kept locally', {
                  recordingId,
                  segmentOrder: segment.segmentOrder,
                  ...('ok' in res ? { status: res.status } : { error: res.error.code }),
                })
          ),
          // A defect must not take the upload fiber down with it.
          Effect.catchAllDefect(defect =>
            log.warn('segment mirror to core defect — kept locally', {
              recordingId,
              segmentOrder: segment.segmentOrder,
              defect: String(defect),
            })
          )
        ),
    { discard: true }
  );
