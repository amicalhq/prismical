/**
 * Segment minting for the on-device lanes keeps one stable shape across the
 * product store, renderer, and optional cloud sync:
 *
 *   id            deterministicSegmentId(recordingId, segmentOrder) — tsg_ +
 *                 sha1 hex, STABLE across re-transcriptions of the same chunk
 *   speaker       source === 'system' ? 'them' : 'you'   (channel-derived)
 *   startTimeMs   chunkStartMs
 *   endTimeMs     chunkStartMs + round(samples / 48 kHz → ms)
 *   segmentOrder  SEGMENT_ORDER_CLOUD_BASE + chunkIndex × SEGMENT_ORDER_WINDOW
 *   isFinal       true; createdAt/updatedAt ISO(now); deletedAt null
 *
 * ONE row per non-empty chunk, never per whisper sub-segment: the store's
 * upsert identity is (recordingId, segmentOrder) and a retried chunk (drain)
 * must replace exactly its own row.
 */
import { createHash } from 'node:crypto';
import { SEGMENT_ORDER_CLOUD_BASE, SEGMENT_ORDER_WINDOW } from '@prismical/ai-prompts/transcription';
import type { MeetingCaptureMode } from '@/types/meeting';
import { CAPTURE_SAMPLE_RATE } from '../recording/chunker';
import type { RecordingSegment, TranscribeChunkParams } from '../transport/service';

/**
 * A segment minted in main carries the full wire row (the extras the store
 * normalizes and the cloud-mode mirror POSTs), not just the 8 lane fields.
 */
export interface MintedSegment extends RecordingSegment {
  readonly isFinal: true;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: null;
}

export interface MintChunkSegmentInput {
  readonly recordingId: string;
  readonly params: TranscribeChunkParams;
  /** The chunk's 48 kHz samples — only the LENGTH feeds the duration. */
  readonly samples: Float32Array;
  readonly text: string;
  /** Epoch ms (Clock) — stamps createdAt/updatedAt. */
  readonly now: number;
}

/** The server's segmentOrder for a chunk — the window base, one row per chunk. */
export const chunkSegmentOrder = (chunkIndex: number): number =>
  SEGMENT_ORDER_CLOUD_BASE + chunkIndex * SEGMENT_ORDER_WINDOW;

/**
 * The DETERMINISTIC segment id for a chunk. A fresh id per attempt could make
 * a re-transcribed chunk (live once, drain once) appear as a second synced
 * row. Hashing `(recordingId, segmentOrder)` keeps the id stable across
 * attempts and makes the mirror's create idempotent. Shape: `tsg_` + 24
 * lowercase-hex chars — passes @prismical/id's
 * isValidPrefixedId (exact prefix + a non-empty [a-z0-9_-] suffix) without
 * pretending to be a cuid.
 */
export const deterministicSegmentId = (recordingId: string, segmentOrder: number): string =>
  `tsg_${createHash('sha1').update(`${recordingId}:${segmentOrder}`).digest('hex').slice(0, 24)}`;

/**
 * Mint the ONE segment a non-empty chunk produces, or null when the (trimmed)
 * text is empty — a lane then acks `{ ok: true, value: [] }` exactly like the
 * server does for a silent chunk.
 */
export const mintChunkSegment = ({
  recordingId,
  params,
  samples,
  text,
  now,
}: MintChunkSegmentInput): MintedSegment | null => {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const durationMs = Math.round((samples.length / CAPTURE_SAMPLE_RATE) * 1000);
  const iso = new Date(now).toISOString();
  const segmentOrder = chunkSegmentOrder(params.chunkIndex);
  return {
    id: deterministicSegmentId(recordingId, segmentOrder),
    recordingId,
    source: params.source,
    speaker: params.source === 'system' ? 'them' : 'you',
    text: trimmed,
    startTimeMs: params.chunkStartMs,
    endTimeMs: params.chunkStartMs + durationMs,
    segmentOrder,
    isFinal: true,
    createdAt: iso,
    updatedAt: iso,
    deletedAt: null,
  };
};

/**
 * The channel-derived speaker count a non-cloud engine writes into
 * recording.meta at finalize. The server derives it from
 * diarization; on-device lanes have only the channels): a dual recording
 * with any non-empty system-lane segment is a conversation (2), anything
 * else is a voice note (1). Merged with the max rule
 * (RecordingStore.recordingMetaMerged), so it only ever goes up.
 */
export const detectedSpeakerCountFor = (
  captureMode: MeetingCaptureMode,
  segments: readonly RecordingSegment[]
): number =>
  captureMode === 'dual' &&
  segments.some(segment => segment.source === 'system' && segment.text.trim() !== '')
    ? 2
    : 1;
