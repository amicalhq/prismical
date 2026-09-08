import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';
import { Context, Data, type Effect, type Option, type Scope, type SubscriptionRef } from 'effect';
import type { AuthStateError, RefreshError } from '../auth/service';
import type { AuthState } from '../auth/policy';
import type { StaleSessionError } from '../../runtime/workspace-layer';

/**
 * The Ask streaming lane failed to open: either no guarded identity
 * resolved (stale/dropped session — the StaleSessionError guard short-circuits
 * BEFORE any fetch) or the POST to core never connected. The broker folds both
 * onto a clean stream termination (it never throws at the renderer); the reason
 * distinguishes them for the (token-free) log. `openAskStream` never fails with
 * anything richer — the id_token is stamped into the request, never surfaced.
 */
export class AskStreamError extends Data.TaggedError('AskStreamError')<{
  readonly reason: 'no-identity' | 'connect';
}> {}

// ---------------------------------------------------------------------------
// Cloud recording lane: create → transcribe-chunk → finalize
// ---------------------------------------------------------------------------

/**
 * One transcript segment exactly as the transcribe-chunk endpoint returns it
 * (the persisted `transcript_segment` row). The server writes ONE per non-empty
 * chunk (a silent/empty chunk yields none), so a chunk upload resolves with 0-or-1
 * segment. Same wire shape web reads back; defined desktop-side so MAIN takes no
 * @prismical/app-contracts dependency for the recording lane (web stays byte-identical).
 */
export interface RecordingSegment {
  readonly id: string;
  readonly recordingId: string;
  readonly source: string;
  readonly speaker: string;
  readonly text: string;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly segmentOrder: number;
}

/**
 * Why a recording-lane call did not succeed — drives the drain retry/give-up:
 *  - `stale-identity`  the SignedInSession guard short-circuited BEFORE any fetch
 *                      (a switched-away session never uploads) — transient.
 *  - `network`         the fetch rejected (offline / DNS / reset) — transient.
 *  - `timeout`         exceeded the 15s budget — transient (a premature timeout on a
 *                      chunk is safe: the retry is idempotent per (recordingId,chunkIndex)).
 *  - `invalid-response` the successful response could not be decoded or validated;
 *                      retain the pending work because acknowledgement is unknown.
 *  - `http`            a completed non-2xx exchange; `status` decides retryable and an API error
 *                      `code` is retained when present for safety-critical recovery decisions.
 *  - `engine`          an on-device transcription engine failed (the local
 *                      whisper worker or the BYOK lane); `reason` names the cause. The lane
 *                      decides `retryable` per reason (a crashed/timed-out worker re-sends via
 *                      the drain; a decode failure loses only that chunk's text). Chunk-lane
 *                      only.
 */
export type RecordingLaneFailure =
  | { readonly kind: 'stale-identity' }
  | { readonly kind: 'network' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'invalid-response' }
  | {
      readonly kind: 'http';
      readonly status: number;
      readonly code?: string;
      /** Bounded provider cooldown; retained across capture and durable recovery. */
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: 'engine';
      readonly reason:
        | 'model-missing'
        | 'worker-crashed'
        | 'inference-failed'
        | 'timeout'
        | 'not-configured';
    };

/**
 * A recording-lane call outcome. The Effect NEVER fails (E = never) — every error
 * folds here so the live pipeline and drain branch on data, not exceptions. `retryable` classifies the
 * failure for the drain: transient (network / timeout / 429 / 5xx / stale-identity)
 * ⇒ bump attempt_count + next_attempt_at and retry; non-retryable (404 / 410 / 422
 * and every other deterministic 4xx) ⇒ set the outbox row `status:'failed'`.
 */
export type RecordingLaneResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly retryable: boolean; readonly failure: RecordingLaneFailure };

/**
 * Create-body inputs. The caller MINTS `recordingId` (@prismical/id) — it is the
 * create/finalize idempotency key and the recovery-outbox primary key. Times
 * are caller-supplied epoch ms (from the Clock) so the method reads no wall clock.
 */
export interface CreateRecordingInput {
  readonly recordingId: string;
  readonly title: string;
  readonly captureMode: 'mic' | 'system' | 'dual';
  /** Owning note's cloud id (WRITE-checked server-side), null for standalone, or omitted. */
  readonly noteId?: string | null;
  /** Recording start, epoch ms. */
  readonly startedAt: number;
  /** Frozen-at-create transcription config; omitted ⇒ managed cloud transcription (see live.ts). */
  readonly transcriptionConfig?: Record<string, unknown>;
}

/**
 * Per-chunk transcribe params. `source` is mic|system (a DUAL recording uploads each
 * source separately, each carrying its own `source`); it maps to the segment's `source`.
 */
export interface TranscribeChunkParams {
  readonly chunkIndex: number;
  readonly chunkStartMs: number;
  readonly source: 'mic' | 'system';
}

/**
 * Finalize inputs. `status:'completed'` is stamped by the method — the ONLY finalize
 * signal (→ recording.transcribed); the caller supplies the Clock-derived end + duration.
 */
export interface FinalizeRecordingInput {
  readonly endedAt: number;
  readonly durationMs: number;
}

/** The account and organization that own a cloud workspace. */
export interface WorkspaceIdentity {
  readonly sub: string;
  readonly activeOrgId?: string;
}

/**
 * The main-owned CloudTransport client. Built per signed-in
 * session (session-scoped: `Layer.provide(session)` at workspace-layer.ts) so
 * it reads identity/tokens EXCLUSIVELY through SignedInSession — every request
 * resolves a fresh guarded id_token + the session's active org and stamps them
 * in main (the renderer never learns the server address or a token).
 *
 * `request` never fails: any completed HTTP exchange (incl. 4xx/5xx, status
 * carried through so the renderer's toApiError/onUnauthorized fire) maps to the
 * `{ok,status,bodyJson}` arm; network/timeout/stale-identity/thrown map to the
 * reserved `{error:{code:'INTERNAL'}}` arm.
 */
export interface WorkspaceBackendApi {
  /** Cloud backend ownership; absent for the accountless local backend. */
  readonly identity?: WorkspaceIdentity;
  readonly request: (req: TransportRequest) => Effect.Effect<TransportResponse>;
  /**
   * Open the real Ask stream: resolve a guarded id_token + the
   * session's active org, `POST ${coreApiUrl}/apps/v1/me/ask` stamping Bearer +
   * x-active-org-id in MAIN, and hand back the raw SSE `Response` so the broker
   * forwards core's `toUIMessageStreamResponse()` bytes VERBATIM across the port
   * (no chunk-vocabulary translation — web hits the same SSE directly). The
   * fetch rides the Effect's interrupt signal, so an interrupted producer (abort
   * / port close) aborts the connection and core sees the client drop. A stale
   * identity fails `AskStreamError('no-identity')` before the request goes out.
   */
  readonly openAskStream: (body: unknown) => Effect.Effect<Response, AskStreamError>;
  /**
   * The current session's guarded id_token for the collab WSS bearer (the one
   * sanctioned full-token crossing to the renderer). Exactly
   * SignedInSession.idToken: it runs the same StaleSessionError guard as
   * `request`, so a zombie session can never mint a collab token, and delegates
   * to AuthService.getIdToken (transparent single-flight refresh inside the
   * expiry skew). Yields ONLY the id_token — never the refresh/access token.
   */
  readonly collabToken: Effect.Effect<string, StaleSessionError | RefreshError | AuthStateError>;
  /**
   * Create the cloud recording — `POST /apps/v1/me/recordings` with the
   * client-minted id + captureMode, resolving the SAME guarded id_token + active
   * org as `request` and stamping them in MAIN. JSON body; idempotent on the
   * minted id (LWW upsert). Never fails: the outcome is a RecordingLaneResult the
   * pipeline branches on. Returns the recording id on success.
   */
  readonly createRecording: (
    input: CreateRecordingInput
  ) => Effect.Effect<RecordingLaneResult<{ readonly recordingId: string }>>;
  /**
   * Upload one WAV chunk — `POST /apps/v1/me/recordings/:id/
   * transcribe?chunkIndex&chunkStartMs&source` with the RAW `audio/wav` BINARY body
   * (the non-JSON lane), Bearer + x-active-org-id stamped in MAIN through the SAME
   * StaleSession guard — a stale session fails BEFORE the upload, never under the
   * wrong org. The server transcribes in-flight and persists one segment per
   * non-empty chunk; those segments come back here. Idempotent per (recordingId,
   * chunkIndex). Never fails (RecordingLaneResult).
   */
  readonly uploadTranscriptionChunk: (
    recordingId: string,
    params: TranscribeChunkParams,
    wav: Uint8Array
  ) => Effect.Effect<RecordingLaneResult<readonly RecordingSegment[]>>;
  /**
   * Finalize the recording — `PUT /apps/v1/me/recordings/:id` with
   * `{status:'completed', endedAt, durationMs}`. The status→'completed' transition
   * is the ONLY finalize signal (fires recording.transcribed → automations /
   * auto-enhance). Same guarded identity + org stamped in MAIN. Never fails.
   */
  readonly finalizeRecording: (
    recordingId: string,
    input: FinalizeRecordingInput
  ) => Effect.Effect<RecordingLaneResult<{ readonly recordingId: string }>>;
}

export class WorkspaceBackend extends Context.Tag('desktop/WorkspaceBackend')<
  WorkspaceBackend,
  WorkspaceBackendApi
>() {}

export type WorkspaceRequestContext =
  | { readonly mode: 'local' }
  | { readonly mode: 'cloud'; readonly sessionState: SubscriptionRef.SubscriptionRef<AuthState> };

/**
 * The boot-scoped workspace-current backend accessor — the load-bearing
 * boot↔workspace bridge: "which backend is mounted", not "is there a session".
 * The workspace-scoped
 * WorkspaceBackend publishes itself here on acquire and clears on release (via
 * `register`, a scoped set/clear), so the boot-scoped IPC handler (and, in
 * the StreamBroker) reach the current workspace's backend without owning
 * the workspace scope. In cloud mode the StaleSessionError guard is preserved
 * because the published backend resolves identity through SignedInSession per
 * request. Unary cloud requests wait for the selected workspace during a swap;
 * signed-out requests settle gracefully instead of throwing.
 */
export interface WorkspaceTransportApi {
  /**
   * Workspace-scoped: publish `client` as the current workspace's
   * WorkspaceBackend for the enclosing Scope; the finalizer clears it. The
   * lifecycle closes the old workspace scope FULLY before building the next,
   * so at most one backend is ever current and a torn-down workspace leaves
   * `None`.
   */
  readonly register: (client: WorkspaceBackendApi) => Effect.Effect<void, never, Scope.Scope>;
  /** The current workspace's backend, or None when unmounted / mid-swap. */
  readonly current: Effect.Effect<Option.Option<WorkspaceBackendApi>>;
  /**
   * Unary dispatch used by every renderer API hook. In cloud mode, wait for
   * the backend matching the request's starting identity. A further switch or
   * sign-out cancels the request; HTTP exchanges are never replayed.
   */
  readonly request: (
    req: TransportRequest,
    context: WorkspaceRequestContext
  ) => Effect.Effect<TransportResponse>;
  /**
   * The collab WSS bearer for auth:getCollabToken: resolve the
   * current cloud workspace's guarded id_token, or None when no backend is
   * mounted / mid-swap / the guard fails / a refresh failed. Never fails —
   * every no-token outcome folds to None so the handler answers null (the ONE
   * sanctioned full-token crossing).
   */
  readonly collabToken: Effect.Effect<Option.Option<string>>;
}

export class WorkspaceTransport extends Context.Tag('desktop/WorkspaceTransport')<
  WorkspaceTransport,
  WorkspaceTransportApi
>() {}
