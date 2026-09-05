import { z } from 'zod';
import { AppsV1IsoDateTimeSchema } from './common.js';

export const BillingIntervalSchema = z.enum(['month', 'year']);
export type BillingInterval = z.output<typeof BillingIntervalSchema>;

export const PlanInclusionsSchema = z
  .object({
    dictation_words: z.number().int().nonnegative().nullable().optional(),
    cloud_transcription_seconds: z.number().int().nonnegative().nullable().optional(),
    refresh: z.enum(['daily', 'weekly', 'monthly', 'never']).optional(),
    scope: z.enum(['org', 'user']).optional(),
    team_members: z.number().int().nonnegative().nullable().optional(),
  })
  .catchall(z.unknown());

export type PlanInclusions = z.output<typeof PlanInclusionsSchema>;

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
      })
      .strip(),
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
