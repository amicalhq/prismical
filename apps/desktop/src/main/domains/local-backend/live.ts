/**
 * LocalBackendLive is the local-mode WorkspaceBackend: the /apps/v1/me dialect
 * served from the ProductDb instead of the server. Workspace-
 * scoped like CloudBackendLive and self-published into the boot-scoped
 * WorkspaceTransport the same way; the fallible part of mounting a local
 * workspace (opening local.db) lives in the ProductDb layer this one
 * consumes, so THIS build stays I/O-free.
 *
 * `request` honors the transport envelope contract exactly: EVERY completed
 * exchange — 404s/400s/409s included — maps to the `{ok,status,bodyJson}`
 * arm; the reserved `{error:{code:'INTERNAL'}}` arm is only ever produced by
 * an unexpected failure/defect (logged token-free, never thrown).
 *
 * The Ask lane is served here: openAskStream runs the local producer
 * (ask.ts) over AiProvider and returns the AI-SDK SSE Response the broker
 * forwards verbatim; collabToken fails AuthStateError (WorkspaceTransport
 * folds it to None, the renderer sees a null collab token). The recording
 * lane answers thin local acks — rows are persisted by the RecordingService
 * store and the on-device engines land the segments.
 *
 * Build does ONE piece of I/O: seeding the three system skills (an idempotent
 * upsert that never fails the layer — a seed failure is logged and the lanes
 * simply see no system rows until the next acquire).
 */
import { Effect, Layer } from 'effect';
import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';
import { MainLogger } from '../../infra/logging/service';
import { ProductDb, ProductDbError } from '../../infra/product-db/service';
import { AiProvider } from '../ai-provider/service';
import { AuthStateError } from '../auth/service';
import {
  AskStreamError,
  WorkspaceBackend,
  WorkspaceTransport,
  type RecordingLaneResult,
  type RecordingSegment,
  type WorkspaceBackendApi,
} from '../transport/service';
import { makeLocalAiPort } from './ai-port';
import { openLocalAskStream } from './ask';
import { handleLocalRequest, type LocalRouteContext } from './router';
import { seedSystemSkills } from './skills';
import { describeDbError } from './wire';

const INTERNAL: TransportResponse = { error: { code: 'INTERNAL' } };

/** The `{error:{code,message}}` / `{error:string}` envelope, flattened for a log line. */
const describeError = (body: unknown): string => {
  if (body === null || typeof body !== 'object') return String(body);
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [code, message].filter(v => typeof v === 'string').join(': ');
  }
  return 'unknown';
};

/** A promise-chain mutex: `work` runs after every previously queued call settles. */
const makeSerialLock = (): (<T>(work: () => Promise<T>) => Promise<T>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return work => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
};

/**
 * Workspace-scoped local WorkspaceBackend. Build is INFALLIBLE — the product
 * store is already open (or the workspace acquire failed before this layer
 * builds); all work is lazy per request. The built client publishes itself
 * into the boot-scoped WorkspaceTransport for the workspace's lifetime.
 */
export const LocalBackendLive: Layer.Layer<
  WorkspaceBackend,
  never,
  ProductDb | MainLogger | WorkspaceTransport | AiProvider
> = Layer.scoped(
  WorkspaceBackend,
  Effect.gen(function* () {
    const { db, client } = yield* ProductDb;
    const logger = yield* MainLogger;
    const log = logger.scoped('local-backend');
    const unsafeLog = logger.scopedUnsafe('local-backend');
    const coreTransport = yield* WorkspaceTransport;
    const aiProvider = yield* AiProvider;
    const runtime = yield* Effect.runtime<never>();

    const ctx: LocalRouteContext = {
      db,
      client,
      ai: makeLocalAiPort(aiProvider, runtime),
      log: (message, data) => unsafeLog.info(message, data),
      titleLock: makeSerialLock(),
    };

    // System skills: idempotent, never fatal — see the header.
    yield* Effect.tryPromise(() => seedSystemSkills(db)).pipe(
      Effect.catchAll(error =>
        log.error('system skill seed failed', { cause: describeDbError(error) })
      )
    );

    const request = (req: TransportRequest): Effect.Effect<TransportResponse> =>
      Effect.tryPromise({
        try: () => handleLocalRequest(ctx, req),
        catch: cause => new ProductDbError({ op: 'local-request', cause }),
      }).pipe(
        // A completed 4xx is a contract event worth seeing in main.log: the
        // method/path/status and the envelope's code+message only (never a
        // request body — titles and note text are user content).
        Effect.tap(result =>
          result.status >= 400 && req.method !== 'GET'
            ? log.debug('local backend rejected a write', {
                method: req.method,
                path: req.path,
                status: result.status,
                error: describeError(result.body),
              })
            : Effect.void
        ),
        Effect.map(
          (result): TransportResponse => ({ ok: true, status: result.status, bodyJson: result.body })
        ),
        // Token-free logging: only method/path + a stringified cause.
        Effect.catchAll(error =>
          log
            .error('local backend request failed', {
              method: req.method,
              path: req.path,
              cause: describeDbError(error.cause),
            })
            .pipe(Effect.as(INTERNAL))
        ),
        Effect.catchAllDefect(defect =>
          log
            .error('local backend request defect', {
              method: req.method,
              path: req.path,
              cause: describeDbError(defect),
            })
            .pipe(Effect.as(INTERNAL))
        )
      );

    const api: WorkspaceBackendApi = {
      request,
      // The local Ask producer: a failure to even open the stream folds to
      // the broker's typed connect error (a clean termination); provider and
      // request problems ride the stream as error parts instead.
      openAskStream: body =>
        Effect.tryPromise({
          // The signal-aware overload: interrupting the broker's producer
          // fiber (Stop, port close) aborts the model call instead of leaving
          // it running behind a Response nobody reads.
          try: signal => openLocalAskStream(ctx, body, signal),
          catch: () => new AskStreamError({ reason: 'connect' }),
        }).pipe(
          Effect.tapError(() => log.error('local ask stream could not open')),
          Effect.mapError(() => new AskStreamError({ reason: 'connect' }))
        ),
      collabToken: Effect.fail(new AuthStateError({ reason: 'no-active-account' })),
      createRecording: input =>
        Effect.succeed<RecordingLaneResult<{ readonly recordingId: string }>>({
          ok: true,
          value: { recordingId: input.recordingId },
        }),
      uploadTranscriptionChunk: () =>
        Effect.succeed<RecordingLaneResult<readonly RecordingSegment[]>>({
          ok: true,
          value: [],
        }),
      finalizeRecording: recordingId =>
        Effect.succeed<RecordingLaneResult<{ readonly recordingId: string }>>({
          ok: true,
          value: { recordingId },
        }),
      stageRecordingAudio: () =>
        Effect.succeed<RecordingLaneResult<{ readonly staged: boolean }>>({
          ok: true,
          value: { staged: false },
        }),
      abandonRecordingStaging: () =>
        Effect.succeed<RecordingLaneResult<void>>({ ok: true, value: undefined }),
    };

    yield* coreTransport.register(api);
    return api;
  })
);
