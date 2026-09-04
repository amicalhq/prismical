import { z } from 'zod';
import { AppsV1IsoDateTimeSchema } from './common.js';
import { PlanSummarySchema } from './plan.js';

/** Session bootstrap response for the caller's explicitly selected organization. */
export const MeResponseSchema = z
  .object({
    userId: z.string().min(1),
    orgUserId: z.string().min(1),
    orgId: z.string().min(1),
    role: z.string().min(1),
    revenuecatAppUserId: z.string().min(1),
    plan: PlanSummarySchema,
    usage: z
      .object({
        dictation: z
          .object({
            used: z.number().int().nonnegative(),
            limit: z.number().int().nonnegative().nullable(),
            resetsAt: AppsV1IsoDateTimeSchema.nullable(),
            scope: z.enum(['org', 'member']),
          })
          .strip(),
      })
      .strip()
      .nullable(),
    stats: z
      .object({
        cloud: z
          .object({
            lifetimeWords: z.number().int().nonnegative(),
          })
          .strip(),
      })
      .strip(),
  })
  .strip();

export type MeResponse = z.output<typeof MeResponseSchema>;
