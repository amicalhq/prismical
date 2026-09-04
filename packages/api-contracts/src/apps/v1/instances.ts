import { z } from 'zod';

export const InstanceIdParamsSchema = z.object({
  id: z.string().min(1).describe('Provider instance id.'),
});

export const InstanceCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    type: z.enum(['language', 'transcription', 'embedding']),
    context: z.number().int().positive().optional(),
    description: z.string().optional(),
    pricing: z
      .object({ input: z.number().nonnegative(), output: z.number().nonnegative() })
      .strip()
      .optional(),
    releaseDate: z.iso.date().optional(),
  })
  .strip();
export type InstanceCatalogEntry = z.output<typeof InstanceCatalogEntrySchema>;

export const InstanceModelsResponseSchema = z
  .object({ success: z.literal(true), models: z.array(InstanceCatalogEntrySchema) })
  .strip();

export const InstanceModelsLegacyErrorSchema = z
  .object({ error: z.string(), code: z.string() })
  .strip();

export const InstanceSecretResponseSchema = z
  .object({
    success: z.literal(true),
    instanceId: z.string().min(1),
    keyVersion: z.number().int().nonnegative(),
    ttlSeconds: z.number().int().positive(),
    credentials: z.record(z.string(), z.unknown()),
  })
  .strip();
export type InstanceSecretResponse = z.output<typeof InstanceSecretResponseSchema>;
