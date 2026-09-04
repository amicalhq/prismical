import { z } from 'zod';
import { AppsV1SuccessResponseSchema, appsV1ResultResponseSchema } from './common.js';

export const ModelDefaultUseCaseSchema = z.enum(['formatting', 'transcription']);
export type ModelDefaultUseCase = z.output<typeof ModelDefaultUseCaseSchema>;

export const ModelDefaultSelectionSchema = z
  .object({ instanceId: z.string().nullable(), modelId: z.string().nullable() })
  .strip();
export type ModelDefaultSelection = z.output<typeof ModelDefaultSelectionSchema>;

export const ModelDefaultsSchema = z
  .object({
    formatting: ModelDefaultSelectionSchema.nullable(),
    transcription: ModelDefaultSelectionSchema.nullable(),
  })
  .strip();
export type ModelDefaults = z.output<typeof ModelDefaultsSchema>;

export const ModelDefaultsResponseSchema = appsV1ResultResponseSchema(ModelDefaultsSchema);

export const SetModelDefaultRequestSchema = z.object({
  useCase: ModelDefaultUseCaseSchema,
  instanceId: z.string().min(1).max(64).optional(),
  modelId: z.string().min(1).max(128).optional(),
});
export type SetModelDefaultRequest = z.input<typeof SetModelDefaultRequestSchema>;

export const SetModelDefaultResultSchema = ModelDefaultSelectionSchema.extend({
  useCase: ModelDefaultUseCaseSchema,
});
export const SetModelDefaultResponseSchema = appsV1ResultResponseSchema(
  SetModelDefaultResultSchema
);

export const ModelDefaultQuerySchema = z.object({ useCase: ModelDefaultUseCaseSchema });
export const ClearModelDefaultResponseSchema = AppsV1SuccessResponseSchema;
