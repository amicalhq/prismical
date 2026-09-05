import { z } from 'zod';
import { AppsV1DateTimeResponseSchema, appsV1ListResponseSchema } from './common.js';

const DAY_SECONDS = 24 * 60 * 60;

export const ApiKeyIdParamsSchema = z.object({ id: z.string().min(1) });

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(32),
  expiresIn: z
    .number()
    .int()
    .min(DAY_SECONDS)
    .max(365 * DAY_SECONDS)
    .optional(),
});
export type CreateApiKeyRequest = z.input<typeof CreateApiKeyRequestSchema>;

export const ApiKeySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    start: z.string().nullable(),
    prefix: z.string().nullable(),
    enabled: z.boolean(),
    lastRequest: AppsV1DateTimeResponseSchema.nullable(),
    expiresAt: AppsV1DateTimeResponseSchema.nullable(),
    createdAt: AppsV1DateTimeResponseSchema,
  })
  .strip();
export type ApiKey = z.output<typeof ApiKeySchema>;

export const ApiKeyListResponseSchema = appsV1ListResponseSchema(ApiKeySchema);

export const CreatedApiKeySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    start: z.string().nullable(),
    key: z.string().min(1),
    createdAt: AppsV1DateTimeResponseSchema,
    expiresAt: AppsV1DateTimeResponseSchema.nullable(),
  })
  .strip();
export type CreatedApiKey = z.output<typeof CreatedApiKeySchema>;
