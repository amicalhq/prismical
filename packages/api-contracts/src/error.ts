import { z } from 'zod';

/** Shared nested error envelope used by Prismical HTTP APIs. */
export const ApiErrorDetailsSchema = z
  .object({
    id: z.string().optional(),
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .strip();

export type ApiErrorDetails = z.output<typeof ApiErrorDetailsSchema>;

export const ApiErrorResponseSchema = z
  .object({
    error: ApiErrorDetailsSchema,
  })
  .strip();

export type ApiErrorResponse = z.output<typeof ApiErrorResponseSchema>;
