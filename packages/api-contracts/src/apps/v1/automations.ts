import { z } from 'zod';
import {
  AppsV1DateTimeResponseSchema,
  AppsV1NoContentResponseSchema,
  appsV1ListResponseSchema,
} from './common.js';

export const AutomationEventTypeSchema = z.enum([
  'note.created',
  'note.added_to_folder',
  'note.tag_added',
  'recording.transcribed',
]);
export type AutomationEventType = z.output<typeof AutomationEventTypeSchema>;

export const AutomationFilterSchema = z
  .object({
    folderIds: z.array(z.string().min(1)).min(1).max(50).optional(),
    tagIds: z.array(z.string().min(1)).min(1).max(50).optional(),
  })
  .strict();

export const AutomationTriggerConfigSchema = z
  .object({
    eventTypes: z.array(AutomationEventTypeSchema).min(1).max(10),
    filter: AutomationFilterSchema.optional(),
  })
  .strict();
export type AutomationTriggerConfig = z.output<typeof AutomationTriggerConfigSchema>;

export const AutomationWebhookActionConfigSchema = z
  .object({ url: z.string().min(1).max(2048) })
  .strict();

export const CreateAutomationRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  triggerType: z.literal('event').optional().default('event'),
  triggerConfig: AutomationTriggerConfigSchema,
  actionType: z.literal('send_webhook'),
  actionConfig: AutomationWebhookActionConfigSchema,
  enabled: z.boolean().optional().default(true),
});
export type CreateAutomationRequest = z.input<typeof CreateAutomationRequestSchema>;

export const UpdateAutomationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    triggerConfig: AutomationTriggerConfigSchema.optional(),
    actionConfig: AutomationWebhookActionConfigSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateAutomationRequest = z.input<typeof UpdateAutomationRequestSchema>;

export const AutomationRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
  before: z
    .string()
    .refine(value => !Number.isNaN(Date.parse(value)), 'must be an ISO timestamp')
    .optional(),
  beforeId: z.string().min(1).optional(),
});

export const AutomationLastRunSchema = z
  .object({
    status: z.string(),
    finishedAt: AppsV1DateTimeResponseSchema.nullable(),
    createdAt: AppsV1DateTimeResponseSchema,
  })
  .strip();

export const AutomationSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    orgUserId: z.string().min(1),
    orgId: z.string().min(1),
    triggerType: z.literal('event'),
    triggerConfig: AutomationTriggerConfigSchema,
    actionType: z.literal('send_webhook'),
    actionConfig: AutomationWebhookActionConfigSchema,
    enabled: z.boolean(),
    lastFiredAt: AppsV1DateTimeResponseSchema.nullable(),
    deletedAt: AppsV1DateTimeResponseSchema.nullable(),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
    lastRun: AutomationLastRunSchema.nullable().optional(),
  })
  .strip();
export type Automation = z.output<typeof AutomationSchema>;

export const CreatedAutomationSchema = AutomationSchema.extend({ secret: z.string().min(1) });
export type CreatedAutomation = z.output<typeof CreatedAutomationSchema>;

export const AutomationErrorSchema = z.object({ code: z.string(), message: z.string() }).strip();

export const AutomationRunSchema = z
  .object({
    id: z.string().min(1),
    automationId: z.string().min(1),
    eventId: z.string().nullable(),
    orgId: z.string().min(1),
    orgUserId: z.string().min(1),
    status: z.enum(['pending', 'running', 'succeeded', 'failed']),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: AppsV1DateTimeResponseSchema,
    startedAt: AppsV1DateTimeResponseSchema.nullable(),
    finishedAt: AppsV1DateTimeResponseSchema.nullable(),
    error: AutomationErrorSchema.nullable(),
    detail: z.record(z.string(), z.unknown()),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
    // NO `deletedAt`: automation runs are not soft-deletable, and this field is
    // not part of their wire representation.
  })
  .strip();
export type AutomationRun = z.output<typeof AutomationRunSchema>;

export const AutomationListResponseSchema = appsV1ListResponseSchema(AutomationSchema);
export const AutomationResponseSchema = AutomationSchema;
export const CreatedAutomationResponseSchema = CreatedAutomationSchema;
export const AutomationRunResponseSchema = AutomationRunSchema;
export const AutomationDeleteResponseSchema = AppsV1NoContentResponseSchema;

export const AutomationRunsResponseSchema = z
  .object({
    results: z.array(AutomationRunSchema),
    hasMore: z.boolean(),
    nextBefore: z.iso.datetime().nullable(),
    nextBeforeId: z.string().nullable(),
  })
  .strip();
export type AutomationRunsResponse = z.output<typeof AutomationRunsResponseSchema>;

export const AutomationSecretSchema = z.object({ secret: z.string().min(1) }).strip();
export const AutomationSecretResponseSchema = AutomationSecretSchema;
