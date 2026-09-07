import { z } from 'zod';
import { AppsV1DateTimeResponseSchema, appsV1ListResponseSchema } from './common.js';

export const RecordingIdParamsSchema = z.object({ recordingId: z.string().min(1) });

export const TranscribeChunkParamsSchema = z.object({
  recordingId: z.string().min(1).describe('Recording this chunk belongs to.'),
});
export const TranscribeChunkQuerySchema = z.object({
  chunkIndex: z.coerce
    .number()
    .int()
    .min(0)
    .max(500_000)
    .describe('0-based chunk sequence number; retries of the same index are idempotent.'),
  chunkStartMs: z.coerce
    .number()
    .int()
    .min(0)
    .describe('Offset of this chunk from the start of the recording, in ms.'),
  source: z.enum(['mic', 'system']).default('mic'),
});
export type TranscribeChunkQuery = z.output<typeof TranscribeChunkQuerySchema>;
export const TRANSCRIBE_AUDIO_MEDIA_TYPE = 'audio/wav' as const;

export const TranscriptSegmentSchema = z
  .object({
    id: z.string().min(1),
    recordingId: z.string().min(1),
    orgUserId: z.string().min(1),
    source: z.string(),
    speaker: z.string(),
    text: z.string(),
    startTimeMs: z.number().int().nonnegative(),
    endTimeMs: z.number().int().nonnegative(),
    segmentOrder: z.number().int().nonnegative(),
    isFinal: z.boolean(),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
    deletedAt: AppsV1DateTimeResponseSchema.nullable(),
  })
  .strip();
export type TranscriptSegment = z.output<typeof TranscriptSegmentSchema>;
export const TranscribeChunkResponseSchema = appsV1ListResponseSchema(TranscriptSegmentSchema);

export const RecordingSpeakerParamsSchema = z.object({ speakerId: z.string().min(1) });
export const RenameRecordingSpeakerRequestSchema = z
  .object({ displayName: z.string().trim().min(1).max(120).nullable() })
  .strict();

export const RecordingSpeakerSchema = z
  .object({
    id: z.string().min(1),
    recordingId: z.string().min(1),
    orgUserId: z.string().min(1),
    speakerKey: z.string(),
    source: z.string(),
    displayName: z.string().nullable(),
    personId: z.string().nullable(),
    confidence: z.number().nullable(),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
  })
  .strip();
export type RecordingSpeaker = z.output<typeof RecordingSpeakerSchema>;
export const RecordingSpeakerResponseSchema = RecordingSpeakerSchema;
