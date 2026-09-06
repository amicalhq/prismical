import { z } from 'zod';
import { AppsV1IsoDateTimeSchema } from './common.js';

export const BillingIntervalSchema = z.enum(['month', 'year']);
export type BillingInterval = z.output<typeof BillingIntervalSchema>;

export const AiModelTierSchema = z.enum(['standard', 'pro']);
export type AiModelTier = z.output<typeof AiModelTierSchema>;

/** Raw `plan.inclusions` JSONB. Every key optional: a database may lag a deploy. */
export const PlanInclusionsSchema = z
  .object({
    dictation_words: z.number().int().nonnegative().nullable().optional(),
    cloud_transcription_seconds: z.number().int().nonnegative().nullable().optional(),
    refresh: z.enum(['daily', 'weekly', 'monthly', 'never']).optional(),
    scope: z.enum(['org', 'user']).optional(),
    team_members: z.number().int().nonnegative().nullable().optional(),
    ai_credits: z.number().int().nonnegative().nullable().optional(),
    ai_model_tier: AiModelTierSchema.optional(),
    max_recording_seconds: z.number().int().positive().nullable().optional(),
    features: z
      .object({
        ask_ai: z.boolean().optional(),
        floating_mode: z.boolean().optional(),
        byok: z.boolean().optional(),
        automations: z.boolean().optional(),
        extended_recording: z.boolean().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());

export type PlanInclusions = z.output<typeof PlanInclusionsSchema>;

/**
 * The RESOLVED entitlements for an organization — what the plan grants after core has applied
 * its missing-key posture (see `usage/entitlements.ts`). Clients gate surfaces on `features`,
 * show `limits`, and never read the raw inclusions. `null` on a limit means unlimited.
 */
export const PlanEntitlementFeaturesSchema = z
  .object({
    askAi: z.boolean(),
    floatingMode: z.boolean(),
    byok: z.boolean(),
    automations: z.boolean(),
    extendedRecording: z.boolean(),
  })
  .strip();
export type PlanEntitlementFeatures = z.output<typeof PlanEntitlementFeaturesSchema>;

export const PlanEntitlementsSchema = z
  .object({
    planExternalId: z.string().nullable(),
    features: PlanEntitlementFeaturesSchema,
    aiModelTier: AiModelTierSchema,
    limits: z
      .object({
        seats: z.number().int().nonnegative().nullable(),
        cloudTranscriptionSeconds: z.number().int().nonnegative().nullable(),
        aiCredits: z.number().int().nonnegative().nullable(),
        maxRecordingSeconds: z.number().int().positive().nullable(),
      })
      .strip(),
    /** true = transcription seconds and credits are pooled across the org, not per member. */
    pooled: z.boolean(),
  })
  .strip();
export type PlanEntitlements = z.output<typeof PlanEntitlementsSchema>;

/**
 * Plan-gate error codes on JSON endpoints (`402`). Ask AI streams its own codes (see
 * `AI_ERROR_CODES.ASK_NOT_IN_PLAN` / `AI_CREDITS_EXHAUSTED`); these are the non-AI surfaces.
 */
export const PLAN_LIMIT_ERROR_CODES = {
  /** Invite create/accept: the plan's seat count is used up. */
  SEAT_LIMIT_REACHED: 'SEAT_LIMIT_REACHED',
  /** Automations are not included in the plan. */
  AUTOMATIONS_NOT_IN_PLAN: 'AUTOMATIONS_NOT_IN_PLAN',
  /** BYOK instance creation: bring-your-own-key is not included in the plan. */
  BYOK_NOT_IN_PLAN: 'BYOK_NOT_IN_PLAN',
  /** Skill run: this period's AI credits are used up (Ask streams the same code). */
  AI_CREDITS_EXHAUSTED: 'AI_CREDITS_EXHAUSTED',
} as const;
export type PlanLimitErrorCode = (typeof PLAN_LIMIT_ERROR_CODES)[keyof typeof PLAN_LIMIT_ERROR_CODES];

/** One metered dimension: what has been used this period against the plan's limit. */
export const PlanMeterSchema = z
  .object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative().nullable(),
  })
  .strip();
export type PlanMeter = z.output<typeof PlanMeterSchema>;

const PlanCatalogLimitSchema = z
  .object({
    value: z.string(),
    label: z.string(),
    tooltip: z.string().optional(),
  })
  .strip();

const PlanCatalogFeatureSchema = z
  .object({
    text: z.string(),
    note: z.string().optional(),
    tooltip: z.string().optional(),
  })
  .strip();

export const PlanCatalogEntrySchema = z
  .object({
    externalId: z.string().min(1),
    displayName: z.string(),
    description: z.string(),
    price: z.string(),
    billingLabel: z.string(),
    perUser: z.boolean(),
    badge: z.string().optional(),
    checkoutEligible: z.boolean(),
    checkoutOptions: z
      .array(
        z
          .object({
            interval: BillingIntervalSchema,
            label: z.string(),
            price: z.string(),
            billingLabel: z.string(),
            badge: z.string().optional(),
          })
          .strip()
      )
      .optional(),
    contactSales: z.boolean(),
    ctaLabel: z.string(),
    checkoutPlanExternalId: z.string().optional(),
    contactHref: z.string().optional(),
    sortOrder: z.number().int(),
    limits: z.array(PlanCatalogLimitSchema),
    inherits: z.string().optional(),
    features: z.array(PlanCatalogFeatureSchema),
    inclusions: PlanInclusionsSchema.optional(),
  })
  .strip();

export type PlanCatalogEntry = z.output<typeof PlanCatalogEntrySchema>;

export const SubscriptionStatusSchema = z.enum(['none', 'trialing', 'active']);
export type SubscriptionStatus = z.output<typeof SubscriptionStatusSchema>;

export const PlanSummarySchema = z
  .object({
    isFreeTier: z.boolean(),
    displayName: z.string().min(1),
    externalId: z.string().nullable(),
    status: SubscriptionStatusSchema,
    source: z.string().nullable(),
    trialEndsAt: AppsV1IsoDateTimeSchema.nullable(),
  })
  .strip();
export type PlanSummary = z.output<typeof PlanSummarySchema>;

export const PlanDetailsSchema = PlanSummarySchema.extend({
  id: z.string().min(1),
  externalId: z.string().min(1),
  status: z.enum(['trialing', 'active']),
  source: z.string().min(1),
  inclusions: PlanInclusionsSchema,
}).strip();
export type PlanDetails = z.output<typeof PlanDetailsSchema>;

export const PlanAccessSchema = z
  .object({
    organization: z
      .object({
        id: z.string().min(1),
        orgUserId: z.string().min(1),
        role: z.string().min(1),
      })
      .strip(),
    plan: PlanDetailsSchema,
    subscription: z
      .object({
        id: z.string().min(1),
        subId: z.string().min(1),
        state: z.string().min(1),
        mode: z.string().min(1),
        recurrent: z.boolean(),
        vendor: z.string().min(1),
        biller: z.string().min(1),
        trialEndsAt: AppsV1IsoDateTimeSchema.nullable(),
        currentPeriodStart: AppsV1IsoDateTimeSchema.nullable(),
        currentPeriodEnd: AppsV1IsoDateTimeSchema.nullable(),
      })
      .strip(),
    usage: z
      .object({
        wordsUsed: z.number().int().nonnegative(),
        wordsLimit: z.number().int().nonnegative().nullable(),
        seatsUsed: z.number().int().nonnegative(),
        seatsLimit: z.number().int().nonnegative().nullable(),
        quotaSharing: z.enum(['organization', 'per_user']),
        periodStart: AppsV1IsoDateTimeSchema.nullable(),
        periodEnd: AppsV1IsoDateTimeSchema.nullable(),
        /** Cloud transcription this period (member, or the whole org when `entitlements.pooled`). */
        cloudTranscriptionSeconds: PlanMeterSchema.optional(),
        /** AI credits this period (same scope rule). */
        aiCredits: PlanMeterSchema.optional(),
        /** When the transcription / credit meters reset. */
        meterResetsAt: AppsV1IsoDateTimeSchema.nullable().optional(),
      })
      .strip(),
    /** Optional only so a client can parse a core that predates entitlements. */
    entitlements: PlanEntitlementsSchema.optional(),
    plans: z.array(PlanCatalogEntrySchema),
  })
  .strip();

export type PlanAccess = z.output<typeof PlanAccessSchema>;

export const PlanAccessResponseSchema = PlanAccessSchema;
export type PlanAccessResponse = z.output<typeof PlanAccessResponseSchema>;

export const PlanCheckoutRequestSchema = z
  .object({
    planExternalId: z.string().min(1),
    billingInterval: BillingIntervalSchema.optional().default('month'),
  })
  .strict();
export type PlanCheckoutRequest = z.input<typeof PlanCheckoutRequestSchema>;
export type ParsedPlanCheckoutRequest = z.output<typeof PlanCheckoutRequestSchema>;

export const PlanCheckoutSchema = z.object({ checkoutUrl: z.url() }).strip();
export type PlanCheckout = z.output<typeof PlanCheckoutSchema>;
export const PlanCheckoutResponseSchema = PlanCheckoutSchema;
export type PlanCheckoutResponse = z.output<typeof PlanCheckoutResponseSchema>;

export const PlanPortalSchema = z.object({ portalUrl: z.url() }).strip();
export type PlanPortal = z.output<typeof PlanPortalSchema>;
export const PlanPortalResponseSchema = PlanPortalSchema;
export type PlanPortalResponse = z.output<typeof PlanPortalResponseSchema>;
