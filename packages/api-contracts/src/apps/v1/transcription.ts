import { z } from 'zod';
import {
  AppsV1DateTimeResponseSchema,
  appsV1ListResponseSchema,
} from './common.js';

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

export const TranscriptionStagingModeSchema = z.enum(['off', 'client', 'server']);
export type TranscriptionStagingMode = z.output<typeof TranscriptionStagingModeSchema>;
export const TranscriptionSettingsResponseSchema = z
  .object({
    liveTranscription: z.boolean(),
    staging: TranscriptionStagingModeSchema.default('client'),
  })
  .strip();
export type TranscriptionSettingsResponse = z.output<typeof TranscriptionSettingsResponseSchema>;

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

export const StagingLaneSchema = z.enum(['mic', 'system', 'mix']);
export type StagingLane = z.output<typeof StagingLaneSchema>;
export const StagingContentTypeSchema = z.enum([
  'audio/wav',
  'audio/mp4',
  'audio/webm',
  'audio/ogg',
  'audio/flac',
]);

const uniqueLanes = (lanes: { lane: StagingLane }[]) =>
  new Set(lanes.map(lane => lane.lane)).size === lanes.length;

export const MintStagingUrlsRequestSchema = z
  .object({
    lanes: z
      .array(z.object({ lane: StagingLaneSchema, contentType: StagingContentTypeSchema }).strict())
      .min(1)
      .max(3),
  })
  .strict()
  .refine(body => uniqueLanes(body.lanes), { message: 'duplicate lane' });

export const CompleteStagingRequestSchema = z
  .object({
    lanes: z
      .array(
        z
          .object({
            lane: StagingLaneSchema,
            contentType: StagingContentTypeSchema,
            durationMs: z
              .number()
              .int()
              .positive()
              .max(24 * 60 * 60 * 1000)
              .optional(),
          })
          .strict()
      )
      .min(1)
      .max(3),
  })
  .strict()
  .refine(body => uniqueLanes(body.lanes), { message: 'duplicate lane' });

export const StagingAbandonReasonSchema = z.enum([
  'no-audio',
  'staging-disabled',
  'upload-failed',
  'upload-gave-up',
]);
export type StagingAbandonReason = z.output<typeof StagingAbandonReasonSchema>;
export const AbandonStagingRequestSchema = z
  .object({ reason: StagingAbandonReasonSchema })
  .strict();

export const StagingLaneUploadSchema = z
  .object({
    lane: StagingLaneSchema,
    objectName: z.string().min(1),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
  })
  .strip();
export type StagingLaneUpload = z.output<typeof StagingLaneUploadSchema>;

export const MintStagingUrlsResponseSchema = z
  .object({ uploads: z.array(StagingLaneUploadSchema), expiresAt: z.iso.datetime() })
  .strip();

export const CompleteStagingResponseSchema = z
  .object({
    status: z.enum(['staged', 'unchanged']),
    recordingId: z.string().min(1),
  })
  .strip();

export const AbandonStagingResponseSchema = z
  .object({
    status: z.enum(['skipped', 'unchanged']),
    recordingId: z.string().min(1),
  })
  .strip();
