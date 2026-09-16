import { z } from 'zod';
import { Effect } from 'effect';
import { RecordingStreamError } from '../transport/recording-socket';
import { TranscriptSegmentSchema } from '@prismical/api-contracts/apps/v1';

const samples = z.number().int().nonnegative().max(0xffff_ffff);
const checkpoints = z.object({ mic: samples, system: samples });
const message = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    version: z.literal(1),
    status: z.enum(['open', 'stopping', 'completed']),
    sampleRate: z.literal(48_000),
    lanes: z.array(z.enum(['mic', 'system'])),
    checkpoints,
    maxFrameBytes: z.number().int().min(7),
    gcsFlushIntervalMs: z.number().positive(),
    recordingLimitMs: z.number().nonnegative(),
  }),
  z.object({ type: z.literal('ack'), checkpoints }),
  z.object({ type: z.literal('stopped'), checkpoints, durationMs: z.number().nonnegative() }),
  z.object({ type: z.literal('finalizing'), status: z.enum(['pending', 'running']) }),
  z.object({
    type: z.literal('finalized'),
    status: z.enum(['done', 'skipped', 'failed']),
    reason: z.string().optional(),
    results: z.array(TranscriptSegmentSchema),
  }),
  z.object({
    type: z.literal('transcript'),
    source: z.enum(['mic', 'system']),
    chunkIndex: z.number().int(),
    results: z.array(TranscriptSegmentSchema),
  }),
  z.object({
    type: z.literal('chunk_dropped'),
    source: z.enum(['mic', 'system']),
    chunkIndex: z.number().int(),
    code: z.string(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), retryable: z.boolean() }),
]);

export type RecordingStreamMessage = z.infer<typeof message>;

export const decodeStreamMessage = (
  data: unknown
): Effect.Effect<RecordingStreamMessage, RecordingStreamError> =>
  Effect.try({
    try: () => message.parse(JSON.parse(typeof data === 'string' ? data : '')),
    catch: () => new RecordingStreamError({ code: 'protocol', retryable: false }),
  });
