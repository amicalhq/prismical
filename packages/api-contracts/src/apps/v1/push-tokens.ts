import { z } from 'zod';
import { AppsV1DateTimeResponseSchema, AppsV1NoContentResponseSchema } from './common.js';

const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[^\s[\]]+\]$/;

export const ExpoPushTokenSchema = z
  .string()
  .trim()
  .regex(EXPO_PUSH_TOKEN_RE, 'Must be an Expo push token, e.g. ExponentPushToken[...]');

export const RegisterPushTokenRequestSchema = z.object({
  token: ExpoPushTokenSchema.describe('Expo push token from getExpoPushTokenAsync()'),
  platform: z.enum(['ios', 'android']).describe('Device platform'),
  deviceId: z.string().min(1).max(256).optional().describe('Stable per-install device id'),
  appVersion: z.string().min(1).max(64).optional().describe('Client app version'),
});
export type RegisterPushTokenRequest = z.input<typeof RegisterPushTokenRequestSchema>;

export const PushTokenParamsSchema = z.object({ token: z.string().min(1) });

export const PushTokenSchema = z
  .object({
    id: z.string().min(1),
    token: z.string().min(1),
    platform: z.enum(['ios', 'android']),
    deviceId: z.string().nullable(),
    appVersion: z.string().nullable(),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
    lastSeenAt: AppsV1DateTimeResponseSchema,
  })
  .strip();
export type PushToken = z.output<typeof PushTokenSchema>;
export const RegisterPushTokenResponseSchema = PushTokenSchema;
export const DeletePushTokenResponseSchema = AppsV1NoContentResponseSchema;
