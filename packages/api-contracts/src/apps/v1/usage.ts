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
  })
  .strip();

export type Usage = z.output<typeof UsageSchema>;
export const UsageResponseSchema = UsageSchema;
export type UsageResponse = z.output<typeof UsageResponseSchema>;
