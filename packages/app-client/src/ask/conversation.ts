import { createId } from "@prismical/id";
import type { UIMessage } from "ai";

/** One stored turn — mirrors the core `/me/ask` wire contract and the `ask_conversation.messages` rows. */
export interface AskStoredMessage {
  role: "user" | "assistant";
  content: string;
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
  return createId("askConversation");
}

/**
 * Seed adapter: stored `{role,content}[]` → UIMessages for `useChat({ messages })`. Each message gets
 * a stable, derived id (conversationId + index) so re-renders don't churn keys. Source chips are NOT
 * stored separately — `AskMessage` reconstructs them from the assistant text via `parseSources`.
 */
export function toUiMessages(stored: AskStoredMessage[], conversationId: string): UIMessage[] {
  return stored.map((m, i) => ({
    id: `${conversationId}:${i}`,
    role: m.role,
    parts: [{ type: "text", text: m.content }],
  }));
}
