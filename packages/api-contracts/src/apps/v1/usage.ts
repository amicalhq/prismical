import { z } from 'zod';
import { AppsV1IsoDateTimeSchema } from './common.js';

const AiTokenCountSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  })
  .strip();

export const AiTokensBreakdownSchema = z
  .object({
    cloud: z.record(z.string(), AiTokenCountSchema).optional(),
    byok: z.record(z.string(), AiTokenCountSchema).optional(),
  })
  .strip();

/**
 * A piece of display copy the server resolved. `kind` is the stable identifier a client maps to
 * its own locale catalog; `text` is an optional server override that WINS when present, so copy
 * can be changed (or a brand-new variant shipped) without a client release. An override is in
 * whatever language the server sent it in, so default responses carry `kind` alone.
 */
export const UsageCopySchema = z
  .object({
    kind: z.string().min(1),
    text: z.string().min(1).optional(),
  })
  .strip();
export type UsageCopy = z.output<typeof UsageCopySchema>;

export const UsageActionSchema = UsageCopySchema.extend({
  /** Where the call to action goes. Opaque to the client - never re-derived from the plan. */
  href: z.string().min(1),
  /** True for an off-app destination the client should open in the system browser. */
  external: z.boolean(),
}).strip();
export type UsageAction = z.output<typeof UsageActionSchema>;

/**
 * Everything the Cloud-transcription meter renders. Which plans get a call to action, and where
 * it points, is decided HERE and never in the client: the desktop app is open source and must
 * carry no plan, tier, or vendor knowledge.
 */
export const CloudTranscriptionQuotaSchema = z
  .object({
    usedSeconds: z.number().int().nonnegative(),
    /** null = unlimited; the client renders nothing at all. */
    limitSeconds: z.number().int().nonnegative().nullable(),
    resetsAt: AppsV1IsoDateTimeSchema,
    label: UsageCopySchema,
    /** Whole-row target, or null when this member cannot open billing. */
    href: z.string().min(1).nullable(),
    /** null = nothing to upgrade to, or this member cannot act on billing. */
    action: UsageActionSchema.nullable(),
  })
  .strip();
export type CloudTranscriptionQuota = z.output<typeof CloudTranscriptionQuotaSchema>;

export const UsageQuotaSchema = z
  .object({
    cloudTranscription: CloudTranscriptionQuotaSchema,
  })
  .strip();
export type UsageQuota = z.output<typeof UsageQuotaSchema>;

export const UsageSchema = z
  .object({
    period: z
      .object({
        start: AppsV1IsoDateTimeSchema,
        end: AppsV1IsoDateTimeSchema,
      })
      .strip(),
    usage: z
      .object({
        notesCreated: z.number().int().nonnegative(),
        skillRuns: z.number().int().nonnegative(),
        askMessages: z.number().int().nonnegative(),
        apiMutations: z.number().int().nonnegative(),
        transcriptionSecondsCloud: z.number().int().nonnegative(),
        transcriptionSecondsByok: z.number().int().nonnegative(),
        cloudInputTokens: z.number().int().nonnegative(),
        cloudOutputTokens: z.number().int().nonnegative(),
        aiTokens: AiTokensBreakdownSchema,
      })
      .strip(),
    limits: z
      .object({
        cloudTranscriptionSeconds: z.number().int().nonnegative().nullable(),
      })
      .strip(),
    /**
     * The Cloud-transcription meter, fully resolved server-side. Optional so a client
     * newer than its core still parses: absent means "this core does not report the meter", and
     * the surface hides rather than guessing.
     */
    quota: UsageQuotaSchema.optional(),
  })
  .strip();

export type Usage = z.output<typeof UsageSchema>;
export const UsageResponseSchema = UsageSchema;
export type UsageResponse = z.output<typeof UsageResponseSchema>;
