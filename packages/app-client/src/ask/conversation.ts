import { createId } from '@prismical/id';
import type { UIMessage } from 'ai';
import { AskScopeSchema } from '@prismical/api-contracts/apps/v1';
import type { AskScope } from './scope';

/** One stored turn — mirrors the core `/me/ask` wire contract and the `ask_conversation.messages` rows. */
export interface AskStoredMessage {
  turnId?: string;
  role: 'user' | 'assistant';
  content: string;
  scope?: AskScope;
  followups?: string[];
}

/** The caller's persisted Ask AI thread, as returned by `GET /me/ask/conversations`. */
export interface StoredConversation {
  id: string;
  messages: AskStoredMessage[];
}

/**
 * Mint a fresh client-side conversation id (`cnv_…`, via @prismical/id so it matches the cloud id
 * format). The client owns the id: it's sent with every ask and becomes the `ask_conversation` row's
 * primary key on the first server-side save. "New chat" mints a new one.
 */
export function mintConversationId(): string {
  return createId('askConversation');
}

/**
 * Seed adapter: stored `{role,content}[]` → UIMessages for `useChat({ messages })`. Each message gets
 * a stable, derived id (conversationId + index) so re-renders don't churn keys. Source chips are NOT
 * stored separately — `AskMessage` reconstructs them from the assistant text via `parseSources`.
 */
export function toUiMessages(stored: AskStoredMessage[], conversationId: string): UIMessage[] {
  return stored.map((m, i) => ({
    id: m.turnId ?? `${conversationId}:${i}`,
    role: m.role,
    ...(m.scope !== undefined ? { metadata: { scope: m.scope } } : {}),
    parts: [
      {
        type: 'text',
        text: m.followups?.length
          ? `${m.content}\nFollow-ups: ${m.followups.join(' | ')}`
          : m.content,
      },
    ],
  }));
}

/** Undefined means legacy/unknown; {} explicitly means this turn had no attachments. */
export function askMessageScope(message: UIMessage | undefined): AskScope | undefined {
  const metadata = message?.metadata;
  if (!metadata || typeof metadata !== 'object' || !('scope' in metadata)) return undefined;
  const result = AskScopeSchema.safeParse(metadata.scope);
  return result.success ? result.data : undefined;
}

/** A follow-up belongs to its answer's preceding question, regardless of current navigation. */
export function askOriginScope(messages: UIMessage[], messageId: string): AskScope {
  const index = messages.findIndex(message => message.id === messageId);
  for (let i = index; i >= 0; i--) {
    if (messages[i]?.role === 'user') return askMessageScope(messages[i]) ?? {};
  }
  return {};
}

/** Continue the latest answer with its question's attachments, including after restoration. */
export function askContinuationMessage(messages: UIMessage[], text: string) {
  return {
    text,
    metadata: { scope: askOriginScope(messages, messages.at(-1)?.id ?? '') },
  };
}
