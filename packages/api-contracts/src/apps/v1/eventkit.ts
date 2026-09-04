import { z } from 'zod';
import { appsV1ResultResponseSchema } from './common.js';

export const EVENTKIT_MAX_CALENDARS = 100;
export const EVENTKIT_MAX_EVENTS_PER_CHUNK = 200;
export const EVENTKIT_MAX_CHUNKS = 500;
export const EVENTKIT_MAX_EVENTS = 50_000;

export const EventKitDateTimeSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(value => Number.isFinite(new Date(value).getTime()), 'Must be an ISO date-time');

export const EventKitDeviceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const EventKitDeviceParamsSchema = z.object({ deviceId: EventKitDeviceIdSchema });

export const EventKitCalendarInputSchema = z.object({
  externalId: z.string().min(1).max(512),
  title: z.string().trim().min(1).max(256),
  color: z.string().max(32).nullable().optional(),
  sourceTitle: z.string().trim().max(256).nullable().optional(),
  sourceType: z.string().trim().max(64).nullable().optional(),
  allowsContentModifications: z.boolean().optional(),
  primary: z.boolean().optional(),
});

export const EventKitPartySchema = z.object({
  name: z.string().max(256).nullable().optional(),
  email: z.email().max(320).nullable().optional(),
  isCurrentUser: z.boolean().optional(),
  status: z.string().max(32).nullable().optional(),
});

export const EventKitEventInputSchema = z
  .object({
    calendarExternalId: z.string().min(1).max(512),
    sourceEventId: z.string().min(1).max(512),
    icalUid: z.string().min(1).max(512).nullable().optional(),
    recurrenceId: z
      .string()
      .max(80)
      .regex(/^(single|date:\d{4}-\d{2}-\d{2}|time:\d{1,17})$/),
    title: z.string().max(512),
    description: z.string().max(20_000).nullable().optional(),
    startsAt: EventKitDateTimeSchema,
    endsAt: EventKitDateTimeSchema,
    isAllDay: z.boolean(),
    status: z.enum(['confirmed', 'tentative']),
    meetingUrl: z.url().max(2_048).nullable().optional(),
    location: z.string().max(1_024).nullable().optional(),
    organizer: EventKitPartySchema.nullable().optional(),
    attendees: z.array(EventKitPartySchema).max(100).nullable().optional(),
    sourceUpdatedAt: EventKitDateTimeSchema.nullable().optional(),
  })
  .refine(value => new Date(value.endsAt).getTime() >= new Date(value.startsAt).getTime(), {
    message: 'endsAt must not be before startsAt',
  });

export const EventKitIntegrationSchema = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  deviceCount: z.number().int().nonnegative(),
});
export type EventKitIntegration = z.output<typeof EventKitIntegrationSchema>;
export const EventKitIntegrationResponseSchema =
  appsV1ResultResponseSchema(EventKitIntegrationSchema);
export const EnableEventKitRequestSchema = z.object({});

export const DisconnectEventKitResponseSchema = appsV1ResultResponseSchema(
  z.object({ disconnectedDevices: z.number().int().nonnegative() })
);

export const EventKitCapabilityResponseSchema = z
  .object({
    success: z.literal(true),
    available: z.boolean(),
    enabled: z.boolean(),
  })
  .strip();

export const RegisterEventKitDeviceRequestSchema = z.object({
  deviceName: z.string().trim().min(1).max(128),
  calendars: z.array(EventKitCalendarInputSchema).max(EVENTKIT_MAX_CALENDARS),
});
export const RegisterEventKitDeviceResponseSchema = appsV1ResultResponseSchema(
  z.object({
    connectionId: z.string(),
    calendars: z.array(
      z.object({
        id: z.string(),
        externalId: z.string(),
        enabled: z.boolean(),
      })
    ),
  })
);

export const EventKitDeviceConfigResponseSchema = appsV1ResultResponseSchema(
  z.object({
    connectionId: z.string(),
    enabledCalendarExternalIds: z.array(z.string()),
    lastSequence: z.number().int().nonnegative(),
    windowBackDays: z.number().int().nonnegative(),
    windowForwardDays: z.number().int().nonnegative(),
  })
);

export const BeginEventKitSnapshotRequestSchema = z.object({
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  capturedAt: EventKitDateTimeSchema,
  windowStart: EventKitDateTimeSchema,
  windowEnd: EventKitDateTimeSchema,
  expectedChunks: z.number().int().min(1).max(EVENTKIT_MAX_CHUNKS),
  expectedEvents: z.number().int().min(0).max(EVENTKIT_MAX_EVENTS),
});
export const BeginEventKitSnapshotResponseSchema = appsV1ResultResponseSchema(
  z.object({
    snapshotId: z.string(),
    status: z.string(),
  })
);

export const EventKitSnapshotChunkParamsSchema = z.object({
  snapshotId: z.string().min(1).max(128),
  chunkIndex: z.coerce
    .number()
    .int()
    .min(0)
    .max(EVENTKIT_MAX_CHUNKS - 1),
});
export const PutEventKitSnapshotChunkRequestSchema = z.object({
  events: z.array(EventKitEventInputSchema).max(EVENTKIT_MAX_EVENTS_PER_CHUNK),
});
export const PutEventKitSnapshotChunkResponseSchema = appsV1ResultResponseSchema(
  z.object({ checksum: z.string(), accepted: z.boolean() })
);

export const EventKitSnapshotParamsSchema = z.object({
  snapshotId: z.string().min(1).max(128),
});
export const CommitEventKitSnapshotResponseSchema = appsV1ResultResponseSchema(
  z.object({
    committed: z.boolean(),
    eventCount: z.number().int().nonnegative(),
  })
);
