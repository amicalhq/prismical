import { z } from 'zod';
import {
  AppsV1DateTimeResponseSchema,
  AppsV1SuccessResponseSchema,
  appsV1ListResponseSchema,
} from './common.js';

export const ConnectionProviderSchema = z.enum(['google']);
export const ConnectionProviderParamsSchema = z.object({
  provider: ConnectionProviderSchema,
});

export const AuthorizeConnectionRequestSchema = z.object({
  returnTo: z.url(),
});
export const AuthorizeConnectionResponseSchema = z
  .object({
    success: z.literal(true),
    url: z.url(),
  })
  .strip();

export const ConnectionCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
});

/** This operation redirects or returns HTML; it does not have a JSON response. */
export const CONNECTION_CALLBACK_OPERATION_ID = 'connectionCallback';
export const CONNECTION_CALLBACK_MEDIA_TYPES = ['text/html', 'text/plain'] as const;

export const ConnectionSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    syncMode: z.enum(['pull', 'device_push']),
    deviceId: z.string().nullable(),
    deviceName: z.string().nullable(),
    status: z.string(),
    statusReason: z.string().nullable(),
    accountEmail: z.string().nullable(),
    lastSyncedAt: AppsV1DateTimeResponseSchema.nullable(),
  })
  .strip();
export type Connection = z.output<typeof ConnectionSchema>;

export const ConnectionListResponseSchema = appsV1ListResponseSchema(ConnectionSchema);
export const ConnectionIdParamsSchema = z.object({ id: z.string().min(1) });
export const DeleteConnectionResponseSchema = AppsV1SuccessResponseSchema;
export const SyncConnectionResponseSchema = AppsV1SuccessResponseSchema;

export const CalendarIdParamsSchema = z.object({ id: z.string().min(1) });
export const UpdateCalendarRequestSchema = z.object({ enabled: z.boolean() });
export const UpdateCalendarResponseSchema = AppsV1SuccessResponseSchema;
