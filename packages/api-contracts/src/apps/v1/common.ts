import { z } from 'zod';
import { ApiErrorResponseSchema } from '../../error.js';

export const AppsV1IsoDateTimeSchema = z.iso.datetime();
/**
 * Response-side timestamp schema. Core database rows contain Date objects, while
 * clients receive ISO strings. The transform lets the same contract serialize
 * server values and validate JSON values without changing the wire format.
 */
export const AppsV1DateTimeResponseSchema = z
  .union([AppsV1IsoDateTimeSchema, z.date()])
  .transform(value => (value instanceof Date ? value.toISOString() : value));
export const AppsV1ErrorResponseSchema = ApiErrorResponseSchema;
export type AppsV1ErrorResponse = z.output<typeof AppsV1ErrorResponseSchema>;

/** Legacy flat errors still emitted by a small number of app-only handlers. */
export const AppsV1LegacyErrorResponseSchema = z
  .object({
    error: z.string(),
    message: z.string().optional(),
    code: z.string().optional(),
    details: z.unknown().optional(),
  })
  .strip();

export const AppsV1RouteErrorResponseSchema = z.union([
  AppsV1ErrorResponseSchema,
  AppsV1LegacyErrorResponseSchema,
]);

export const AppsV1SuccessResponseSchema = z.object({ success: z.literal(true) }).strip();
export type AppsV1SuccessResponse = z.output<typeof AppsV1SuccessResponseSchema>;

export const AppsV1NoContentResponseSchema = z.undefined();

export function appsV1ResultResponseSchema<T extends z.ZodType>(result: T) {
  return z.object({ success: z.literal(true), result }).strip();
}

export function appsV1ListResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ success: z.literal(true), results: z.array(item) }).strip();
}

/** Existing app-client result envelope without a top-level success field. */
export function appsV1ResultEnvelopeSchema<T extends z.ZodType>(result: T) {
  return z.object({ result }).strip();
}

/** Existing app-client list envelope without a top-level success field. */
export function appsV1ResultsEnvelopeSchema<T extends z.ZodType>(item: T) {
  return z.object({ results: z.array(item) }).strip();
}
