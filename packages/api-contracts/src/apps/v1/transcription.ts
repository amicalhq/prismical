import { z } from 'zod';
import { DirectoryCompanyRefSchema } from './people.js';
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

/** Registry keys: the two channel keys plus diarized speakers (`dz:` + a provider label). */
export const RECORDING_SPEAKER_KEY_PATTERN = /^(you|them|dz:[A-Za-z0-9_-]{1,32})$/;
export const RecordingSpeakerKeyParamsSchema = z.object({
  recordingId: z.string().min(1),
  speakerKey: z.string().regex(RECORDING_SPEAKER_KEY_PATTERN),
});
/**
 * Tag a speaker by key (upsert): a display name, a link to a person in the org, and/or the
 * owner flag. Every field is optional but at least one must be present; `null` clears.
 */
export const TagRecordingSpeakerRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    personId: z.string().min(1).nullable().optional(),
    isOwner: z.boolean().optional(),
  })
  .strict()
  .refine(
    body => body.displayName !== undefined || body.personId !== undefined || body.isOwner !== undefined,
    { message: 'At least one of displayName, personId, isOwner is required' }
  );

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
    /** The recording owner's voice; rendered like the `you` channel key. */
    isOwner: z.boolean().default(false),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
  })
  .strip();
export type RecordingSpeaker = z.output<typeof RecordingSpeakerSchema>;
export const RecordingSpeakerResponseSchema = RecordingSpeakerSchema;

/** Someone on the calendar event behind a recording - the tag picker's first group. */
export const SpeakerCandidateSchema = z
  .object({
    id: z.string().min(1),
    email: z.string(),
    name: z.string().nullable(),
    isInternal: z.boolean(),
    company: DirectoryCompanyRefSchema.nullable(),
    role: z.string().nullable(),
  })
  .strip();
export type SpeakerCandidate = z.output<typeof SpeakerCandidateSchema>;
export const SpeakerCandidatesResponseSchema = z
  .object({ participants: z.array(SpeakerCandidateSchema) })
  .strip();
