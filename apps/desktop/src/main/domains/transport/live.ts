/**
 * WorkspaceBackend + session-current accessor live layers.
 *
 * The unary REST lane: per allowlisted request, resolve the session's
 * guarded id_token and active org through SignedInSession,
 * `fetch(coreApiUrl + path + query)` stamping
 * `Authorization: Bearer <idToken>` + (when present) `x-active-org-id` +
 * `Content-Type` on bodied methods, and map the exchange onto the
 * TransportResponse envelope. Mirrors domains/auth/live.ts's injectable
 * FetchLike + Effect.tryPromise + Effect.timeoutFail pattern (no @effect/platform
 * in the repo) so the mapping is unit-testable without a socket.
 *
 * Secrets discipline: the id_token is stamped into the outbound
 * Authorization header and NEVER passed to a log call. Only method/path/status
 * are ever logged.
 */
import { desktopFetch } from '../../infra/http/client';
import {
  AI_ERROR_CODES,
  ASK_ERROR_FORMAT_HEADER,
  ASK_ERROR_FORMAT_ENVELOPE,
  ApiErrorResponseSchema,
  describeAiError,
  encodeAskStreamError,
  parseAiErrorDetails,
} from '@prismical/api-contracts';
import {
  SyncWriteResponseSchema,
  TranscribeChunkResponseSchema,
} from '@prismical/api-contracts/apps/v1';
import { askErrorResponse } from './ask-error';
import { recordingRetryAfterMs } from './recording-retry';
import { DesktopI18n } from '../i18n/service';
import { Duration, Effect, Layer, Option, Stream, SubscriptionRef } from 'effect';
import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import type { AuthStateError, RefreshError } from '../auth/service';
import type { AuthState } from '../auth/policy';
import { SignedInSession, type StaleSessionError } from '../../runtime/workspace-layer';
import {
  AskStreamError,
  WorkspaceBackend,
  WorkspaceTransport,
  type WorkspaceBackendApi,
  type WorkspaceIdentity,
  type WorkspaceTransportApi,
  type CreateRecordingInput,
  type FinalizeRecordingInput,
  type RecordingLaneFailure,
  type RecordingLaneResult,
  type RecordingSegment,
  type TranscribeChunkParams,
} from './service';

/** Unary request budget — mirrors auth's TOKEN_REQUEST_TIMEOUT. */
export const REQUEST_TIMEOUT = Duration.seconds(15);
/** Chunk uploads include audio transfer and the transcription response. */
const CHUNK_UPLOAD_TIMEOUT = Duration.minutes(1);
/** Wait for a workspace swap, separately from the HTTP request budget. */
export const WORKSPACE_READY_TIMEOUT = Duration.seconds(10);

/** The single Ask streaming endpoint. */
export const ASK_PATH = '/apps/v1/me/ask';

const INTERNAL: TransportResponse = { error: { code: 'INTERNAL' } };

/**
 * Injectable HTTP shape (mirrors auth/live.ts's FetchLike). `body` is optional —
 * GET/DELETE carry none; the JSON lanes send a `string`, and the recording lane's
 * WAV chunk sends the RAW bytes as a `Uint8Array` (a valid BodyInit) with
 * Content-Type: audio/wav (the non-JSON path); the BYOK transcription lane
 * sends a multipart `FormData` (fetch sets its boundary
 * Content-Type). The interrupt signal flows through so a dying caller aborts
 * the fetch; the ambient default is the main-process global fetch (TLS uses
 * the startup trust store and NODE_EXTRA_CA_CERTS — no per-request TLS).
 */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | Uint8Array | FormData;
    readonly signal: AbortSignal;
  }
) => Promise<Response>;

/** Identity resolved fresh per request (the guard runs inside `resolveIdentity`). */
export interface RequestIdentity {
  readonly idToken: string;
  readonly activeOrgId: string | undefined;
}

export interface CloudBackendDeps {
  readonly coreApiUrl: string;
  readonly locale?: string;
  readonly fetchFn: FetchLike;
  /**
   * Resolves the current id_token (transparently refreshed) + active org, or
   * fails typed when the session is stale/dropped or a refresh failed. Failure
   * short-circuits BEFORE any fetch — a stale identity never puts a request on
   * the wire (StaleSessionError guard preserved).
   */
  readonly resolveIdentity: Effect.Effect<
    RequestIdentity,
    StaleSessionError | RefreshError | AuthStateError
  >;
}

const buildRequestUrl = (
  coreApiUrl: string,
  path: string,
  query: Record<string, string> | undefined
): string => {
  const base = `${coreApiUrl}${path}`;
  if (query === undefined) return base;
  const qs = new URLSearchParams(query).toString();
  return qs === '' ? base : `${base}?${qs}`;
};

const stampHeaders = (identity: RequestIdentity, req: TransportRequest): Record<string, string> => {
  const headers: Record<string, string> = { Authorization: `Bearer ${identity.idToken}` };
  // Omit the org header entirely when absent — the server then resolves the
  // user's default org (a malformed/empty header would 400 after auth).
  if (identity.activeOrgId !== undefined) headers['x-active-org-id'] = identity.activeOrgId;
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  return headers;
};

/** Ask POST headers — same MAIN-stamped Bearer + org as REST, plus SSE Accept. */
const askHeaders = (identity: RequestIdentity, locale: string): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${identity.idToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    [ASK_ERROR_FORMAT_HEADER]: ASK_ERROR_FORMAT_ENVELOPE,
    'x-prismical-locale': locale,
    'Accept-Language': locale,
  };
  if (identity.activeOrgId !== undefined) headers['x-active-org-id'] = identity.activeOrgId;
  return headers;
};

/**
 * The Ask stream opener, testable with an injected FetchLike +
 * resolveIdentity. Resolves the guarded identity (short-circuits to
 * `no-identity` BEFORE any fetch so a stale session never opens a stream), then
 * POSTs the Ask body to core and hands back the raw SSE `Response`. The fetch
 * rides the tryPromise interrupt signal, so an interrupted caller (abort / port
 * close) aborts the connection — core's `reply.raw.on('close')` fires and the
 * billable model call stops. The id_token is stamped into Authorization and
 * NEVER logged.
 */
export const makeOpenAskStream =
  (deps: CloudBackendDeps) =>
  (body: unknown): Effect.Effect<Response, AskStreamError> => {
    const locale = deps.locale ?? 'en';
    const failureResponse = (bodyJson: unknown): Response => {
      const parsed = ApiErrorResponseSchema.safeParse(bodyJson);
      const code = parsed.success ? parsed.data.error.code : AI_ERROR_CODES.ASK_REQUEST_FAILED;
      const details = parseAiErrorDetails(parsed.success ? parsed.data.error.details : undefined);
      return askErrorResponse(
        encodeAskStreamError(code, {
          ...details,
          user: details.user ?? describeAiError({ code, details, locale, surface: 'ask' }),
        })
      );
    };
    return deps.resolveIdentity.pipe(
      Effect.mapError(() => new AskStreamError({ reason: 'no-identity' })),
      Effect.flatMap(identity =>
        Effect.tryPromise({
          try: async signal => {
            const response = await deps.fetchFn(`${deps.coreApiUrl}${ASK_PATH}`, {
              method: 'POST',
              headers: askHeaders(identity, locale),
              body: JSON.stringify(body ?? {}),
              signal,
            });
            if (response.ok) return response;
            return failureResponse(await response.json().catch(() => null));
          },
          catch: () => new AskStreamError({ reason: 'connect' }),
        }).pipe(Effect.catchAll(() => Effect.succeed(failureResponse(null))))
      )
    );
  };

/**
 * The pure request mapper — the WorkspaceBackend's whole behavior, testable with an
 * injected FetchLike + resolveIdentity. Never fails (E = never): identity
 * failure, network, timeout and defects all fold to the INTERNAL envelope.
 */
export const makeWorkspaceBackendRequest =
  (deps: CloudBackendDeps) =>
  (req: TransportRequest): Effect.Effect<TransportResponse> =>
    deps.resolveIdentity.pipe(
      Effect.flatMap(identity => {
        const url = buildRequestUrl(deps.coreApiUrl, req.path, req.query);
        const headers = stampHeaders(identity, req);
        return Effect.tryPromise({
          try: async signal => {
            const response = await deps.fetchFn(url, {
              method: req.method,
              headers,
              ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
              signal,
            });
            // Body consumption shares the fetch's cancellation and deadline.
            // Preserve non-JSON error statuses for the renderer's error mapping.
            const bodyJson =
              response.status === 204
                ? undefined
                : response.ok
                  ? await response.json()
                  : await response.json().catch(() => null);
            return { ok: true, status: response.status, bodyJson } satisfies TransportResponse;
          },
          catch: cause => ({ kind: 'network' as const, cause }),
        }).pipe(
          Effect.timeoutFail({
            duration: REQUEST_TIMEOUT,
            onTimeout: () => ({ kind: 'timeout' as const }),
          })
        );
      }),
      Effect.catchAll(() => Effect.succeed(INTERNAL)),
      Effect.catchAllDefect(() => Effect.succeed(INTERNAL))
    );

// ---------------------------------------------------------------------------
// Cloud recording lane: create → transcribe-chunk → finalize
// ---------------------------------------------------------------------------

/** The recordings + transcribe endpoints all hang off the /apps/v1/me prefix. */
export const RECORDINGS_PATH = '/apps/v1/me/recordings';

/**
 * Managed cloud transcription default. It names no model: which engine Prismical Cloud routes a
 * managed recording to is a server-side decision and is not
 * disclosed — this constant is compiled into a shipped desktop build, so anything named here is
 * public. A BYOK recording overrides this with the owner's { instanceId, modelId } via
 * CreateRecordingInput.transcriptionConfig. Mirrors web's create default
 * (packages/app-client/src/api/transcription.ts) so the wire config matches.
 */
export const MANAGED_TRANSCRIPTION_CONFIG = {
  provider: 'prismical-cloud',
  model: 'prismical-cloud',
  language: 'en',
} as const;

/**
 * Retry classification for a completed non-2xx exchange — the drain keys off this.
 * 429 and every 5xx are TRANSIENT
 * (retry with backoff); every other status — 404/410 (recording gone), 422
 * (TRANSCRIPTION_MODEL_UNAVAILABLE), and the other deterministic 4xx (400 bad WAV,
 * 402 quota, 415 media type) — is NOT retryable (the drain gives up: status:'failed').
 */
export const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

/** Pre-response aborts — all transient (the guard short-circuit + the two fetch failures). */
type LaneAbort = Extract<RecordingLaneFailure, { kind: 'stale-identity' | 'network' | 'timeout' }>;

/** Bearer + (when present) x-active-org-id, stamped in MAIN, plus the lane's Content-Type.
 * The SAME org-stamp discipline as the REST/Ask lanes; the id_token is never logged. */
const recordingHeaders = (
  identity: RequestIdentity,
  contentType: string
): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${identity.idToken}`,
    'Content-Type': contentType,
  };
  if (identity.activeOrgId !== undefined) headers['x-active-org-id'] = identity.activeOrgId;
  return headers;
};

/** A successful write must acknowledge the recording that the caller supplied. */
const parseRecordingId = (
  bodyJson: unknown,
  recordingId: string
): { readonly recordingId: string } => {
  const { result } = SyncWriteResponseSchema.parse(bodyJson);
  if (result.id !== recordingId) throw new Error('Invalid recording response');
  return { recordingId };
};

/** Only a valid empty result acknowledges silence; malformed replies remain retryable. */
const parseSegments = (bodyJson: unknown): readonly RecordingSegment[] =>
  TranscribeChunkResponseSchema.parse(bodyJson).results;

/**
 * Shared guarded-fetch → RecordingLaneResult mapping for all three recording-lane
 * methods. Resolves identity through `deps.resolveIdentity` — the SAME StaleSession
 * guard as `request`/`openAskStream` — and SHORT-CIRCUITS to a stale-identity result
 * BEFORE any fetch, so a switched-away session never puts a recording call on the wire
 * (never uploads under the wrong org). A completed 2xx → `parse(bodyJson)`; a non-2xx →
 * a classified http failure; network / timeout → transient failure. Never fails (E =
 * never) so the live pipeline and drain branch on data. The fetch rides the interrupt signal, so an
 * interrupted pipeline (sign-out / quit) aborts the in-flight upload.
 */
const runRecordingCall = <T>(
  deps: CloudBackendDeps,
  build: (identity: RequestIdentity) => {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string | Uint8Array;
  },
  parse: (bodyJson: unknown) => T,
  timeout = REQUEST_TIMEOUT
): Effect.Effect<RecordingLaneResult<T>> =>
  deps.resolveIdentity.pipe(
    // The guard runs FIRST: a stale/switched-away identity fails here, before fetch.
    Effect.mapError((): LaneAbort => ({ kind: 'stale-identity' })),
    Effect.flatMap(identity => {
      const spec = build(identity);
      return Effect.tryPromise({
        try: async signal => {
          const response = await deps.fetchFn(spec.url, {
            method: spec.method,
            headers: spec.headers,
            body: spec.body,
            signal,
          });
          if (response.ok) {
            try {
              return {
                ok: true,
                value: parse(await response.json()),
              } satisfies RecordingLaneResult<T>;
            } catch {
              return {
                ok: false,
                retryable: true,
                failure: { kind: 'invalid-response' },
              } satisfies RecordingLaneResult<T>;
            }
          }
          const bodyJson: unknown = await response.json().catch(() => null);
          const code = (bodyJson as { error?: { code?: unknown } } | null)?.error?.code;
          const retryAfterMs = response.status === 429
            ? recordingRetryAfterMs(
                (bodyJson as { error?: { details?: { retryAfterMs?: unknown } } } | null)
                  ?.error?.details?.retryAfterMs
              )
            : undefined;
          return {
            ok: false,
            retryable: isTransientStatus(response.status),
            failure: {
              kind: 'http',
              status: response.status,
              ...(typeof code === 'string' ? { code } : {}),
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            },
          } satisfies RecordingLaneResult<T>;
        },
        catch: (): LaneAbort => ({ kind: 'network' }),
      }).pipe(
        Effect.timeoutFail({
          duration: timeout,
          onTimeout: (): LaneAbort => ({ kind: 'timeout' }),
        })
      );
    }),
    // stale-identity / network / timeout are all transient.
    Effect.catchAll((abort: LaneAbort) =>
      Effect.succeed<RecordingLaneResult<T>>({ ok: false, retryable: true, failure: abort })
    ),
    // A defect (e.g. an unexpected body-read blowup) folds transient too — never throws.
    Effect.catchAllDefect(() =>
      Effect.succeed<RecordingLaneResult<T>>({
        ok: false,
        retryable: true,
        failure: { kind: 'network' },
      })
    )
  );

/** POST /apps/v1/me/recordings — client-minted id, captureMode, status:'recording' (JSON). */
export const makeCreateRecording =
  (deps: CloudBackendDeps) =>
  (
    input: CreateRecordingInput
  ): Effect.Effect<RecordingLaneResult<{ readonly recordingId: string }>> =>
    runRecordingCall(
      deps,
      identity => ({
        url: `${deps.coreApiUrl}${RECORDINGS_PATH}`,
        method: 'POST',
        headers: recordingHeaders(identity, 'application/json'),
        body: JSON.stringify({
          id: input.recordingId,
          title: input.title,
          captureMode: input.captureMode,
          status: 'recording',
          ...(input.noteId !== undefined ? { noteId: input.noteId } : {}),
          startedAt: input.startedAt,
          transcriptionConfig: input.transcriptionConfig ?? MANAGED_TRANSCRIPTION_CONFIG,
        }),
      }),
      bodyJson => parseRecordingId(bodyJson, input.recordingId)
    );

/**
 * POST /apps/v1/me/recordings/:id/transcribe?chunkIndex&chunkStartMs&source with the RAW
 * audio/wav BINARY body. Idempotent per (recordingId, chunkIndex) server-side, so a retry
 * of the same index is safe. Query values are stringified for the route's z.coerce params.
 */
export const makeUploadTranscriptionChunk =
  (deps: CloudBackendDeps) =>
  (
    recordingId: string,
    params: TranscribeChunkParams,
    wav: Uint8Array
  ): Effect.Effect<RecordingLaneResult<readonly RecordingSegment[]>> =>
    runRecordingCall(
      deps,
      identity => ({
        url: `${deps.coreApiUrl}${RECORDINGS_PATH}/${recordingId}/transcribe?${new URLSearchParams({
          chunkIndex: String(params.chunkIndex),
          chunkStartMs: String(Math.round(params.chunkStartMs)),
          source: params.source,
        }).toString()}`,
        method: 'POST',
        headers: recordingHeaders(identity, 'audio/wav'),
        body: wav,
      }),
      parseSegments,
      CHUNK_UPLOAD_TIMEOUT
    );

/** PUT /apps/v1/me/recordings/:id — the ONLY finalize signal (status→'completed'), JSON. */
export const makeFinalizeRecording =
  (deps: CloudBackendDeps) =>
  (
    recordingId: string,
    input: FinalizeRecordingInput
  ): Effect.Effect<RecordingLaneResult<{ readonly recordingId: string }>> =>
    runRecordingCall(
      deps,
      identity => ({
        url: `${deps.coreApiUrl}${RECORDINGS_PATH}/${recordingId}`,
        method: 'PUT',
        headers: recordingHeaders(identity, 'application/json'),
        body: JSON.stringify({
          status: 'completed',
          endedAt: input.endedAt,
          durationMs: input.durationMs,
        }),
      }),
      bodyJson => parseRecordingId(bodyJson, recordingId)
    );

export interface CloudBackendLiveOptions {
  /** Injected for tests; defaults to the ambient main-process fetch. */
  readonly fetchFn?: FetchLike;
}

/**
 * Session-scoped WorkspaceBackend. Build is INFALLIBLE — no fetch/token I/O here
 * (acquire failure would tear the whole session down, workspace-lifecycle.ts).
 * All work is lazy per request; the built client publishes itself into the
 * boot-scoped WorkspaceTransport for the session's lifetime.
 */
export const makeCloudBackendLive = (
  options: CloudBackendLiveOptions = {}
): Layer.Layer<
  WorkspaceBackend,
  never,
  SignedInSession | AppConfig | MainLogger | WorkspaceTransport | DesktopI18n
> =>
  Layer.scoped(
    WorkspaceBackend,
    Effect.gen(function* () {
      const session = yield* SignedInSession;
      const { locale } = yield* DesktopI18n;
      const config = yield* AppConfig;
      const coreTransport = yield* WorkspaceTransport;
      const fetchFn: FetchLike = options.fetchFn ?? desktopFetch;

      // Fresh per call: session.idToken runs the StaleSessionError guard then
      // delegates to AuthService.getIdToken; pinned.activeOrgId is constant for
      // the session (an org switch rebuilds it). Shared by the unary REST lane
      // and the Ask stream lane so both stamp the SAME guarded identity in MAIN.
      const resolveIdentity = session.idToken.pipe(
        Effect.map(idToken => ({ idToken, activeOrgId: session.pinned.activeOrgId }))
      );
      const deps: CloudBackendDeps = {
        coreApiUrl: config.endpoints.coreApiUrl,
        locale,
        fetchFn,
        resolveIdentity,
      };

      const api: WorkspaceBackendApi = {
        identity: session.pinned,
        request: makeWorkspaceBackendRequest(deps),
        openAskStream: makeOpenAskStream(deps),
        // The collab WSS bearer: exactly the guarded token — the same
        // StaleSessionError guard + single-flight refresh the request lane uses,
        // so a stale session can never mint one and the token is minted fresh
        // per (re)connect, never persisted (the one renderer-token crossing).
        collabToken: session.idToken,
        // The cloud recording lane: create → transcribe-chunk → finalize,
        // all built from the SAME `deps` (guarded id_token + active org resolved per
        // call), so token/org resolution + the StaleSession guard stay centralized in
        // main — the recording pipeline and the drain consume these.
        createRecording: makeCreateRecording(deps),
        uploadTranscriptionChunk: makeUploadTranscriptionChunk(deps),
        finalizeRecording: makeFinalizeRecording(deps),
      };

      yield* coreTransport.register(api);
      return api;
    })
  );

/** The default session-scoped WorkspaceBackend (ambient fetch). */
export const CloudBackendLive: Layer.Layer<
  WorkspaceBackend,
  never,
  SignedInSession | AppConfig | MainLogger | WorkspaceTransport | DesktopI18n
> = makeCloudBackendLive();

/**
 * The boot-scoped session-current accessor (a leaf: just the current-client
 * SubscriptionRef + dispatch). `register` is a scoped set/clear driven by the
 * session scope; `request` folds the signed-out case onto INTERNAL.
 */
export const WorkspaceTransportLive: Layer.Layer<WorkspaceTransport> = Layer.effect(
  WorkspaceTransport,
  Effect.gen(function* () {
    const currentRef = yield* SubscriptionRef.make<Option.Option<WorkspaceBackendApi>>(
      Option.none()
    );
    const api: WorkspaceTransportApi = {
      register: client =>
        Effect.acquireRelease(SubscriptionRef.set(currentRef, Option.some(client)), () =>
          // Compare-and-clear: only deregister if we are still the
          // current client. A slow old-session close (the disconnect + 5s-timeout
          // background-drain path in workspace-lifecycle's closeWorkspace) whose
          // release runs AFTER a successor session has already registered must
          // NOT clobber the live client to None — that would kill
          // transport/collab/Ask for a fully valid session until the next auth
          // change. This was harmless when session finalizers were a log line +
          // this set, far under 5s, but is load-bearing with slow session-scoped
          // teardown (recording pipeline / widget window / Hocuspocus disconnect).
          SubscriptionRef.update(currentRef, cur =>
            Option.exists(cur, c => c === client) ? Option.none() : cur
          )
        ).pipe(Effect.asVoid),
      current: SubscriptionRef.get(currentRef),
      request: (req, context) =>
        Effect.gen(function* () {
          if (context.mode === 'local') {
            const backend = yield* SubscriptionRef.get(currentRef);
            return yield* Option.match(backend, {
              onNone: () => Effect.succeed(INTERNAL),
              onSome: client => client.request(req),
            });
          }
          const { sessionState } = context;
          const identityOf = (state: AuthState): WorkspaceIdentity | undefined =>
            state.gate === 'signed-out' || state.activeSub === undefined
              ? undefined
              : state.accounts[state.activeSub];
          const expected = identityOf(yield* SubscriptionRef.get(sessionState));
          if (expected === undefined) return INTERNAL;
          const matches = (identity: WorkspaceIdentity | undefined): boolean =>
            identity?.sub === expected.sub && identity.activeOrgId === expected.activeOrgId;

          // Read both live values after either stream wakes us. Buffered auth or
          // registration events must never dispatch through a stale backend.
          const ready = yield* Stream.merge(
            currentRef.changes.pipe(Stream.map(() => undefined)),
            sessionState.changes.pipe(Stream.map(() => undefined))
          ).pipe(
            Stream.mapEffect(() =>
              Effect.gen(function* () {
                const active = identityOf(yield* SubscriptionRef.get(sessionState));
                const backend = yield* SubscriptionRef.get(currentRef);
                return {
                  active: matches(active),
                  backend: Option.filter(backend, client => matches(client.identity)),
                };
              })
            ),
            Stream.filter(state => !state.active || Option.isSome(state.backend)),
            Stream.runHead,
            Effect.timeoutOption(WORKSPACE_READY_TIMEOUT),
            Effect.map(Option.flatten),
            Effect.map(Option.flatMap(state => (state.active ? state.backend : Option.none())))
          );
          if (Option.isNone(ready)) return INTERNAL;

          // Dispatch once. A context change interrupts an in-flight exchange and
          // discards its result; a write can never be replayed in another org.
          return yield* Effect.raceFirst(
            ready.value.request(req),
            sessionState.changes.pipe(
              Stream.filter(state => !matches(identityOf(state))),
              Stream.runHead,
              Effect.as(INTERNAL)
            )
          );
        }),
      // The collab bearer: with no live session → None; otherwise the
      // guarded id_token, folding a stale/refresh failure to None too so the
      // handler answers null instead of throwing.
      collabToken: SubscriptionRef.get(currentRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<string>()),
            onSome: client =>
              client.collabToken.pipe(
                Effect.map(Option.some),
                Effect.catchAll(() => Effect.succeed(Option.none<string>()))
              ),
          })
        )
      ),
    };
    return api;
  })
);
