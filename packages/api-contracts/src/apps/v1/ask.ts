import { z } from 'zod';
import { appsV1ResultResponseSchema } from './common.js';

export const AskMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(50_000),
  parts: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
});

export const AskScopeSchema = z.object({
  noteIds: z.array(z.string().min(1)).max(20).optional(),
  folderIds: z.array(z.string().min(1)).max(20).optional(),
  tagIds: z.array(z.string().min(1)).max(20).optional(),
});

export const AskRequestSchema = z.object({
  messages: z.array(AskMessageSchema).min(1).max(50),
  scope: AskScopeSchema.optional(),
  conversationId: z.string().min(1).max(64).optional(),
  instanceId: z.string().min(1).max(64).optional(),
  modelId: z.string().min(1).max(128).optional(),
  // Opt-in: the model appends a `Follow-ups: q1 | q2` line above `Sources:` for the
  // client to render as suggestion chips. Off by default so /v1 API consumers and older clients
  // never see the extra line.
  suggestFollowups: z.boolean().optional(),
});
export type AskRequest = z.input<typeof AskRequestSchema>;

export const AskStoredMessageSchema = z
  .object({ role: z.enum(['user', 'assistant']), content: z.string() })
  .strip();
export type AskStoredMessage = z.output<typeof AskStoredMessageSchema>;

export const StoredConversationSchema = z
  .object({ id: z.string().min(1), messages: z.array(AskStoredMessageSchema) })
  .strip();
export type StoredConversation = z.output<typeof StoredConversationSchema>;

export const AskConversationResponseSchema = appsV1ResultResponseSchema(
  StoredConversationSchema.nullable()
);

/** POST /me/ask uses the AI SDK UI-message SSE protocol, not a JSON body. */
export const ASK_STREAM_MEDIA_TYPE = 'text/event-stream' as const;
