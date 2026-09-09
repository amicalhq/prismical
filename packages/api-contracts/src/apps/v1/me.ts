import { CtaSchema } from './cta.js';
import { z } from 'zod';
import { AppsV1IsoDateTimeSchema } from './common.js';
import { PlanEntitlementsSchema, PlanSummarySchema } from './plan.js';

const MeMeterSchema = z
  .object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative().nullable(),
    resetsAt: AppsV1IsoDateTimeSchema.nullable(),
    scope: z.enum(['org', 'member']),
  })
  .strip();

/** Session bootstrap response for the caller's explicitly selected organization. */
export const MeResponseSchema = z
  .object({
    cta: CtaSchema.nullable().optional(),
    userId: z.string().min(1),
    orgUserId: z.string().min(1),
    orgId: z.string().min(1),
    role: z.string().min(1),
    revenuecatAppUserId: z.string().min(1),
    plan: PlanSummarySchema,
    /** What the plan grants, resolved. Optional only so older cores still parse. */
    entitlements: PlanEntitlementsSchema.optional(),
    usage: z
      .object({
        /** Cloud transcription seconds this period (legacy name, kept for older clients). */
        dictation: MeMeterSchema,
        /** AI credits this period; absent on a core that predates credits. */
        aiCredits: MeMeterSchema.optional(),
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
