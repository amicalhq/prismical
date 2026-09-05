import { DefaultChatTransport, type UIMessage } from "ai";
import { ASK_ERROR_FORMAT_ENVELOPE, ASK_ERROR_FORMAT_HEADER } from "@prismical/api-contracts";
import { coreApiBaseUrl, getAskFetch } from "../runtime";
import { getAuthHeaders, getAuthHeadersForToken } from "../api/auth";
import { ME_PREFIX } from "../api/client";
import { uiMessageText, type AskScope } from "./scope";
import { isAuto, type AskModelSelection } from "./models";
import type { AuthPort, SessionView } from "@prismical/app-contracts";

/**
 * Model-context window: the most-recent turns sent to `/me/ask`. Must stay ≤ the backend's
 * `askRequestSchema.messages.max(50)` — a resumed thread seeds up to 100 stored messages into
 * useChat, so without this slice the next ask would exceed the cap and hard-400. This
 * is independent of the 100-message STORED history the server accumulates server-side.
 */
export const MAX_REQUEST_MESSAGES = 40;

export class AskSessionChangedError extends Error {}

function exactSessionKey(view: SessionView): string | null {
  return view.activeSessionKey ?? view.activeSub ?? null;
}

function activeOrgId(view: SessionView): string | null {
  const sessionKey = exactSessionKey(view);
  return (
    view.accounts.find((account) => (account.sessionKey ?? account.sub) === sessionKey)
      ?.activeOrgId ?? null
  );
}

function ownsAskContext(
  view: SessionView,
  ownerSessionKey: string,
  ownerOrgId: string | null,
): boolean {
  return exactSessionKey(view) === ownerSessionKey && activeOrgId(view) === ownerOrgId;
}

/** Refuse to restamp a delayed Ask/tool-approval request with a new login. */
export async function exactSessionAskHeaders(
  auth: AuthPort,
  ownerSessionKey: string,
  ownerOrgId: string | null,
): Promise<Record<string, string>> {
  if (!ownsAskContext(auth.getSession(), ownerSessionKey, ownerOrgId)) {
    throw new AskSessionChangedError();
  }
  const token = await auth.getTokenForSession(ownerSessionKey, ownerOrgId);
  if (!token || !ownsAskContext(auth.getSession(), ownerSessionKey, ownerOrgId)) {
    throw new AskSessionChangedError();
  }
  return {
    ...getAuthHeadersForToken(token, ownerOrgId),
    // This client parses the Ask error envelope (askStreamFailureOf); core sends it only then.
    [ASK_ERROR_FORMAT_HEADER]: ASK_ERROR_FORMAT_ENVELOPE,
  };
}

/** Desktop Ask travels through main-owned IPC auth and must never request a
 * renderer bearer. Exact bearer binding is only needed for web's direct fetch. */
export function askHeadersForPlatform(
  platform: string,
  auth: AuthPort,
  ownerSessionKey: string,
  ownerOrgId: string | null,
): Promise<Record<string, string>> {
  return platform === "web"
    ? exactSessionAskHeaders(auth, ownerSessionKey, ownerOrgId)
    : Promise.resolve({});
}

export interface AskRequestInput {
  messages: UIMessage[];
  scope: AskScope | undefined;
  conversationId: string | undefined;
  /** The chosen provider instance + model. Auto (Prismical Cloud) is sent as nothing (backend default). */
  model?: AskModelSelection;
  headers: Record<string, string>;
}

/** Pure reshaping: UIMessages → backend {messages:[{role,content}], scope?, conversationId?}. Drops empty-text msgs, windows to the most-recent turns. */
export function buildAskRequest(input: AskRequestInput): { body: object; headers: HeadersInit } {
  const messages = input.messages
    // The backend accepts only user/assistant turns; useChat never emits `system`, but guard anyway.
    .filter((m) => m.role === "user" || m.role === "assistant")
    // Full parts ride along so tool calls + approval responses round-trip; `content`
    // stays as the text fallback for legacy consumers/persistence. A turn that is ONLY tool
    // activity has no text — keep it (dropping it would break the approval resume).
    .map((m) => ({ role: m.role, content: uiMessageText(m) || "[tool activity]", parts: m.parts }))
    .filter((m) => m.content.length > 0)
    // Keep only the most-recent window; the last element stays the new user turn.
    .slice(-MAX_REQUEST_MESSAGES);
  const body: {
    messages: { role: string; content: string }[];
    scope?: AskScope;
    conversationId?: string;
    instanceId?: string;
    modelId?: string;
    suggestFollowups?: boolean;
  } = { messages, suggestFollowups: true };
  if (input.scope) body.scope = input.scope;
  // The conversation this thread persists into; omitted ⇒ stateless ask.
  if (input.conversationId) body.conversationId = input.conversationId;
  // Model selection: omit for Auto (managed) so the backend uses its default; send the instance +
  // model for a BYOK pick. The backend validates ownership/curation and refuses admin-override BYOK.
  if (input.model && !isAuto(input.model)) {
    body.instanceId = input.model.instanceId;
    body.modelId = input.model.modelId;
  }
  return { body, headers: input.headers };
}

/**
 * Build the Ask AI chat transport. `getScope` is read fresh on every send so the latest context
 * chips drive `scope`; `conversationId` is fixed per chat instance (server persists the turn into it).
 * Auth headers are resolved per request from the shared seam.
 */
export function createAskTransport(
  getScope: () => AskScope | undefined,
  conversationId: string | undefined,
  getModel?: () => AskModelSelection | undefined,
  getHeaders: () => Record<string, string> | Promise<Record<string, string>> = getAuthHeaders,
) {
  // Desktop injects an AskFetch shim over the MessagePort stream lane so
  // the renderer never reaches the server — the `api` becomes a relative marker
  // the shim ignores, and coreApiBaseUrl() is never called (it throws on desktop
  // by construction). Web injects nothing and keeps the direct-fetch lane
  // byte-identical.
  const askFetch = getAskFetch();
  return new DefaultChatTransport<UIMessage>({
    api: askFetch ? `${ME_PREFIX}/ask` : `${coreApiBaseUrl()}${ME_PREFIX}/ask`,
    ...(askFetch ? { fetch: askFetch as typeof fetch } : {}),
    prepareSendMessagesRequest: async ({ messages }) =>
      buildAskRequest({
        messages,
        scope: getScope(),
        conversationId,
        model: getModel?.(),
        headers: await getHeaders(),
      }),
  });
}
