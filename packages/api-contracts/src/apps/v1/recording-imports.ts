import { z } from 'zod';

export const CreateRecordingImportSchema = z.object({
  noteId: z.string().min(1),
  expectedOrgUserId: z.string().min(1),
  requestKey: z.string().uuid(),
  fileName: z.string().min(1).max(240),
  sizeBytes: z.number().int().positive().max(250_000_000),
  language: z.string().min(2).max(20).default('multi'),
  instanceId: z.string().optional(),
  modelId: z.string().optional(),
});
export const RestartRecordingImportSchema = CreateRecordingImportSchema.pick({
  fileName: true,
  sizeBytes: true,
});
export const RecordingImportParamsSchema = z.object({ recordingId: z.string().min(1) });
export const RecordingImportAttemptSchema = z.object({ uploadAttempt: z.string().uuid() });
export const RecordingImportResponseSchema = z.object({
  recordingId: z.string(),
  requestKey: z.string().uuid().nullable().optional(),
  noteId: z.string(),
  status: z.enum(['uploading', 'pending', 'running', 'done', 'failed', 'cancelled']),
  phase: z.enum(['uploading', 'checking', 'transcribing', 'ready', 'failed', 'cancelled']),
  fileName: z.string(),
  uploadAttempt: z.string(),
  uploadUrl: z.string().optional(),
  error: z.string().nullable(),
  durationMs: z.number().nullable(),
  maxDurationMs: z.number(),
});
export type RecordingImportResponse = z.infer<typeof RecordingImportResponseSchema>;
export type CreateRecordingImport = z.infer<typeof CreateRecordingImportSchema>;
