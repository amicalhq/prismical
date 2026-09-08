/**
 * The local Ask lane implements the server's Ask behavior over the
 * product store and the AiProvider. The producer returns a WHATWG Response
 * whose body is the AI-SDK UI-message SSE stream — exactly what the cloud
 * lane's `POST /apps/v1/me/ask` returns — so the StreamBroker forwards it to
 * the renderer's useChat byte-for-byte with no change. Retrieval is FTS5
 * (search.ts); `get_note` serves the markdown projection; ACL reduces to
 * "not trashed, not deleted". A conversation id persists the turn like core.
 */
import type { LogMetadata } from '../../infra/logging/service';
import {
  AI_ERROR_CODES,
  describeAiError,
  encodeAskStreamError,
  type AiErrorDetails,
} from '@prismical/api-contracts';
import { desc, eq, inArray } from 'drizzle-orm';
import {
  APICallError,
  convertToModelMessages,
  isStepCount,
  streamText,
  tool,
  type ModelMessage,
  type UIMessage,
} from 'ai';
import {
  AskRequestSchema,
  AskStoredMessageSchema,
  type AskStoredMessage,
} from '@prismical/api-contracts/apps/v1';
import {
  ASK_GET_NOTE_NOT_FOUND,
  ASK_GET_NOTE_SPEC,
  ASK_MAX_OUTPUT_TOKENS_FALLBACK,
  ASK_SEARCH_DEFAULT_K,
  ASK_SEARCH_NOTES_SPEC,
  ASK_SNIPPET_CHARS,
  askStepBudget,
  classifyProviderError,
  buildAskSystemPrompt,
  type AskGetNoteResult,
  type AskSearchResult,
  type FocusNote,
} from '@prismical/ai-prompts';
import type Database from 'better-sqlite3';
import { askErrorResponse } from '../transport/ask-error';
import * as schema from '../../infra/product-db/schema';
import type { LocalAiPort } from './ai-port';
import { searchNotes, type SearchScope } from './search';
import { describeDbError, ok, type LocalDb, type RouteResult } from './wire';

export interface AskDeps {
  readonly locale: string;
  readonly db: LocalDb;
  readonly client: Database.Database;
  readonly ai: LocalAiPort;
  readonly log: (message: string, data?: LogMetadata['context']) => void;
}

// ── GET /me/ask/conversations ──────────────────────────────────────────────

const MAX_STORED_MESSAGES = 100;

const storedMessages = (raw: unknown): AskStoredMessage[] =>
  Array.isArray(raw)
    ? raw.flatMap(entry => {
        const parsed = AskStoredMessageSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

/** The most recently updated conversation, or null (core's `loadConversation`). */
export async function askConversations(db: LocalDb): Promise<RouteResult> {
  const rows = await db
    .select()
    .from(schema.askConversation)
    .orderBy(desc(schema.askConversation.updatedAt))
    .limit(1);
  const row = rows[0];
  return ok(row === undefined ? null : { id: row.id, messages: storedMessages(row.messages) });
}

const deriveTitle = (content: string): string => {
  const t = content.trim().replace(/\s+/g, ' ');
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
};

/**
 * Persist the [last user, assistant] pair (core's `appendTurn`). A resume
 * re-POST (assistant turn last) REPLACES the stored answer for the same user
 * turn instead of appending a duplicate.
 */
export async function appendTurn(
  db: LocalDb,
  conversationId: string,
  messages: ReadonlyArray<AskStoredMessage>,
  assistantText: string
): Promise<void> {
  const last = messages.at(-1);
  if (last === undefined || assistantText.trim() === '') return;
  const isResume = last.role !== 'user';
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (lastUser === undefined) return;

  const existing = await db
    .select()
    .from(schema.askConversation)
    .where(eq(schema.askConversation.id, conversationId))
    .limit(1);
  const prior = existing[0] === undefined ? [] : storedMessages(existing[0].messages);
  const assistant: AskStoredMessage = { role: 'assistant', content: assistantText };
  let next: AskStoredMessage[];
  const previousUser = prior.at(-2);
  if (
    isResume &&
    previousUser !== undefined &&
    previousUser.role === 'user' &&
    previousUser.content === lastUser.content &&
    prior.at(-1)?.role === 'assistant'
  ) {
    next = [...prior.slice(0, -1), assistant];
  } else {
    next = [...prior, { role: 'user', content: lastUser.content }, assistant];
  }
  next = next.slice(-MAX_STORED_MESSAGES);
  const now = new Date().toISOString();
  await db
    .insert(schema.askConversation)
    .values({
      id: conversationId,
      title: deriveTitle(next.find(m => m.role === 'user')?.content ?? ''),
      messages: next,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.askConversation.id,
      set: { messages: next, updatedAt: now },
    });
}

// ── POST /me/ask (the stream producer) ─────────────────────────────────────

const localErrorText = (locale: string, code: string, details: AiErrorDetails = {}): string => {
  const localDetails: AiErrorDetails = { ...details, lane: 'your-key' };
  const user = describeAiError({
    code,
    details: localDetails,
    locale,
    surface: 'ask',
    cloudAvailable: false,
  });
  return encodeAskStreamError(code, {
    ...localDetails,
    user,
  });
};

export const localAskRequestFailure = (locale: string): Response =>
  askErrorResponse(localErrorText(locale, AI_ERROR_CODES.ASK_REQUEST_FAILED, { retryable: true }));

const loadFocusNotes = async (db: LocalDb, ids: ReadonlyArray<string>): Promise<FocusNote[]> => {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: schema.note.id,
      title: schema.note.title,
      contentMarkdown: schema.note.contentMarkdown,
      contentText: schema.note.contentText,
      trashedAt: schema.note.trashedAt,
      deletedAt: schema.note.deletedAt,
    })
    .from(schema.note)
    .where(inArray(schema.note.id, [...ids]));
  const byId = new Map(rows.map(row => [row.id, row]));
  // Preserve the request order; silently drop unreadable ids (core does too).
  return ids.flatMap(id => {
    const row = byId.get(id);
    return row === undefined || row.trashedAt !== null || row.deletedAt !== null
      ? []
      : [{ noteId: row.id, title: row.title, contentText: row.contentMarkdown ?? row.contentText ?? '' }];
  });
};

const getNoteForAsk = async (db: LocalDb, noteId: string): Promise<AskGetNoteResult> => {
  const rows = await db
    .select({
      id: schema.note.id,
      title: schema.note.title,
      contentMarkdown: schema.note.contentMarkdown,
      contentText: schema.note.contentText,
      trashedAt: schema.note.trashedAt,
      deletedAt: schema.note.deletedAt,
    })
    .from(schema.note)
    .where(eq(schema.note.id, noteId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.trashedAt !== null || row.deletedAt !== null) {
    return ASK_GET_NOTE_NOT_FOUND;
  }
  return { noteId: row.id, title: row.title, content: row.contentMarkdown ?? row.contentText ?? '' };
};

const buildAskTools = (deps: AskDeps, scope: SearchScope) => ({
  [ASK_SEARCH_NOTES_SPEC.name]: tool({
    description: ASK_SEARCH_NOTES_SPEC.description,
    inputSchema: ASK_SEARCH_NOTES_SPEC.inputSchema,
    execute: async ({ query, k }): Promise<AskSearchResult[]> => {
      const { hits } = await searchNotes(deps.client, {
        query,
        limit: k ?? ASK_SEARCH_DEFAULT_K,
        scope,
      });
      // The markdown projection, like core's bodyMarkdown coalesce and this
      // lane's own get_note — the plaintext stays on /me/search.
      return hits.map(hit => ({
        noteId: hit.noteId,
        title: hit.title,
        snippet: (hit.contentMarkdown ?? hit.contentText).slice(0, ASK_SNIPPET_CHARS),
        rank: hit.rank,
      }));
    },
  }),
  [ASK_GET_NOTE_SPEC.name]: tool({
    description: ASK_GET_NOTE_SPEC.description,
    inputSchema: ASK_GET_NOTE_SPEC.inputSchema,
    execute: ({ noteId }) => getNoteForAsk(deps.db, noteId),
  }),
});

/**
 * Open the local Ask stream. Every failure BEFORE the model call is delivered
 * as a UI-message error part (the renderer shows it in the thread) rather
 * than a closed port — a silent empty answer is the one outcome the user
 * cannot act on. Cancelling the returned body aborts the model call.
 */
export async function openLocalAskStream(
  deps: AskDeps,
  body: unknown,
  /** The broker's producer-fiber interruption (Stop, port close, scope close). */
  signal?: AbortSignal
): Promise<Response> {
  const errorResponse = (code: string, details: AiErrorDetails = {}): Response =>
    askErrorResponse(localErrorText(deps.locale, code, details));
  const parsed = AskRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorResponse(AI_ERROR_CODES.ASK_REQUEST_FAILED, { retryable: false });
  const { messages, scope, conversationId, instanceId, modelId } = parsed.data;

  const resolved = await deps.ai.resolve({ instanceId, modelId });
  if (!resolved.ok) {
    deps.log('ask: provider unavailable', { reason: resolved.error.reason });
    return errorResponse(
      {
        'not-configured': AI_ERROR_CODES.MODEL_NOT_CONFIGURED,
        'unknown-instance': AI_ERROR_CODES.INSTANCE_NOT_FOUND,
        'model-required': AI_ERROR_CODES.MODEL_SELECTION_INVALID,
        disabled: AI_ERROR_CODES.MODEL_SELECTION_INVALID,
      }[resolved.error.reason],
      { provider: resolved.error.provider ?? undefined, model: modelId, retryable: false }
    );
  }
  const { model, provider, modelId: resolvedModelId, toolSupport } = resolved.value;

  const focusNotes = await loadFocusNotes(deps.db, scope?.noteIds ?? []);
  const hasScopeFilter = Boolean(scope?.folderIds?.length || scope?.tagIds?.length);
  const searchScope: SearchScope = {
    ...(scope?.folderIds?.length ? { folderIds: scope.folderIds } : {}),
    ...(scope?.tagIds?.length ? { tagIds: scope.tagIds } : {}),
  };
  // A model known to have no tool calling answers from the focus notes alone
  // — and the prompt must say so, or it will "call" tools it does not have
  // and promise a Sources line it cannot ground.
  const toolsAvailable = toolSupport !== 'none';
  const tools = toolsAvailable ? buildAskTools(deps, searchScope) : {};
  const system = buildAskSystemPrompt({ focusNotes, hasScopeFilter, toolsAvailable });

  let modelMessages: ModelMessage[];
  const usesParts = messages.some(m => m.parts !== undefined);
  if (usesParts) {
    try {
      const ui = messages.map(m => ({
        role: m.role,
        parts: (m.parts ?? [{ type: 'text', text: m.content }]) as UIMessage['parts'],
      })) as UIMessage[];
      modelMessages = await convertToModelMessages(ui, { tools, ignoreIncompleteToolCalls: true });
    } catch {
      return errorResponse(AI_ERROR_CODES.ASK_REQUEST_FAILED, { retryable: false });
    }
  } else {
    modelMessages = messages.map(m => ({ role: m.role, content: m.content })) as ModelMessage[];
  }

  const ac = new AbortController();
  if (signal?.aborted)
    return errorResponse(AI_ERROR_CODES.ASK_REQUEST_FAILED, { retryable: false });
  signal?.addEventListener('abort', () => ac.abort(), { once: true });
  const result = streamText({
    model,
    instructions: system,
    messages: modelMessages,
    tools,
    stopWhen: isStepCount(askStepBudget(false)),
    maxOutputTokens: ASK_MAX_OUTPUT_TOKENS_FALLBACK,
    abortSignal: ac.signal,
    onEnd: ({ text, steps }) => {
      const answer = steps.map(step => step.text).filter(Boolean).join('\n\n') || text;
      if (conversationId === undefined) return;
      void appendTurn(deps.db, conversationId, messages, answer).catch((error: unknown) =>
        deps.log('ask: conversation persist failed', { cause: describeDbError(error) })
      );
    },
    onError: ({ error }) => {
      // Class + status only: a provider error body can echo the request.
      deps.log('ask: model call failed', {
        provider,
        model: resolvedModelId,
        error: error instanceof Error ? error.name : typeof error,
        ...(APICallError.isInstance(error) ? { status: error.statusCode } : {}),
      });
    },
  });
  const response = result.toUIMessageStreamResponse({
    sendReasoning: false,
    // The message the renderer shows; provider detail stays in main.log.
    onError: error => {
      const failure = classifyProviderError(error);
      return localErrorText(deps.locale, failure?.code ?? AI_ERROR_CODES.ASK_REQUEST_FAILED, {
        provider,
        model: resolvedModelId,
        retryable: failure?.retryable ?? true,
        ...(failure?.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      });
    },
  });
  const upstream = response.body;
  if (upstream === null) return localAskRequestFailure(deps.locale);
  const reader = upstream.getReader();
  const piped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      ac.abort();
      void reader.cancel().catch(() => undefined);
    },
  });
  return new Response(piped, { status: response.status, headers: response.headers });
}
