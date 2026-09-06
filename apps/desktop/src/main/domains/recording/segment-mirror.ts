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
 * Delivery must succeed before a chunk is acknowledged. A failed mirror
 * leaves the recovery cursor behind the chunk, so its stable segment id can
 * be retried before cloud finalization.
 * Never called for the cloud engine (the server minted those rows itself) or
 * in local mode (there is no core).
 */
import { Effect } from 'effect';
import type { ScopedLog } from '../../infra/logging/service';
import type {
  RecordingLaneResult,
  RecordingSegment,
  WorkspaceBackendApi,
} from '../transport/service';
import { isTransientStatus } from '../transport/live';

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
): Effect.Effect<RecordingLaneResult<void>> =>
  Effect.gen(function* () {
    for (const segment of segments) {
      const res = yield* coreClient.request({
        method: 'POST',
        path: TRANSCRIPT_SEGMENTS_PATH,
        body: transcriptSegmentCreateBody(segment),
      });
      if ('ok' in res && res.status >= 200 && res.status < 300) continue;
      yield* log.warn('segment mirror to core failed — retained for recovery', {
        recordingId,
        segmentOrder: segment.segmentOrder,
        ...('ok' in res ? { status: res.status } : { error: res.error.code }),
      });
      return 'ok' in res
        ? {
            ok: false,
            retryable: isTransientStatus(res.status),
            failure: { kind: 'http', status: res.status },
          }
        : { ok: false, retryable: true, failure: { kind: 'network' } };
    }
    return { ok: true, value: undefined };
  });
