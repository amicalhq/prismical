import { z } from 'zod';
import { AppsV1NoContentResponseSchema, appsV1ListResponseSchema } from './common.js';

export const AppsV1IdParamsSchema = z.object({
  id: z.string().min(1).describe('Client-provided prefixed id (the id IS the document name).'),
});

export function syncListQuerySchema(filterKeys: readonly string[] = []) {
  const shape: Record<string, z.ZodTypeAny> = {
    since: z
      .string()
      .optional()
      .describe(
        'Delta cursor: epoch-ms or ISO 8601. Returns rows with updatedAt > since; omit for a full pull.'
      ),
    includeDeleted: z
      .string()
      .optional()
      .describe("Set to '1' or 'true' to include tombstoned (deleted) rows in the delta."),
  };
  for (const key of filterKeys) {
    shape[key] = z.string().optional().describe(`Filter results by ${key}.`);
  }
  return z.object(shape);
}

const SyncWriteTimestampSchema = z.union([z.string(), z.number()]);
const SyncJsonObjectSchema = z.record(z.string(), z.any());
const SyncCreateBaseSchema = z.object({
  id: z.string().optional(),
  updatedAt: SyncWriteTimestampSchema.optional(),
});
const SyncUpdateBaseSchema = z.object({
  updatedAt: SyncWriteTimestampSchema.optional(),
});

export const TAG_NAME_MAX_LENGTH = 50;
export const TAG_NAME_PATTERN = /^[A-Za-z0-9]+$/;
export const TAG_NAME_FORMAT_ERROR =
  'Tag name must contain only letters and numbers — no spaces, hyphens, underscores, commas, or other characters';
export const NORMALIZED_TAG_NAME_FALLBACK = 'tag';

export const TagNameSchema = z
  .string()
  .max(TAG_NAME_MAX_LENGTH, `Tag name must be at most ${TAG_NAME_MAX_LENGTH} characters`)
  .regex(TAG_NAME_PATTERN, TAG_NAME_FORMAT_ERROR);

export function normalizeTagName(name: string): string {
  if (TAG_NAME_PATTERN.test(name) && name.length <= TAG_NAME_MAX_LENGTH) return name;
  const normalized = name.replace(/[^A-Za-z0-9]+/g, '').slice(0, TAG_NAME_MAX_LENGTH);
  return normalized || NORMALIZED_TAG_NAME_FALLBACK;
}

export const NormalizedSyncTagNameSchema = z.string().transform(normalizeTagName);

export const SyncVocabularyCreateRequestSchema = SyncCreateBaseSchema.extend({
  word: z.string().min(1),
  replacementWord: z.string().nullable().optional(),
  isReplacement: z.boolean().optional(),
  usageCount: z.number().int().optional(),
});
export const SyncVocabularyUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  word: z.string().min(1).optional(),
  replacementWord: z.string().nullable().optional(),
  isReplacement: z.boolean().optional(),
  usageCount: z.number().int().optional(),
});

export const SyncTagCreateRequestSchema = SyncCreateBaseSchema.extend({
  name: NormalizedSyncTagNameSchema,
  color: z.string().min(1),
  isFavorite: z.boolean().optional(),
});
export const SyncTagUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  name: NormalizedSyncTagNameSchema.optional(),
  color: z.string().min(1).optional(),
  isFavorite: z.boolean().optional(),
});

export const SyncRecordingCreateRequestSchema = SyncCreateBaseSchema.extend({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  captureMode: z.string().min(1),
  status: z.string().optional(),
  eventId: z.string().nullable().optional(),
  noteId: z.string().nullable().optional(),
  transcriptionConfig: SyncJsonObjectSchema.optional(),
  startedAt: SyncWriteTimestampSchema.nullable().optional(),
  endedAt: SyncWriteTimestampSchema.nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  meta: SyncJsonObjectSchema.nullable().optional(),
  stagingExpected: z.boolean().optional(),
  transcriptionDeferred: z.boolean().optional(),
});
export const SyncRecordingUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  captureMode: z.string().min(1).optional(),
  status: z.string().optional(),
  eventId: z.string().nullable().optional(),
  noteId: z.string().nullable().optional(),
  transcriptionConfig: SyncJsonObjectSchema.optional(),
  startedAt: SyncWriteTimestampSchema.nullable().optional(),
  endedAt: SyncWriteTimestampSchema.nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  meta: SyncJsonObjectSchema.nullable().optional(),
  stagingExpected: z.boolean().optional(),
  transcriptionDeferred: z.boolean().optional(),
});

export const SyncTranscriptSegmentCreateRequestSchema = SyncCreateBaseSchema.extend({
  recordingId: z.string().min(1),
  source: z.string().min(1),
  speaker: z.string().min(1),
  text: z.string(),
  startTimeMs: z.number().int(),
  endTimeMs: z.number().int(),
  segmentOrder: z.number().int().optional(),
  isFinal: z.boolean().optional(),
});
export const SyncTranscriptSegmentUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  text: z.string().optional(),
  speaker: z.string().optional(),
  startTimeMs: z.number().int().optional(),
  endTimeMs: z.number().int().optional(),
  segmentOrder: z.number().int().optional(),
  isFinal: z.boolean().optional(),
});

export const SyncSkillCreateRequestSchema = SyncCreateBaseSchema.extend({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  body: z.string().min(1),
  metadata: SyncJsonObjectSchema.optional(),
  config: SyncJsonObjectSchema,
  allowedTools: z.any().optional(),
  public: z.boolean().optional(),
  enabled: z.boolean().optional(),
  version: z.number().int().optional(),
});
export const SyncSkillUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  body: z.string().min(1).optional(),
  metadata: SyncJsonObjectSchema.optional(),
  config: SyncJsonObjectSchema.optional(),
  allowedTools: z.any().optional(),
  public: z.boolean().optional(),
  enabled: z.boolean().optional(),
  version: z.number().int().optional(),
});

export const SyncArtifactCreateRequestSchema = SyncCreateBaseSchema.extend({
  noteId: z.string().min(1),
  skillId: z.string().min(1),
  mode: z.string().min(1),
  version: z.number().int().optional(),
  content: z.string(),
  generator: z.string().min(1),
  modelId: z.string().nullable().optional(),
  meta: SyncJsonObjectSchema.nullable().optional(),
  inputTokens: z.number().int().nullable().optional(),
  outputTokens: z.number().int().nullable().optional(),
  totalTokens: z.number().int().nullable().optional(),
  costUsd: z.number().nullable().optional(),
});
export const SyncArtifactUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  content: z.string().optional(),
  version: z.number().int().optional(),
  meta: SyncJsonObjectSchema.nullable().optional(),
});

export const SyncNoteGenerationAuditCreateRequestSchema = SyncCreateBaseSchema.extend({
  noteId: z.string().nullable().optional(),
  modelInstanceId: z.string().min(1),
  modelId: z.string().min(1),
  providerType: z.string().min(1),
  inputTokens: z.number().int().nullable().optional(),
  outputTokens: z.number().int().nullable().optional(),
  totalTokens: z.number().int().nullable().optional(),
  costUsd: z.number().nullable().optional(),
});
export const SyncNoteGenerationAuditUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  totalTokens: z.number().int().nullable().optional(),
  costUsd: z.number().nullable().optional(),
});

export const SyncInstanceCreateRequestSchema = SyncCreateBaseSchema.extend({
  provider: z.string().min(1),
  label: z.string().min(1),
  config: SyncJsonObjectSchema.optional(),
  credentials: SyncJsonObjectSchema.optional(),
});
export const SyncInstanceUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  label: z.string().min(1).optional(),
  config: SyncJsonObjectSchema.optional(),
  credentials: SyncJsonObjectSchema.optional(),
});

export const SyncFolderCreateRequestSchema = SyncCreateBaseSchema.extend({
  name: z.string().min(1),
  parentId: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  isFavorite: z.boolean().optional(),
  meta: SyncJsonObjectSchema.nullable().optional(),
});
export const SyncFolderUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  name: z.string().min(1).optional(),
  parentId: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  isFavorite: z.boolean().optional(),
  meta: SyncJsonObjectSchema.nullable().optional(),
});

export const SyncNoteCreateRequestSchema = SyncCreateBaseSchema.extend({
  titleIntent: z.literal('default').optional(),
  title: z.string().optional(),
  timezone: z.string().optional(),
  folderId: z.string().nullable().optional(),
  eventId: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  starred: z.boolean().optional(),
  meta: SyncJsonObjectSchema.nullable().optional(),
});
export const SyncNoteUpdateRequestSchema = SyncUpdateBaseSchema.extend({
  title: z.string().optional(),
  folderId: z.string().nullable().optional(),
  eventId: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  starred: z.boolean().optional(),
  meta: SyncJsonObjectSchema.nullable().optional(),
});
export const SyncNoteListQuerySchema = syncListQuerySchema().extend({
  includeBody: z
    .string()
    .optional()
    .describe(
      "Set to '1' or 'true' to include each note's full body as markdown. Omitted by default."
    ),
});

export const EmptySyncWriteRequestSchema = z.object({});
export const SyncSkillPreferenceRequestSchema = z.object({
  skillId: z.string().min(1),
  enabled: z.boolean().optional(),
});
export const SyncSkillIdRequestSchema = z.object({ skillId: z.string().min(1) });

export type SyncVocabularyCreateRequest = z.input<typeof SyncVocabularyCreateRequestSchema>;
export type SyncVocabularyUpdateRequest = z.input<typeof SyncVocabularyUpdateRequestSchema>;
export type SyncTagCreateRequest = z.input<typeof SyncTagCreateRequestSchema>;
export type SyncTagUpdateRequest = z.input<typeof SyncTagUpdateRequestSchema>;
export type SyncRecordingCreateRequest = z.input<typeof SyncRecordingCreateRequestSchema>;
export type SyncRecordingUpdateRequest = z.input<typeof SyncRecordingUpdateRequestSchema>;
export type SyncTranscriptSegmentCreateRequest = z.input<
  typeof SyncTranscriptSegmentCreateRequestSchema
>;
export type SyncTranscriptSegmentUpdateRequest = z.input<
  typeof SyncTranscriptSegmentUpdateRequestSchema
>;
export type SyncSkillCreateRequest = z.input<typeof SyncSkillCreateRequestSchema>;
export type SyncSkillUpdateRequest = z.input<typeof SyncSkillUpdateRequestSchema>;
export type SyncArtifactCreateRequest = z.input<typeof SyncArtifactCreateRequestSchema>;
export type SyncArtifactUpdateRequest = z.input<typeof SyncArtifactUpdateRequestSchema>;
export type SyncNoteGenerationAuditCreateRequest = z.input<
  typeof SyncNoteGenerationAuditCreateRequestSchema
>;
export type SyncNoteGenerationAuditUpdateRequest = z.input<
  typeof SyncNoteGenerationAuditUpdateRequestSchema
>;
export type SyncInstanceCreateRequest = z.input<typeof SyncInstanceCreateRequestSchema>;
export type SyncInstanceUpdateRequest = z.input<typeof SyncInstanceUpdateRequestSchema>;
export type SyncFolderCreateRequest = z.input<typeof SyncFolderCreateRequestSchema>;
export type SyncFolderUpdateRequest = z.input<typeof SyncFolderUpdateRequestSchema>;
export type SyncNoteCreateRequest = z.input<typeof SyncNoteCreateRequestSchema>;
export type SyncNoteUpdateRequest = z.input<typeof SyncNoteUpdateRequestSchema>;
export type SyncSkillPreferenceRequest = z.input<typeof SyncSkillPreferenceRequestSchema>;
export type SyncSkillIdRequest = z.input<typeof SyncSkillIdRequestSchema>;

export const SyncRecordSchema = z.record(z.string(), z.unknown());
export const SyncListResponseSchema = appsV1ListResponseSchema(SyncRecordSchema);
export const SyncResultResponseSchema = SyncRecordSchema;
export const SyncWriteResponseSchema = z.object({
  result: SyncRecordSchema,
  applied: z.boolean(),
  created: z.boolean().optional(),
});
export const SyncDeleteResponseSchema = AppsV1NoContentResponseSchema;

export type SyncListResponse = z.output<typeof SyncListResponseSchema>;
export type SyncResultResponse = z.output<typeof SyncResultResponseSchema>;
export type SyncWriteResponse = z.output<typeof SyncWriteResponseSchema>;
export type SyncDeleteResponse = z.output<typeof SyncDeleteResponseSchema>;

export type SyncWriteEnvelope<T> = {
  result: T;
  applied: boolean;
  created?: boolean;
};

export const NoteTagRequestSchema = z
  .object({ noteId: z.string().min(1), tagId: z.string().min(1) })
  .strict();
export const NoteTagParamsSchema = NoteTagRequestSchema;
export const NoteTagSchema = NoteTagRequestSchema.strip();
export const NoteTagResponseSchema = NoteTagSchema;

// note_event: a note's link to a calendar event. Links are keyed on the event's cross-user key
// (the same for every attendee's copy of the invite), so `eventId` on the wire is always the
// CALLER's own event row: what they send when linking, and what a link resolves to when read.
export const NoteEventLinkRequestSchema = z
  .object({
    noteId: z.string().min(1),
    /** The caller's own event row; the server derives the cross-user key from it. */
    eventId: z.string().min(1),
    /** Make this the note's primary event (default: only when the note has no primary yet). */
    isPrimary: z.boolean().optional(),
  })
  .strict();
export const NoteEventLinkIdParamsSchema = z.object({ id: z.string().min(1) }).strict();
/** `decline=1`: the undo of an automatic link — remember the event as rejected for this note. */
export const NoteEventUnlinkQuerySchema = z.object({ decline: z.enum(['0', '1']).optional() }).strict();
export const NOTE_EVENT_LINK_SOURCES = ['user', 'auto', 'api'] as const;
export type NoteEventLinkSource = (typeof NOTE_EVENT_LINK_SOURCES)[number];
/** Shape of a note_event row as the sync lane serves it (dates as ISO strings). */
export type NoteEventLink = {
  id: string;
  noteId: string;
  eventKey: string;
  seriesKey: string;
  /** The reader's own event row for this event, or null when they hold no copy of it. */
  eventId: string | null;
  isPrimary: boolean;
  source: NoteEventLinkSource;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  meetingUrl: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export type NoteEventLinkRequest = z.input<typeof NoteEventLinkRequestSchema>;
