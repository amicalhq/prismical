import { z } from 'zod';

export const AppsV1IsoDateTimeSchema = z.iso.datetime();
/**
 * Response-side timestamp schema. Core database rows contain Date objects, while
 * clients receive ISO strings. The transform lets the same contract serialize
 * server values and validate JSON values without changing the wire format.
 */
export const AppsV1DateTimeResponseSchema = z
  .union([AppsV1IsoDateTimeSchema, z.date()])
  .transform(value => (value instanceof Date ? value.toISOString() : value));
/** Nested HTTP errors with correlation fields and domain-specific context. */
export const AppsV1ErrorDetailsSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  /** AI failures use AiErrorDetailsSchema; validation failures carry field issues. */
  details: z.unknown().optional(),
  traceId: z.string().optional(),
  requestId: z.string().optional(),
  localizedMessage: z.object({ locale: z.string(), message: z.string() }).strip().optional(),
}).strip();
export const AppsV1ErrorResponseSchema = z.object({ error: AppsV1ErrorDetailsSchema }).strip();
export type AppsV1ErrorResponse = z.output<typeof AppsV1ErrorResponseSchema>;
export const AppsV1RouteErrorResponseSchema = AppsV1ErrorResponseSchema;

/** An acknowledgement with no representation uses HTTP 204. */
export const AppsV1NoContentResponseSchema = z.undefined();

/** Lists use results; single resources and composite responses expose their fields directly. */
export function appsV1ListResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ results: z.array(item) }).strip();
}
