import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from 'ai';
import {
  AI_ERROR_CODES,
  encodeAskStreamError,
  ASK_ERROR_FORMAT_ENVELOPE,
  ASK_ERROR_FORMAT_HEADER,
} from '@prismical/api-contracts';
import { coreApiBaseUrl, getAskFetch, getClientEnv } from '../runtime';
import { getAuthHeaders, getAuthHeadersForToken } from '../api/auth';
import { ME_PREFIX } from '../api/client';
import { uiMessageText, type AskScope } from './scope';
import { askMessageScope } from './conversation';
import { isAuto, type AskModelSelection } from './models';
import type { AuthPort, SessionView } from '@prismical/app-contracts';

/**
 * Model-context window: the most-recent turns sent to `/me/ask`. Must stay ≤ the backend's
 * `askRequestSchema.messages.max(50)` — a resumed thread seeds up to 100 stored messages into
 * useChat, so without this slice the next ask would exceed the cap and hard-400. This
 * is independent of the 100-message STORED history the server accumulates server-side.
 */
export const MAX_REQUEST_MESSAGES = 40;

export class AskSessionChangedError extends Error {}

/** An HTTP success can still be a truncated stream (for example, a server restart).
 * The SDK accepts EOF without a finish event, leaving the question silently unanswered.
 * Require an explicit outcome, including when some answer text already arrived. */
export class AskChatTransport extends DefaultChatTransport<UIMessage> {
  protected override processResponseStream(stream: ReadableStream<Uint8Array>) {
    let settled = false;
    let hasContent = false;
    let hasError = false;
    return super.processResponseStream(stream).pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (chunk.type === 'finish' || chunk.type === 'error') settled = true;
          if (chunk.type === 'error') hasError = true;
          if (
            (chunk.type === 'text-delta' && chunk.delta.trim().length > 0) ||
            chunk.type.startsWith('tool-')
          )
            hasContent = true;
          controller.enqueue(chunk);
        },
        flush() {
          if (!settled || (!hasContent && !hasError)) {
            throw new Error(
              encodeAskStreamError(AI_ERROR_CODES.ASK_REQUEST_FAILED, { retryable: true })
            );
          }
        },
      })
    );
  }
}

function exactSessionKey(view: SessionView): string | null {
  return view.activeSessionKey ?? view.activeSub ?? null;
}

function activeOrgId(view: SessionView): string | null {
  const sessionKey = exactSessionKey(view);
  return (
    view.accounts.find(account => (account.sessionKey ?? account.sub) === sessionKey)
      ?.activeOrgId ?? null
  );
}

function ownsAskContext(
  view: SessionView,
  ownerSessionKey: string,
  ownerOrgId: string | null
): boolean {
  return exactSessionKey(view) === ownerSessionKey && activeOrgId(view) === ownerOrgId;
}

/** Refuse to restamp a delayed Ask/tool-approval request with a new login. */
export async function exactSessionAskHeaders(
  auth: AuthPort,
  ownerSessionKey: string,
  ownerOrgId: string | null
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
  ownerOrgId: string | null
): Promise<Record<string, string>> {
  return platform === 'web'
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
  helpContext?: {
    platform: 'web' | 'macos' | 'windows' | 'linux' | 'unknown';
    appVersion?: string;
  };
}

/** Pure reshaping: UIMessages → backend {messages:[{role,content}], scope?, conversationId?}. Drops empty-text msgs, windows to the most-recent turns. */
export function buildAskRequest(input: AskRequestInput): { body: object; headers: HeadersInit } {
  const messages = input.messages
    // The backend accepts only user/assistant turns; useChat never emits `system`, but guard anyway.
    .filter(m => m.role === 'user' || m.role === 'assistant')
    // Full parts ride along so tool calls + approval responses round-trip; `content`
    // stays as the text fallback for legacy consumers/persistence. A turn that is ONLY tool
    // activity has no text — keep it (dropping it would break the approval resume).
    .map(m => ({ role: m.role, content: uiMessageText(m) || '[tool activity]', parts: m.parts }))
    .filter(m => m.content.length > 0)
    // Keep only the most-recent window; the last element stays the new user turn.
    .slice(-MAX_REQUEST_MESSAGES);
  const body: {
    messages: { role: string; content: string }[];
    scope?: AskScope;
    turnId?: string;
    conversationId?: string;
    instanceId?: string;
    modelId?: string;
    suggestFollowups?: boolean;
    helpContext?: AskRequestInput['helpContext'];
  } = { messages, suggestFollowups: true };
  const lastUser = input.messages.filter(message => message.role === 'user').at(-1);
  if (lastUser) body.turnId = lastUser.id;
  if (input.helpContext) body.helpContext = input.helpContext;
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
 * Build the Ask transport. Question metadata owns scope across retries and reloads.
 * `getScope` supports older callers without metadata; conversationId is fixed per chat.
 * Auth headers are resolved per request from the shared seam.
 */
export function createAskTransport(
  getScope: () => AskScope | undefined,
  conversationId: string | undefined,
  getModel?: () => AskModelSelection | undefined,
  getHeaders: () => Record<string, string> | Promise<Record<string, string>> = getAuthHeaders,
  /** App-owned admission, checked again after authentication and at the request boundary. */
  assertCanSend?: () => void
) {
  // Desktop injects an AskFetch shim over the MessagePort stream lane so
  // the renderer never reaches the server — the `api` becomes a relative marker
  // the shim ignores, and coreApiBaseUrl() is never called (it throws on desktop
  // by construction). Web injects nothing and keeps the direct-fetch lane
  // byte-identical.
  const askFetch = getAskFetch();
  let scopeMessageId: string | undefined;
  let scope: AskScope | undefined;
  return new AskChatTransport({
    api: askFetch ? `${ME_PREFIX}/ask` : `${coreApiBaseUrl()}${ME_PREFIX}/ask`,
    fetch: (input, init) => {
      assertCanSend?.();
      return (askFetch ?? globalThis.fetch)(input, init);
    },
    prepareSendMessagesRequest: async ({ messages }) => {
      assertCanSend?.();
      const userMessage = messages.filter(message => message.role === 'user').at(-1);
      const userMessageId = userMessage?.id;
      // Restored metadata wins over current UI state, including an explicitly empty scope.
      // Legacy callers retain the cached scope for retry and approval continuation.
      if (userMessageId !== scopeMessageId) {
        scopeMessageId = userMessageId;
        scope = askMessageScope(userMessage) ?? getScope();
      }
      const model = getModel?.();
      const headers = await getHeaders();
      assertCanSend?.();
      return buildAskRequest({
        messages,
        scope,
        conversationId,
        model,
        headers,
        helpContext: askHelpContext(getClientEnv()),
      });
    },
  });
}

export function askHelpContext(env: {
  platform: string;
  appVersion: string | null;
}): NonNullable<AskRequestInput['helpContext']> {
  const platforms = { web: 'web', darwin: 'macos', win32: 'windows', linux: 'linux' } as const;
  return {
    platform: platforms[env.platform as keyof typeof platforms] ?? 'unknown',
    ...(env.appVersion ? { appVersion: env.appVersion.slice(0, 80) } : {}),
  };
}
