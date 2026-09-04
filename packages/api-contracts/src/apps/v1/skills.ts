import { z } from 'zod';
import { appsV1ResultResponseSchema } from './common.js';

export const ArtifactModeSchema = z.enum(['append-section', 'replace-doc', 'inline-rewrite']);
export type ArtifactMode = z.output<typeof ArtifactModeSchema>;

export const RunSkillParamsSchema = z.object({ skillId: z.string().min(1) });
export const RunSkillRequestSchema = z.object({
  noteId: z.string().min(1),
  recordingId: z.string().min(1).max(64).optional(),
  noteMarkdown: z.string().max(1_000_000).optional(),
  mode: ArtifactModeSchema.optional(),
  refineInstruction: z.string().min(1).max(2_000).optional(),
  previousOutput: z.string().max(50_000).optional(),
  selectionText: z.string().max(50_000).optional(),
  instanceId: z.string().min(1).max(64).optional(),
  modelId: z.string().min(1).max(128).optional(),
});
export type RunSkillRequest = z.input<typeof RunSkillRequestSchema>;

export const RunUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    raw: z.string().optional(),
  })
  .strip();
export type RunUsage = z.output<typeof RunUsageSchema>;

export const RunSkillResultSchema = z
  .object({
    outputTarget: z.enum(['note-body', 'note-title']).optional(),
    titleRunId: z.string().optional(),
    title: z.string().optional(),
    mode: ArtifactModeSchema,
    skillId: z.string().min(1),
    skillName: z.string(),
    modelId: z.string(),
    rawMarkdown: z.string(),
    reasoning: z.string().nullable(),
    usage: RunUsageSchema.optional(),
    recordingId: z.string().optional(),
  })
  .strip();
export type RunSkillResult = z.output<typeof RunSkillResultSchema>;
export const RunSkillResponseSchema = appsV1ResultResponseSchema(RunSkillResultSchema);

export const AcceptSkillRunRequestSchema = z.object({
  noteId: z.string().min(1),
  skillId: z.string().min(1),
  recordingId: z.string().min(1).max(64).nullish(),
  mode: ArtifactModeSchema,
  content: z.string().min(1),
  rawMarkdown: z.string().min(1),
  prevContent: z.string().max(2_000_000).optional(),
  modelId: z.string().min(1).optional(),
  reasoning: z.string().nullable().optional(),
  refineInstruction: z.string().nullable().optional(),
  selectionText: z.string().nullable().optional(),
  usage: RunUsageSchema.optional(),
  costUsd: z.number().nullable().optional(),
});
export type AcceptSkillRunRequest = z.input<typeof AcceptSkillRunRequestSchema>;

export const AcceptSkillRunResultSchema = z
  .object({
    artifactId: z.string().min(1),
    version: z.number().int().positive(),
    generatedAt: z.iso.datetime(),
  })
  .strip();
export type AcceptSkillRunResult = z.output<typeof AcceptSkillRunResultSchema>;
export const AcceptSkillRunResponseSchema = appsV1ResultResponseSchema(AcceptSkillRunResultSchema);

export const RestoreSkillRunRequestSchema = z.object({ noteId: z.string().min(1) });
export type RestoreSkillRunRequest = z.input<typeof RestoreSkillRunRequestSchema>;
export const RestoreSkillRunResultSchema = z
  .object({
    restored: z.boolean(),
    artifactId: z.string().optional(),
    prevContent: z.string().optional(),
  })
  .strip();
export type RestoreSkillRunResult = z.output<typeof RestoreSkillRunResultSchema>;
export const RestoreSkillRunResponseSchema = appsV1ResultResponseSchema(
  RestoreSkillRunResultSchema
);

export const EnhancedRecordingsQuerySchema = z.object({ noteId: z.string().min(1) });
export const EnhancedRecordingsResultSchema = z
  .object({ recordingIds: z.array(z.string()) })
  .strip();
export const EnhancedRecordingsResponseSchema = appsV1ResultResponseSchema(
  EnhancedRecordingsResultSchema
);

export const ApplyTitleRunRequestSchema = z.object({ runId: z.string().min(1) });
export const TitleRunResultSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  titleSource: z.string(),
  titleRevision: z.number().int(),
});
export const TitleRunResponseSchema = appsV1ResultResponseSchema(TitleRunResultSchema);
export type TitleRunResult = z.output<typeof TitleRunResultSchema>;
