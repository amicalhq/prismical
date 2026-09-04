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
import { Duration, Effect, Layer, Option, SubscriptionRef } from 'effect';
import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import type { AuthStateError, RefreshError } from '../auth/service';
import { SignedInSession, type StaleSessionError } from '../../runtime/workspace-layer';
import {
  AskStreamError,
  WorkspaceBackend,
  WorkspaceTransport,
  type WorkspaceBackendApi,
  type WorkspaceTransportApi,
  type CreateRecordingInput,
  type FinalizeRecordingInput,
  type RecordingLaneFailure,
  type RecordingLaneResult,
  type RecordingSegment,
  type StageLaneInput,
  type StagingAbandonReason,
  type TranscribeChunkParams,
} from './service';

/** Unary request budget — mirrors auth's TOKEN_REQUEST_TIMEOUT. */
export const REQUEST_TIMEOUT = Duration.seconds(15);

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
 * the fetch; the ambient default is the main-process global fetch (TLS over
 * portless relies on process-level NODE_EXTRA_CA_CERTS — no per-request TLS).
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
const askHeaders = (identity: RequestIdentity): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${identity.idToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
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
  (body: unknown): Effect.Effect<Response, AskStreamError> =>
    deps.resolveIdentity.pipe(
      Effect.mapError(() => new AskStreamError({ reason: 'no-identity' })),
      Effect.flatMap(identity =>
        Effect.tryPromise({
          try: signal =>
            deps.fetchFn(`${deps.coreApiUrl}${ASK_PATH}`, {
              method: 'POST',
              headers: askHeaders(identity),
              body: JSON.stringify(body ?? {}),
              signal,
            }),
          catch: () => new AskStreamError({ reason: 'connect' }),
        })
      )
    );

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
        const fetchResponse = Effect.tryPromise({
          try: signal =>
            deps.fetchFn(url, {
              method: req.method,
              headers,
              ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
              signal,
            }),
          catch: cause => ({ kind: 'network' as const, cause }),
        }).pipe(
          Effect.timeoutFail({
            duration: REQUEST_TIMEOUT,
            onTimeout: () => ({ kind: 'timeout' as const }),
          })
        );
        return fetchResponse.pipe(
          // Any completed exchange (2xx/4xx/5xx) → {ok,status,bodyJson}. Body
          // read is best-effort: a non-JSON/empty body settles as null but the
          // status is still carried through (renderer's toApiError/onUnauthorized).
          Effect.flatMap(response =>
            Effect.promise(() =>
              response.json().then(
                (json: unknown) => json,
                () => null
              )
            ).pipe(
              Effect.map(
                (bodyJson): TransportResponse => ({ ok: true, status: response.status, bodyJson })
              )
            )
          )
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

/** create/finalize echo `{ success, result:<row> }`; we only need the id back, falling back to
 * the client-minted id (authoritative) if the echoed row's id is absent. */
const parseRecordingId = (bodyJson: unknown, fallback: string): { readonly recordingId: string } => {
  const result = (bodyJson as { result?: { id?: unknown } } | null)?.result;
  return { recordingId: typeof result?.id === 'string' ? result.id : fallback };
};

/** transcribe echoes `{ success, results:<segments> }` — one segment per non-empty chunk,
 * none for silence. Cast (not zod-validated), matching web's `json.results ?? []`. */
const parseSegments = (bodyJson: unknown): readonly RecordingSegment[] => {
  const results = (bodyJson as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? (results as RecordingSegment[]) : [];
};

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
  parse: (bodyJson: unknown) => T
): Effect.Effect<RecordingLaneResult<T>> =>
  deps.resolveIdentity.pipe(
    // The guard runs FIRST: a stale/switched-away identity fails here, before fetch.
    Effect.mapError((): LaneAbort => ({ kind: 'stale-identity' })),
    Effect.flatMap(identity => {
      const spec = build(identity);
      return Effect.tryPromise({
        try: signal =>
          deps.fetchFn(spec.url, {
            method: spec.method,
            headers: spec.headers,
            body: spec.body,
            signal,
          }),
        catch: (): LaneAbort => ({ kind: 'network' }),
      }).pipe(
        Effect.timeoutFail({
          duration: REQUEST_TIMEOUT,
          onTimeout: (): LaneAbort => ({ kind: 'timeout' }),
        })
      );
    }),
    Effect.flatMap(response =>
      response.ok
        ? Effect.promise(() =>
            response.json().then(
              (json: unknown) => json,
              () => null
            )
          ).pipe(Effect.map((bodyJson): RecordingLaneResult<T> => ({ ok: true, value: parse(bodyJson) })))
        : Effect.promise(() =>
            response.json().then(
              (json: unknown) => json,
              () => null
            )
          ).pipe(
            Effect.map((bodyJson): RecordingLaneResult<T> => {
              const code = (bodyJson as { error?: { code?: unknown } } | null)?.error?.code;
              return {
                ok: false,
                retryable: isTransientStatus(response.status),
                failure: {
                  kind: 'http',
                  status: response.status,
                  ...(typeof code === 'string' ? { code } : {}),
                },
              };
            })
          )
    ),
    // stale-identity / network / timeout are all transient.
    Effect.catchAll((abort: LaneAbort) =>
      Effect.succeed<RecordingLaneResult<T>>({ ok: false, retryable: true, failure: abort })
    ),
    // A defect (e.g. an unexpected body-read blowup) folds transient too — never throws.
    Effect.catchAllDefect(() =>
      Effect.succeed<RecordingLaneResult<T>>({ ok: false, retryable: true, failure: { kind: 'network' } })
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
        url: `${deps.coreApiUrl}${RECORDINGS_PATH}/${recordingId}/transcribe?${new URLSearchParams(
          {
            chunkIndex: String(params.chunkIndex),
            chunkStartMs: String(Math.round(params.chunkStartMs)),
            source: params.source,
          }
        ).toString()}`,
        method: 'POST',
        headers: recordingHeaders(identity, 'audio/wav'),
        body: wav,
      }),
      parseSegments
    );

/**
 * Full-session staged uploads use a timeout scaled to the payload size, bounded
 * between 2 and 60 minutes so slow uplinks have sufficient headroom.
 */
const stagingUploadTimeout = (bytes: number): Duration.Duration =>
  Duration.minutes(Math.min(60, Math.max(2, Math.ceil(bytes / (25 * 1024 * 1024)))));

interface MintedStagingUpload {
  readonly lane: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** Tolerant parse of the staging/urls flat envelope — a shape mismatch yields []. */
const parseStagingUploads = (bodyJson: unknown): readonly MintedStagingUpload[] => {
  const uploads = (bodyJson as { uploads?: unknown } | null)?.uploads;
  if (!Array.isArray(uploads)) return [];
  return uploads.flatMap((u: unknown): MintedStagingUpload[] => {
    const c = u as { lane?: unknown; url?: unknown; headers?: unknown };
    return typeof c.lane === 'string' && typeof c.url === 'string'
      ? [{ lane: c.lane, url: c.url, headers: (c.headers ?? {}) as Record<string, string> }]
      : [];
  });
};

/** One signed-URL PUT → RecordingLaneResult. No identity: the V4 signature IS the auth. */
const putToSignedUrl = (
  deps: CloudBackendDeps,
  upload: MintedStagingUpload,
  data: Uint8Array
): Effect.Effect<RecordingLaneResult<void>> =>
  Effect.tryPromise({
    try: signal =>
      deps.fetchFn(upload.url, { method: 'PUT', headers: upload.headers, body: data, signal }),
    catch: (): LaneAbort => ({ kind: 'network' }),
  }).pipe(
    Effect.timeoutFail({ duration: stagingUploadTimeout(data.length), onTimeout: (): LaneAbort => ({ kind: 'timeout' }) }),
    Effect.map(
      (response): RecordingLaneResult<void> =>
        response.ok
          ? { ok: true, value: undefined }
          : {
              ok: false,
              retryable: isTransientStatus(response.status),
              failure: { kind: 'http', status: response.status },
            }
    ),
    Effect.catchAll((abort: LaneAbort) =>
      Effect.succeed<RecordingLaneResult<void>>({ ok: false, retryable: true, failure: abort })
    ),
    Effect.catchAllDefect(() =>
      Effect.succeed<RecordingLaneResult<void>>({ ok: false, retryable: true, failure: { kind: 'network' } })
    )
  );

/**
 * The staging composite: mint → per-lane signed PUT → complete. Server hops go
 * through runRecordingCall (guarded identity); the bucket PUT does not. A 409 on mint means
 * staging is disabled for this org — mapped to `{staged:false}` success so callers delete the
 * local artifact exactly as before the feature existed.
 */
export const makeStageRecordingAudio =
  (deps: CloudBackendDeps) =>
  (
    recordingId: string,
    lanes: readonly StageLaneInput[]
  ): Effect.Effect<RecordingLaneResult<{ readonly staged: boolean }>> =>
    Effect.gen(function* () {
      const mint = yield* runRecordingCall(
        deps,
        identity => ({
          url: `${deps.coreApiUrl}${RECORDINGS_PATH}/${recordingId}/staging/urls`,
          method: 'POST',
          headers: recordingHeaders(identity, 'application/json'),
          body: JSON.stringify({ lanes: lanes.map(l => ({ lane: l.lane, contentType: l.contentType })) }),
        }),
        parseStagingUploads
      );
      if (!mint.ok) {
        return mint.failure.kind === 'http' && mint.failure.status === 409
          ? { ok: true as const, value: { staged: false } }
          : mint;
      }
      for (const lane of lanes) {
        const upload = mint.value.find(u => u.lane === lane.lane);
        if (!upload) {
          // Server answered without this lane — deterministic contract mismatch, not retryable.
          return {
            ok: false as const,
            retryable: false,
            failure: { kind: 'http' as const, status: 502 },
          };
        }
        const put = yield* putToSignedUrl(deps, upload, lane.data);
        if (!put.ok) return put;
      }
      return yield* runRecordingCall(
        deps,
        identity => ({
          url: `${deps.coreApiUrl}${RECORDINGS_PATH}/${recordingId}/staging/complete`,
          method: 'POST',
          headers: recordingHeaders(identity, 'application/json'),
          body: JSON.stringify({
            lanes: lanes.map(l => ({
              lane: l.lane,
              contentType: l.contentType,
              ...(l.durationMs !== undefined ? { durationMs: Math.round(l.durationMs) } : {}),
            })),
          }),
        }),
        (): { staged: boolean } => ({ staged: true })
      );
    });

export const makeAbandonRecordingStaging =
  (deps: CloudBackendDeps) =>
  (recordingId: string, reason: StagingAbandonReason): Effect.Effect<RecordingLaneResult<void>> =>
    runRecordingCall(
      deps,
      identity => ({
        url: `${deps.coreApiUrl}${RECORDINGS_PATH}/${recordingId}/staging/abandon`,
        method: 'POST',
        headers: recordingHeaders(identity, 'application/json'),
        body: JSON.stringify({ reason }),
      }),
      () => undefined
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
          stagingExpected: input.stagingExpected,
          transcriptionDeferred: input.transcriptionDeferred,
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
): Layer.Layer<WorkspaceBackend, never, SignedInSession | AppConfig | MainLogger | WorkspaceTransport> =>
  Layer.scoped(
    WorkspaceBackend,
    Effect.gen(function* () {
      const session = yield* SignedInSession;
      const config = yield* AppConfig;
      const coreTransport = yield* WorkspaceTransport;
      const fetchFn: FetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));

      // Fresh per call: session.idToken runs the StaleSessionError guard then
      // delegates to AuthService.getIdToken; pinned.activeOrgId is constant for
      // the session (an org switch rebuilds it). Shared by the unary REST lane
      // and the Ask stream lane so both stamp the SAME guarded identity in MAIN.
      const resolveIdentity = session.idToken.pipe(
        Effect.map(idToken => ({ idToken, activeOrgId: session.pinned.activeOrgId }))
      );
      const deps: CloudBackendDeps = {
        coreApiUrl: config.endpoints.coreApiUrl,
        fetchFn,
        resolveIdentity,
      };

      const api: WorkspaceBackendApi = {
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
        stageRecordingAudio: makeStageRecordingAudio(deps),
        abandonRecordingStaging: makeAbandonRecordingStaging(deps),
      };

      yield* coreTransport.register(api);
      return api;
    })
  );

/** The default session-scoped WorkspaceBackend (ambient fetch). */
export const CloudBackendLive: Layer.Layer<
  WorkspaceBackend,
  never,
  SignedInSession | AppConfig | MainLogger | WorkspaceTransport
> = makeCloudBackendLive();

/**
 * The boot-scoped session-current accessor (a leaf: just the current-client
 * SubscriptionRef + dispatch). `register` is a scoped set/clear driven by the
 * session scope; `request` folds the signed-out case onto INTERNAL.
 */
export const WorkspaceTransportLive: Layer.Layer<WorkspaceTransport> = Layer.effect(
  WorkspaceTransport,
  Effect.gen(function* () {
    const currentRef = yield* SubscriptionRef.make<Option.Option<WorkspaceBackendApi>>(Option.none());
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
      request: req =>
        SubscriptionRef.get(currentRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(INTERNAL),
              onSome: client => client.request(req),
            })
          )
        ),
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
