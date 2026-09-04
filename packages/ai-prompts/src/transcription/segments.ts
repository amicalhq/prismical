/**
 * Pure mapping from a transcribed audio chunk to `transcript_segment` insert values.
 * One row per chunk at coarse granularity; the per-chunk
 * segmentOrder WINDOW keeps chunk uploads idempotent: a retried chunk deletes+rewrites
 * only its own window.
 */

export const SEGMENT_ORDER_WINDOW = 1000;

/**
 * Cloud-written segments live at a high segmentOrder base so the idempotent delete-window
 * can NEVER touch desktop-written segments (which use small sequential orders 0,1,2,…) if
 * a recording ever carries both.
 */
export const SEGMENT_ORDER_CLOUD_BASE = 1_000_000;

export interface ChunkContext {
  recordingId: string;
  orgUserId: string;
  chunkIndex: number;
  chunkStartMs: number;
  source: string;
  durationMs: number;
}

export interface SegmentValues {
  recordingId: string;
  orgUserId: string;
  source: string;
  speaker: string;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  segmentOrder: number;
  isFinal: boolean;
}

export function segmentOrderRange(chunkIndex: number): [number, number] {
  const start = SEGMENT_ORDER_CLOUD_BASE + chunkIndex * SEGMENT_ORDER_WINDOW;
  return [start, start + SEGMENT_ORDER_WINDOW - 1];
}

export function chunkSegmentValues(text: string, ctx: ChunkContext): SegmentValues[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return [
    {
      recordingId: ctx.recordingId,
      orgUserId: ctx.orgUserId,
      source: ctx.source,
      // Attribute the speaker from the audio channel: system audio is the other
      // party ('them'), the mic is the local user ('you'). Dual-source (desktop)
      // recordings carry both; single-source (mic-only) clients stay 'you'.
      speaker: ctx.source === 'system' ? 'them' : 'you',
      text: trimmed,
      startTimeMs: ctx.chunkStartMs,
      endTimeMs: ctx.chunkStartMs + ctx.durationMs,
      segmentOrder: SEGMENT_ORDER_CLOUD_BASE + ctx.chunkIndex * SEGMENT_ORDER_WINDOW,
      isFinal: true,
    },
  ];
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
