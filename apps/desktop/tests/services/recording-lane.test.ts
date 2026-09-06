/**
 * Cloud recording lane — create, transcribe-chunk, and finalize.
 *
 * Pure-maker coverage with an injected FetchLike + resolveIdentity (no socket):
 *  - the exact wire mapping — method / path / query / Content-Type / body — for
 *    create (JSON), transcribe-chunk (RAW audio/wav BINARY), finalize (JSON);
 *  - Bearer + x-active-org-id stamped in MAIN (org-absent omission preserved);
 *  - idempotency params: a retried (recordingId, chunkIndex) builds the SAME URL;
 *  - the transient-vs-non-retryable classification the drain uses;
 *  - the StaleSession guard short-circuiting a stale/switched-away session BEFORE
 *    any fetch (never upload under the wrong org).
 * The boot↔session wiring (these makers built from the guarded session `deps`) is
 * proven in cloud-backend.test.ts's makeCloudWorkspaceLayer integration test.
 */
import { assert, describe, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Option, TestClock } from 'effect';
import {
  isTransientStatus,
  makeAbandonRecordingStaging,
  makeCreateRecording,
  makeFinalizeRecording,
  makeStageRecordingAudio,
  makeUploadTranscriptionChunk,
  MANAGED_TRANSCRIPTION_CONFIG,
  REQUEST_TIMEOUT,
  type CloudBackendDeps,
  type FetchLike,
  type RequestIdentity,
} from '../../src/main/domains/transport/live';
import type {
  CreateRecordingInput,
  FinalizeRecordingInput,
  TranscribeChunkParams,
} from '../../src/main/domains/transport/service';
import { AuthStateError } from '../../src/main/domains/auth/service';
import { StaleSessionError } from '../../src/main/runtime/workspace-layer';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array | FormData;
}

/** A FetchLike that records every call and returns a configurable Response. */
const recordingFetch = (respond: () => Promise<Response>) => {
  const calls: FetchCall[] = [];
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    return respond();
  };
  return { calls, fetchFn };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DEFAULT_IDENTITY: RequestIdentity = { idToken: 'ID-TOKEN', activeOrgId: 'org_9' };

/** Build CloudBackendDeps around an injected fetch + identity (or a failing identity). */
const makeDeps = (opts: {
  readonly fetchFn: FetchLike;
  readonly identity?: RequestIdentity;
  readonly resolveIdentity?: CloudBackendDeps['resolveIdentity'];
  readonly coreApiUrl?: string;
}): CloudBackendDeps => ({
  coreApiUrl: opts.coreApiUrl ?? 'https://core.test',
  fetchFn: opts.fetchFn,
  resolveIdentity: opts.resolveIdentity ?? Effect.succeed(opts.identity ?? DEFAULT_IDENTITY),
});

const CREATE_INPUT: CreateRecordingInput = {
  recordingId: 'rec_1',
  title: 'Standup',
  captureMode: 'dual',
  noteId: 'note_1',
  startedAt: 1_720_000_000_000,
};

const CHUNK_PARAMS: TranscribeChunkParams = { chunkIndex: 3, chunkStartMs: 45_000, source: 'system' };

const FINALIZE_INPUT: FinalizeRecordingInput = {
  endedAt: 1_720_000_090_000,
  durationMs: 90_000,
  stagingExpected: true,
  transcriptionDeferred: false,
};

const SEGMENT = {
  id: 'seg_1',
  recordingId: 'rec_1',
  source: 'system',
  speaker: 'you',
  text: 'hello team',
  startTimeMs: 45_000,
  endTimeMs: 60_000,
  segmentOrder: 1_003_000,
  orgUserId: 'org_user_1',
  isFinal: true,
  createdAt: '2024-07-03T09:46:40.000Z',
  updatedAt: '2024-07-03T09:46:40.000Z',
  deletedAt: null,
};

// ---------------------------------------------------------------------------
// createRecording — POST /apps/v1/me/recordings (JSON)
// ---------------------------------------------------------------------------

describe('makeCreateRecording', () => {
  it.effect('POSTs the create body with the client-minted id + managed config; stamps Bearer + org', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ result: { id: 'rec_1' }, applied: true }, 201))
      );
      const res = yield* makeCreateRecording(makeDeps({ fetchFn }))(CREATE_INPUT);

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].method, 'POST');
      assert.strictEqual(calls[0].url, 'https://core.test/apps/v1/me/recordings');
      assert.strictEqual(calls[0].headers['Authorization'], 'Bearer ID-TOKEN');
      assert.strictEqual(calls[0].headers['x-active-org-id'], 'org_9');
      assert.strictEqual(calls[0].headers['Content-Type'], 'application/json');
      // Order-independent body check (JSON key order is not part of the contract).
      assert.deepStrictEqual(JSON.parse(calls[0].body as string), {
        id: 'rec_1',
        title: 'Standup',
        captureMode: 'dual',
        status: 'recording',
        noteId: 'note_1',
        startedAt: 1_720_000_000_000,
        transcriptionConfig: MANAGED_TRANSCRIPTION_CONFIG,
      });
      assert.deepStrictEqual(res, { ok: true, value: { recordingId: 'rec_1' } });
    })
  );

  it.effect('sends an explicit transcriptionConfig verbatim as the frozen per-engine config', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ result: { id: 'rec_1' }, applied: true }, 201))
      );
      // What RecordingServiceLive freezes for a local-whisper recording — no instanceId.
      const local = { provider: 'local-whisper', model: 'whisper-base-en', language: 'en' };
      yield* makeCreateRecording(makeDeps({ fetchFn }))({ ...CREATE_INPUT, transcriptionConfig: local });

      const body = JSON.parse(calls[0].body as string) as { transcriptionConfig: unknown };
      assert.deepStrictEqual(body.transcriptionConfig, local);
      assert.notDeepEqual(body.transcriptionConfig, MANAGED_TRANSCRIPTION_CONFIG);
    })
  );

  it.effect('omits noteId when undefined and sends null for a standalone recording', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ result: { id: 'rec_1' }, applied: true }))
      );
      const deps = makeDeps({ fetchFn });

      const { noteId: _drop, ...noNote } = CREATE_INPUT;
      void _drop;
      yield* makeCreateRecording(deps)(noNote);
      assert.notProperty(JSON.parse(calls[0].body as string), 'noteId');

      yield* makeCreateRecording(deps)({ ...CREATE_INPUT, noteId: null });
      assert.strictEqual(JSON.parse(calls[1].body as string).noteId, null);
    })
  );

  it.effect('a BYOK transcriptionConfig overrides the managed default', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ result: { id: 'rec_1' }, applied: true }))
      );
      const byok = { provider: 'byok', model: 'my-model', language: 'en', instanceId: 'inst_1', modelId: 'my-model' };
      yield* makeCreateRecording(makeDeps({ fetchFn }))({ ...CREATE_INPUT, transcriptionConfig: byok });
      assert.deepStrictEqual(JSON.parse(calls[0].body as string).transcriptionConfig, byok);
    })
  );

  it.effect('OMITS x-active-org-id when no active org (server resolves default)', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ result: { id: 'rec_1' }, applied: true }))
      );
      yield* makeCreateRecording(makeDeps({ fetchFn, identity: { idToken: 'T', activeOrgId: undefined } }))(
        CREATE_INPUT
      );
      assert.strictEqual(calls[0].headers['Authorization'], 'Bearer T');
      assert.notProperty(calls[0].headers, 'x-active-org-id');
    })
  );

  it.effect('rejects a write that does not acknowledge the requested recording', () =>
    Effect.gen(function* () {
      for (const body of [{}, { result: {}, applied: true }, { result: { id: 'rec_other' }, applied: true }]) {
        const { fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse(body)));
        const res = yield* makeCreateRecording(makeDeps({ fetchFn }))(CREATE_INPUT);
        assert.deepStrictEqual(res, {
          ok: false, retryable: true, failure: { kind: 'invalid-response' },
        });
      }
    })
  );

  it.effect('a stale identity short-circuits BEFORE any fetch → transient stale-identity', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse({})));
      const res = yield* makeCreateRecording(
        makeDeps({
          fetchFn,
          resolveIdentity: Effect.fail(new StaleSessionError({ pinnedSub: 'user_1', reason: 'org-switched' })),
        })
      )(CREATE_INPUT);
      assert.deepStrictEqual(res, { ok: false, retryable: true, failure: { kind: 'stale-identity' } });
      assert.strictEqual(calls.length, 0, 'no create goes out under a stale session');
    })
  );

  it.effect('a 5xx → transient http; a 422 → non-retryable http', () =>
    Effect.gen(function* () {
      const five = yield* makeCreateRecording(
        makeDeps({ fetchFn: recordingFetch(() => Promise.resolve(jsonResponse({}, 503))).fetchFn })
      )(CREATE_INPUT);
      assert.deepStrictEqual(five, { ok: false, retryable: true, failure: { kind: 'http', status: 503 } });

      const unproc = yield* makeCreateRecording(
        makeDeps({ fetchFn: recordingFetch(() => Promise.resolve(jsonResponse({}, 422))).fetchFn })
      )(CREATE_INPUT);
      assert.deepStrictEqual(unproc, { ok: false, retryable: false, failure: { kind: 'http', status: 422 } });
    })
  );
});

// ---------------------------------------------------------------------------
// uploadTranscriptionChunk — POST …/transcribe (RAW audio/wav)
// ---------------------------------------------------------------------------

describe('makeUploadTranscriptionChunk', () => {
  it.effect('POSTs the transcribe URL + query with the RAW audio/wav body; returns the segments', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ success: true, results: [SEGMENT] }))
      );
      const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
      const res = yield* makeUploadTranscriptionChunk(makeDeps({ fetchFn }))('rec_1', CHUNK_PARAMS, wav);

      assert.strictEqual(calls[0].method, 'POST');
      assert.strictEqual(
        calls[0].url,
        'https://core.test/apps/v1/me/recordings/rec_1/transcribe?chunkIndex=3&chunkStartMs=45000&source=system'
      );
      assert.strictEqual(calls[0].headers['Authorization'], 'Bearer ID-TOKEN');
      assert.strictEqual(calls[0].headers['x-active-org-id'], 'org_9');
      assert.strictEqual(calls[0].headers['Content-Type'], 'audio/wav');
      // No SSE Accept — this is a plain binary POST, not the Ask stream.
      assert.notProperty(calls[0].headers, 'Accept');
      // The RAW bytes are sent verbatim (no JSON.stringify) — same instance.
      assert.strictEqual(calls[0].body, wav);
      assert.deepStrictEqual(res, { ok: true, value: [SEGMENT] });
    })
  );

  it.effect('rounds a fractional chunkStartMs (mirrors the web path)', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ success: true, results: [] }))
      );
      yield* makeUploadTranscriptionChunk(makeDeps({ fetchFn }))(
        'rec_1',
        { chunkIndex: 0, chunkStartMs: 45_000.6, source: 'mic' },
        new Uint8Array([1])
      );
      assert.strictEqual(
        calls[0].url,
        'https://core.test/apps/v1/me/recordings/rec_1/transcribe?chunkIndex=0&chunkStartMs=45001&source=mic'
      );
    })
  );

  it.effect('a silent chunk (empty results) resolves ok with []', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse({ success: true, results: [] })));
      const res = yield* makeUploadTranscriptionChunk(makeDeps({ fetchFn }))(
        'rec_1',
        CHUNK_PARAMS,
        new Uint8Array([1])
      );
      assert.deepStrictEqual(res, { ok: true, value: [] });
    })
  );

  it.effect('a retry of the SAME (recordingId, chunkIndex) builds the same idempotent URL', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ success: true, results: [] }))
      );
      const upload = makeUploadTranscriptionChunk(makeDeps({ fetchFn }));
      yield* upload('rec_1', CHUNK_PARAMS, new Uint8Array([1]));
      yield* upload('rec_1', CHUNK_PARAMS, new Uint8Array([2]));
      assert.strictEqual(calls[0].url, calls[1].url, 'same idempotency key → same window server-side');
    })
  );

  it.effect('a stale identity never uploads (guard short-circuit before fetch)', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse({})));
      const res = yield* makeUploadTranscriptionChunk(
        makeDeps({
          fetchFn,
          resolveIdentity: Effect.fail(new StaleSessionError({ pinnedSub: 'user_1', reason: 'account-switched' })),
        })
      )('rec_1', CHUNK_PARAMS, new Uint8Array([1, 2, 3]));
      assert.deepStrictEqual(res, { ok: false, retryable: true, failure: { kind: 'stale-identity' } });
      assert.strictEqual(calls.length, 0, 'no WAV bytes leave under a stale session');
    })
  );

  it.effect('a network failure → transient network', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() => Promise.reject(new Error('ECONNRESET')));
      const res = yield* makeUploadTranscriptionChunk(makeDeps({ fetchFn }))(
        'rec_1',
        CHUNK_PARAMS,
        new Uint8Array([1])
      );
      assert.deepStrictEqual(res, { ok: false, retryable: true, failure: { kind: 'network' } });
    })
  );

  it.effect('a hung upload trips the 15s budget → transient timeout', () =>
    Effect.gen(function* () {
      const { fetchFn } = recordingFetch(() => new Promise<Response>(() => {}));
      const fiber = yield* Effect.fork(
        makeUploadTranscriptionChunk(makeDeps({ fetchFn }))('rec_1', CHUNK_PARAMS, new Uint8Array([1]))
      );
      yield* TestClock.adjust(REQUEST_TIMEOUT);
      const res = yield* Fiber.join(fiber);
      assert.deepStrictEqual(res, { ok: false, retryable: true, failure: { kind: 'timeout' } });
    })
  );

  for (const status of [200, 503]) {
    it.effect(`a stalled ${status} response body times out and aborts the connection`, () =>
      Effect.gen(function* () {
        const readingBody = yield* Deferred.make<void>();
        let signal: AbortSignal | undefined;
        const response = new Response(null, { status });
        response.json = () => {
          Deferred.unsafeDone(readingBody, Effect.void);
          return new Promise(() => {});
        };
        const fiber = yield* Effect.fork(
          makeUploadTranscriptionChunk(makeDeps({
            fetchFn: (_url, init) => {
              signal = init.signal;
              return Promise.resolve(response);
            },
          }))('rec_1', CHUNK_PARAMS, new Uint8Array([1]))
        );
        yield* Deferred.await(readingBody);
        yield* TestClock.adjust(REQUEST_TIMEOUT);
        assert.isTrue(Option.isSome(yield* Fiber.poll(fiber)), 'the body shares the request deadline');
        assert.deepStrictEqual(yield* Fiber.join(fiber), {
          ok: false, retryable: true, failure: { kind: 'timeout' },
        });
        assert.isTrue(signal?.aborted);
      })
    );
  }

  it.effect('interrupting a response body aborts the connection', () =>
    Effect.gen(function* () {
      const readingBody = yield* Deferred.make<void>();
      let signal: AbortSignal | undefined;
      const response = new Response();
      response.json = () => {
        Deferred.unsafeDone(readingBody, Effect.void);
        return new Promise(() => {});
      };
      const fiber = yield* Effect.fork(
        makeUploadTranscriptionChunk(makeDeps({
          fetchFn: (_url, init) => {
            signal = init.signal;
            return Promise.resolve(response);
          },
        }))('rec_1', CHUNK_PARAMS, new Uint8Array([1]))
      );
      yield* Deferred.await(readingBody);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(signal?.aborted);
    })
  );

  it.effect('rejects truncated JSON and invalid transcript envelopes without acknowledging silence', () =>
    Effect.gen(function* () {
      for (const body of ['{"results":[', '{}', '{"results":[{"text":"incomplete"}]}']) {
        const result = yield* makeUploadTranscriptionChunk(makeDeps({
          fetchFn: () => Promise.resolve(new Response(body)),
        }))('rec_1', CHUNK_PARAMS, new Uint8Array([1]));
        assert.deepStrictEqual(result, {
          ok: false, retryable: true, failure: { kind: 'invalid-response' },
        });
      }
    })
  );

  it.effect('classifies transcribe error codes: 429/502 transient, 404/422 non-retryable', () =>
    Effect.gen(function* () {
      const call = (status: number) =>
        makeUploadTranscriptionChunk(
          makeDeps({ fetchFn: recordingFetch(() => Promise.resolve(jsonResponse({}, status))).fetchFn })
        )('rec_1', CHUNK_PARAMS, new Uint8Array([1]));

      assert.deepStrictEqual(yield* call(429), { ok: false, retryable: true, failure: { kind: 'http', status: 429 } });
      assert.deepStrictEqual(yield* call(502), { ok: false, retryable: true, failure: { kind: 'http', status: 502 } });
      assert.deepStrictEqual(yield* call(404), { ok: false, retryable: false, failure: { kind: 'http', status: 404 } });
      assert.deepStrictEqual(yield* call(422), { ok: false, retryable: false, failure: { kind: 'http', status: 422 } });
      const coded = yield* makeUploadTranscriptionChunk(
        makeDeps({
          fetchFn: recordingFetch(() =>
            Promise.resolve(
              jsonResponse(
                { error: { code: 'STAGING_FINALIZATION_INTENT_MISSING' } },
                503
              )
            )
          ).fetchFn,
        })
      )('rec_1', CHUNK_PARAMS, new Uint8Array([1]));
      assert.deepStrictEqual(coded, {
        ok: false,
        retryable: true,
        failure: {
          kind: 'http',
          status: 503,
          code: 'STAGING_FINALIZATION_INTENT_MISSING',
        },
      });
    })
  );
});

// ---------------------------------------------------------------------------
// finalizeRecording — PUT /apps/v1/me/recordings/:id (JSON)
// ---------------------------------------------------------------------------

describe('makeFinalizeRecording', () => {
  it.effect('PUTs status:completed + endedAt + durationMs; stamps Bearer + org; returns the id', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ result: { id: 'rec_1' }, applied: true }))
      );
      const res = yield* makeFinalizeRecording(makeDeps({ fetchFn }))('rec_1', FINALIZE_INPUT);

      assert.strictEqual(calls[0].method, 'PUT');
      assert.strictEqual(calls[0].url, 'https://core.test/apps/v1/me/recordings/rec_1');
      assert.strictEqual(calls[0].headers['Authorization'], 'Bearer ID-TOKEN');
      assert.strictEqual(calls[0].headers['x-active-org-id'], 'org_9');
      assert.strictEqual(calls[0].headers['Content-Type'], 'application/json');
      assert.deepStrictEqual(JSON.parse(calls[0].body as string), {
        status: 'completed',
        endedAt: 1_720_000_090_000,
        durationMs: 90_000,
        stagingExpected: true,
        transcriptionDeferred: false,
      });
      assert.deepStrictEqual(res, { ok: true, value: { recordingId: 'rec_1' } });
    })
  );

  it.effect('a stale identity short-circuits before fetch', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() => Promise.resolve(jsonResponse({})));
      const res = yield* makeFinalizeRecording(
        makeDeps({ fetchFn, resolveIdentity: Effect.fail(new AuthStateError({ reason: 'no-active-account' })) })
      )('rec_1', FINALIZE_INPUT);
      assert.deepStrictEqual(res, { ok: false, retryable: true, failure: { kind: 'stale-identity' } });
      assert.strictEqual(calls.length, 0);
    })
  );

  it.effect('a 5xx → transient; a 410 → non-retryable', () =>
    Effect.gen(function* () {
      const five = yield* makeFinalizeRecording(
        makeDeps({ fetchFn: recordingFetch(() => Promise.resolve(jsonResponse({}, 500))).fetchFn })
      )('rec_1', FINALIZE_INPUT);
      assert.deepStrictEqual(five, { ok: false, retryable: true, failure: { kind: 'http', status: 500 } });

      const gone = yield* makeFinalizeRecording(
        makeDeps({ fetchFn: recordingFetch(() => Promise.resolve(jsonResponse({}, 410))).fetchFn })
      )('rec_1', FINALIZE_INPUT);
      assert.deepStrictEqual(gone, { ok: false, retryable: false, failure: { kind: 'http', status: 410 } });
    })
  );
});

describe('makeAbandonRecordingStaging', () => {
  it.effect('POSTs the terminal staging reason through the guarded recording lane', () =>
    Effect.gen(function* () {
      const { calls, fetchFn } = recordingFetch(() =>
        Promise.resolve(jsonResponse({ status: 'skipped', recordingId: 'rec_1' }))
      );
      const res = yield* makeAbandonRecordingStaging(makeDeps({ fetchFn }))(
        'rec_1',
        'upload-gave-up'
      );

      assert.strictEqual(calls[0].method, 'POST');
      assert.strictEqual(
        calls[0].url,
        'https://core.test/apps/v1/me/recordings/rec_1/staging/abandon'
      );
      assert.deepStrictEqual(JSON.parse(calls[0].body as string), {
        reason: 'upload-gave-up',
      });
      assert.deepStrictEqual(res, { ok: true, value: undefined });
    })
  );
});

describe('makeStageRecordingAudio', () => {
  const lanes = [{ lane: 'mic' as const, contentType: 'audio/wav', data: new Uint8Array([1]) }];
  const minted = {
    uploads: [{ lane: 'mic', objectName: 'recordings/rec_1/mic.wav', url: 'https://staging.test/mic', headers: {} }],
    expiresAt: '2026-09-06T12:00:00.000Z',
  };

  it.effect('accepts staging only after a valid completion acknowledgement', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* makeStageRecordingAudio(makeDeps({
        fetchFn: (url, init) => {
          calls.push(init.method);
          return Promise.resolve(url.endsWith('/staging/urls')
            ? jsonResponse(minted)
            : init.method === 'PUT'
              ? new Response(null, { status: 200 })
              : jsonResponse({ status: 'staged', recordingId: 'rec_1' }));
        },
      }))('rec_1', lanes);
      assert.deepStrictEqual(result, { ok: true, value: { staged: true } });
      assert.deepStrictEqual(calls, ['POST', 'PUT', 'POST']);
    })
  );

  it.effect('retains audio when a mint omits its lane or completion has no acknowledgement', () =>
    Effect.gen(function* () {
      for (const missingLane of [true, false]) {
        const result = yield* makeStageRecordingAudio(makeDeps({
          fetchFn: (url, init) => Promise.resolve(url.endsWith('/staging/urls')
            ? jsonResponse(missingLane ? { ...minted, uploads: [] } : minted)
            : init.method === 'PUT' ? new Response() : jsonResponse({})),
        }))('rec_1', lanes);
        assert.deepStrictEqual(result, {
          ok: false, retryable: true, failure: { kind: 'invalid-response' },
        });
      }
    })
  );
});

// ---------------------------------------------------------------------------
// isTransientStatus — the drain's retry classifier
// ---------------------------------------------------------------------------

describe('isTransientStatus', () => {
  it('429 and every 5xx are transient (retry with backoff)', () => {
    for (const s of [429, 500, 502, 503, 504]) assert.isTrue(isTransientStatus(s), `${s}`);
  });

  it('404 / 410 / 422 and the other deterministic 4xx are NOT retryable', () => {
    for (const s of [400, 401, 402, 403, 404, 410, 415, 422]) assert.isFalse(isTransientStatus(s), `${s}`);
  });
});
