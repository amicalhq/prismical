/**
 * ByokTranscriberLive tests — the OpenAI-compatible lane
 * over a FAKE fetch + the in-memory SecureStore:
 *
 *  - unavailable endpoint-bound key → retryable; no base URL/model → not-configured, ONE warn
 *    per recording, nothing on the wire;
 *  - the near-silence guard acks [] without a request;
 *  - the multipart POST: {baseUrl}/audio/transcriptions, Bearer key, fields
 *    model / file (audio.wav, 16 kHz mono PCM16) / language / response_format;
 *  - 200 → one server-shaped segment; 429 / 5xx → retryable http; 4xx → not;
 *    network / timeout → retryable;
 *  - the deterministic replacement pass runs on the provider text over
 *    the workspace VocabularySource (local mode: ProductDb + usage bump;
 *    cloud mode: the server's /me/vocabulary + /me/team-vocabulary, no bump);
 *  - the key and the base URL never reach a log line.
 */
import { assert, describe, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Context, Duration, Effect, Exit, Fiber, Layer, Scope, TestClock } from 'effect';
import { parseWavHeader } from '@prismical/ai-prompts/transcription';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { makeFakeWorkspaceBackend } from '../helpers/fake-recording';
import { fakeSecureStoreLayer } from '../helpers/fake-workspace-env';
import { AppModeService, type AppMode } from '../../src/main/domains/app-mode/service';
import { CAPTURE_SAMPLE_RATE } from '../../src/main/domains/recording/chunker';
import { makeByokTranscriberLive } from '../../src/main/domains/transcriber/byok';
import { BYOK_API_KEY_SECRET, encodeByokCredential } from '../../src/main/domains/transcriber/byok-credential';
import type { RecordingEngine } from '../../src/main/domains/transcriber/engine';
import { ByokTranscriberLane, type ChunkAudio } from '../../src/main/domains/transcriber/service';
import type { FetchLike } from '../../src/main/domains/transport/live';
import type { TranscribeChunkParams } from '../../src/main/domains/transport/service';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb } from '../../src/main/infra/product-db/service';
import { SecureStore } from '../../src/main/infra/secure-store/service';

const KEY = 'sk-test-secret-key-value';
const BYOK: RecordingEngine = {
  engine: 'byok',
  modelId: 'whisper-base-en',
  byokBaseUrl: 'https://byok.test/v1/',
  byokModel: 'whisper-1',
};
const PARAMS: TranscribeChunkParams = { chunkIndex: 2, chunkStartMs: 10_000, source: 'system' };

const tone = (samples: number): Float32Array =>
  Float32Array.from({ length: samples }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
const chunk = (samples: Float32Array): ChunkAudio => ({ samples, sampleRate: CAPTURE_SAMPLE_RATE });

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: FormData;
  readonly signal?: AbortSignal;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const build = (options: { key?: string | null; mode?: AppMode } = {}) =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const fakeCloud = makeFakeWorkspaceBackend();
    const calls: FetchCall[] = [];
    let respond: () => Promise<Response> = () => Promise.resolve(jsonResponse({ text: '' }));
    const fetchFn: FetchLike = (url, init) => {
      calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body as FormData, signal: init.signal });
      return respond();
    };
    const scope = yield* Scope.make();
    const secure = fakeSecureStoreLayer();
    const productDb = makeProductDbLayer({ kind: 'local' }).pipe(
      Layer.provide(Layer.mergeAll(testConfigLayer(), logger.layer))
    );
    const ctx = yield* Layer.build(
      Layer.mergeAll(
        secure,
        productDb,
        makeByokTranscriberLive({ fetchFn }).pipe(
          Layer.provide(secure),
          Layer.provide(productDb),
          Layer.provide(Layer.succeed(AppModeService, { mode: options.mode ?? 'local', chosen: true })),
          Layer.provide(fakeCloud.layer),
          Layer.provide(logger.layer)
        )
      )
    ).pipe(Scope.extend(scope), Effect.orDie);
    const store = Context.get(ctx, SecureStore);
    const product = Context.get(ctx, ProductDb);
    const key = options.key === undefined ? KEY : options.key;
    if (key !== null) yield* store.setSecret(BYOK_API_KEY_SECRET, encodeByokCredential(BYOK.byokBaseUrl!, key));
    const seedVocabulary = (
      rows: ReadonlyArray<{ id: string; word: string; replacementWord?: string }>
    ) =>
      Effect.promise(() =>
        product.db.insert(schema.vocabulary).values(
          rows.map((row, i) => ({
            id: row.id,
            word: row.word,
            replacementWord: row.replacementWord ?? null,
            isReplacement: row.replacementWord !== undefined,
            createdAt: new Date(1_700_000_000_000 + i).toISOString(),
            updatedAt: new Date(1_700_000_000_000 + i).toISOString(),
            deletedAt: null,
          }))
        )
      );
    const usageCount = (id: string) =>
      Effect.promise(async () => {
        const rows = await product.db
          .select({ usageCount: schema.vocabulary.usageCount })
          .from(schema.vocabulary)
          .where(eq(schema.vocabulary.id, id));
        return rows[0]?.usageCount;
      });
    return {
      lane: Context.get(ctx, ByokTranscriberLane),
      store,
      calls,
      fakeCloud,
      logger,
      scope,
      seedVocabulary,
      usageCount,
      setResponder: (fn: () => Promise<Response>) => {
        respond = fn;
      },
    };
  });

describe('ByokTranscriberLive', () => {
  it.effect('retains work without sending a replacement provider key to the original endpoint', () =>
    Effect.gen(function* () {
      const h = yield* build();
      yield* h.store.setSecret(BYOK_API_KEY_SECRET, JSON.stringify({
        baseUrl: 'https://replacement.test/v1', key: 'replacement-key',
      }));
      const result = yield* h.lane.transcribeChunk('rec_original', PARAMS, chunk(tone(240_000)), BYOK);
      assert.deepStrictEqual(result, {
        ok: false, retryable: true, failure: { kind: 'engine', reason: 'not-configured' },
      });
      assert.strictEqual(h.calls.length, 0);
      const replacement = { ...BYOK, byokBaseUrl: 'https://replacement.test/v1/' };
      yield* h.lane.transcribeChunk('rec_replacement', PARAMS, chunk(tone(240_000)), replacement);
      assert.strictEqual(h.calls[0]?.url, 'https://replacement.test/v1/audio/transcriptions');
      assert.deepStrictEqual(h.calls[0]?.headers, { Authorization: 'Bearer replacement-key' });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('an unbound legacy key is retained but never sent to an inferred endpoint', () =>
    Effect.gen(function* () {
      const h = yield* build();
      yield* h.store.setSecret(BYOK_API_KEY_SECRET, KEY);
      assert.deepStrictEqual(yield* h.lane.transcribeChunk('rec_unbound', PARAMS, chunk(tone(240_000)), BYOK), {
        ok: false, retryable: true, failure: { kind: 'engine', reason: 'not-configured' },
      });
      assert.strictEqual(h.calls.length, 0);
      assert.strictEqual(yield* h.store.getSecret(BYOK_API_KEY_SECRET), KEY);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('malformed successful transcription responses retain the chunk for retry', () =>
    Effect.gen(function* () {
      const h = yield* build();
      for (const response of [new Response('{', { status: 200 }), jsonResponse({ unrelated: true })]) {
        h.setResponder(() => Promise.resolve(response));
        assert.deepStrictEqual(yield* h.lane.transcribeChunk('rec_json', PARAMS, chunk(tone(240_000)), BYOK), {
          ok: false, retryable: true, failure: { kind: 'invalid-response' },
        });
      }
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('the request deadline includes response consumption and aborts the request', () =>
    Effect.gen(function* () {
      const h = yield* build();
      h.setResponder(() => Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
      const task = yield* Effect.fork(h.lane.transcribeChunk('rec_body', PARAMS, chunk(tone(240_000)), BYOK));
      yield* TestClock.adjust(Duration.seconds(31));
      assert.deepStrictEqual(yield* Fiber.join(task), {
        ok: false, retryable: true, failure: { kind: 'timeout' },
      });
      assert.strictEqual(h.calls[0]?.signal?.aborted, true);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('no key → retryable not-configured, ONE warn per recording, nothing on the wire', () =>
    Effect.gen(function* () {
      const h = yield* build({ key: null });
      for (const index of [0, 1]) {
        const res = yield* h.lane.transcribeChunk('rec_a', { ...PARAMS, chunkIndex: index }, chunk(tone(240_000)), BYOK);
        assert.deepStrictEqual(res, {
          ok: false,
          retryable: true,
          failure: { kind: 'engine', reason: 'not-configured' },
        });
      }
      yield* h.lane.transcribeChunk('rec_b', PARAMS, chunk(tone(240_000)), BYOK);
      assert.strictEqual(h.calls.length, 0);
      const warns = h.logger.entries.filter(
        e => e.message === 'BYOK transcription credentials unavailable'
      );
      assert.deepStrictEqual(
        warns.map(w => w.data),
        [
          { recordingId: 'rec_a', hasKey: false, hasBaseUrl: true, hasModel: true },
          { recordingId: 'rec_b', hasKey: false, hasBaseUrl: true, hasModel: true },
        ]
      );
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a key without a base URL or model is not-configured too', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const noUrl = yield* h.lane.transcribeChunk('rec_u', PARAMS, chunk(tone(240_000)), { ...BYOK, byokBaseUrl: null });
      const noModel = yield* h.lane.transcribeChunk('rec_m', PARAMS, chunk(tone(240_000)), { ...BYOK, byokModel: '' });
      assert.deepStrictEqual(noUrl, { ok: false, retryable: false, failure: { kind: 'engine', reason: 'not-configured' } });
      assert.deepStrictEqual(noModel, { ok: false, retryable: false, failure: { kind: 'engine', reason: 'not-configured' } });
      assert.strictEqual(h.calls.length, 0);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('near-silence acks [] without a request', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const res = yield* h.lane.transcribeChunk('rec_q', PARAMS, chunk(new Float32Array(240_000)), BYOK);
      assert.deepStrictEqual(res, { ok: true, value: [] });
      assert.strictEqual(h.calls.length, 0);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('200: the multipart POST carries model / audio.wav (16 kHz mono PCM16) / language / response_format and mints ONE segment', () =>
    Effect.gen(function* () {
      const h = yield* build();
      h.setResponder(() => Promise.resolve(jsonResponse({ text: ' Understood, adjust the plan. ' })));
      const res = yield* h.lane.transcribeChunk('rec_1', PARAMS, chunk(tone(240_000)), BYOK);

      assert.strictEqual(h.calls.length, 1);
      const call = h.calls[0];
      assert.strictEqual(call.url, 'https://byok.test/v1/audio/transcriptions', 'trailing slash trimmed');
      assert.strictEqual(call.method, 'POST');
      assert.deepStrictEqual(call.headers, { Authorization: `Bearer ${KEY}` }, 'fetch sets the multipart Content-Type itself');
      assert.instanceOf(call.body, FormData);
      assert.strictEqual(call.body.get('model'), 'whisper-1');
      assert.strictEqual(call.body.get('language'), 'en');
      assert.strictEqual(call.body.get('response_format'), 'verbose_json');
      assert.strictEqual(call.body.get('temperature'), '0');
      assert.isNull(call.body.get('prompt'), 'no vocabulary source for this lane — omitted, not empty');
      const file = call.body.get('file');
      assert.instanceOf(file, File);
      const wavFile = file as File;
      assert.strictEqual(wavFile.name, 'audio.wav');
      assert.strictEqual(wavFile.type, 'audio/wav');
      const wav = parseWavHeader(Buffer.from(yield* Effect.promise(() => wavFile.arrayBuffer())));
      assert.deepStrictEqual(wav, {
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        dataBytes: 160_000,
        durationMs: 5_000,
      });

      assert.isTrue(res.ok);
      if (!res.ok) return;
      assert.strictEqual(res.value.length, 1);
      const segment = res.value[0];
      assert.match(segment.id, /^tsg_/);
      assert.strictEqual(segment.text, 'Understood, adjust the plan.');
      assert.strictEqual(segment.source, 'system');
      assert.strictEqual(segment.speaker, 'them');
      assert.strictEqual(segment.startTimeMs, 10_000);
      assert.strictEqual(segment.endTimeMs, 15_000);
      assert.strictEqual(segment.segmentOrder, 1_002_000);

      // An empty answer is a silent chunk.
      h.setResponder(() => Promise.resolve(jsonResponse({ text: '' })));
      assert.deepStrictEqual(yield* h.lane.transcribeChunk('rec_1', PARAMS, chunk(tone(240_000)), BYOK), { ok: true, value: [] });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('filters hallucinations before replacements and keeps genuine speech', () =>
    Effect.gen(function* () {
      const h = yield* build();
      yield* h.seedVocabulary([{ id: 'voc_noise', word: 'Thank you', replacementWord: 'Replaced noise' }]);
      const noise = { text: ' Thank you.', no_speech_prob: 0.7 };
      h.setResponder(() => Promise.resolve(jsonResponse({ text: 'Meet at noon. Thank you.', segments: [
        { text: ' Meet at noon.', no_speech_prob: 0.1 }, noise,
      ] })));
      const result = yield* h.lane.transcribeChunk('rec_filter', PARAMS, chunk(tone(240_000)), BYOK);
      assert.isTrue(result.ok);
      if (result.ok) assert.strictEqual(result.value[0]?.text, 'Meet at noon.');
      assert.strictEqual(yield* h.usageCount('voc_noise'), 0);
      h.setResponder(() => Promise.resolve(jsonResponse({ text: 'Thank you.', segments: [noise] })));
      assert.deepStrictEqual(yield* h.lane.transcribeChunk('rec_filter', PARAMS, chunk(tone(240_000)), BYOK), { ok: true, value: [] });
      assert.strictEqual(yield* h.usageCount('voc_noise'), 0);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('retains json format for models without Whisper verbose output', () =>
    Effect.gen(function* () {
      const h = yield* build();
      h.setResponder(() => Promise.resolve(jsonResponse({ text: 'Thank you.' })));
      const result = yield* h.lane.transcribeChunk('rec_json', PARAMS, chunk(tone(240_000)), { ...BYOK, byokModel: 'gpt-4o-transcribe' });
      assert.isTrue(result.ok);
      assert.strictEqual(h.calls[0]?.body.get('response_format'), 'json');
      assert.isNull(h.calls[0]?.body.get('temperature'));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('status mapping: 429 / 5xx retryable http; other 4xx permanent (code kept); network + timeout retryable', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const audio = chunk(tone(240_000));

      h.setResponder(() => Promise.resolve(jsonResponse({ error: { message: 'slow down' } }, 429)));
      assert.deepStrictEqual(yield* h.lane.transcribeChunk('rec_s', PARAMS, audio, BYOK), {
        ok: false,
        retryable: true,
        failure: { kind: 'http', status: 429 },
      });
      h.setResponder(() => Promise.resolve(new Response('bad gateway', { status: 502 })));
      assert.deepStrictEqual(yield* h.lane.transcribeChunk('rec_s', PARAMS, audio, BYOK), {
        ok: false,
        retryable: true,
        failure: { kind: 'http', status: 502 },
      });
      h.setResponder(() =>
        Promise.resolve(jsonResponse({ error: { message: 'prompt too long', code: 'invalid_request_error' } }, 400))
      );
      assert.deepStrictEqual(yield* h.lane.transcribeChunk('rec_s', PARAMS, audio, BYOK), {
        ok: false,
        retryable: false,
        failure: { kind: 'http', status: 400, code: 'invalid_request_error' },
      });
      h.setResponder(() => Promise.resolve(new Response(null, { status: 401 })));
      assert.deepStrictEqual(yield* h.lane.transcribeChunk('rec_s', PARAMS, audio, BYOK), {
        ok: false,
        retryable: false,
        failure: { kind: 'http', status: 401 },
      });
      h.setResponder(() => Promise.reject(new TypeError('fetch failed')));
      assert.deepStrictEqual(yield* h.lane.transcribeChunk('rec_s', PARAMS, audio, BYOK), {
        ok: false,
        retryable: true,
        failure: { kind: 'network' },
      });

      h.setResponder(() => new Promise(() => {}));
      const hung = yield* Effect.fork(h.lane.transcribeChunk('rec_s', PARAMS, audio, BYOK));
      yield* TestClock.adjust(Duration.seconds(31));
      assert.deepStrictEqual(yield* Fiber.join(hung), {
        ok: false,
        retryable: true,
        failure: { kind: 'timeout' },
      });

      const warns = h.logger.entries.filter(e => e.message === 'BYOK transcription chunk failed');
      assert.strictEqual(warns.length, 6);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('local mode: replacements from the ProductDb vocabulary are applied and usage_count bumps', () =>
    Effect.gen(function* () {
      const h = yield* build();
      yield* h.seedVocabulary([{ id: 'voc_r', word: 'road map', replacementWord: 'roadmap' }]);
      h.setResponder(() => Promise.resolve(jsonResponse({ text: ' The road map again. ' })));
      const res = yield* h.lane.transcribeChunk('rec_v', PARAMS, chunk(tone(240_000)), BYOK);
      assert.isTrue(res.ok);
      if (res.ok) assert.strictEqual(res.value[0]?.text, 'The roadmap again.');
      assert.strictEqual(yield* h.usageCount('voc_r'), 1);
      assert.strictEqual(
        h.fakeCloud.requestCalls.length,
        0,
        'local mode never fetches vocabulary from the server'
      );
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('cloud mode: terms fetched from the server once per recording, applied to provider text, no local bump', () =>
    Effect.gen(function* () {
      const h = yield* build({ mode: 'cloud' });
      h.fakeCloud.setRequestResponder(req => ({
        ok: true,
        status: 200,
        bodyJson: {
          success: true,
          results: req.path.endsWith('/team-vocabulary')
            ? []
            : [{ id: 'voc_c', word: 'road map', replacementWord: 'roadmap', isReplacement: true }],
        },
      }));
      h.setResponder(() => Promise.resolve(jsonResponse({ text: ' The road map twice. ' })));
      const first = yield* h.lane.transcribeChunk(
        'rec_c',
        { ...PARAMS, chunkIndex: 0 },
        chunk(tone(240_000)),
        BYOK
      );
      yield* h.lane.transcribeChunk('rec_c', { ...PARAMS, chunkIndex: 1 }, chunk(tone(240_000)), BYOK);
      assert.isTrue(first.ok);
      if (first.ok) assert.strictEqual(first.value[0]?.text, 'The roadmap twice.');
      assert.deepStrictEqual(
        h.fakeCloud.requestCalls.map(call => [call.method, call.path]),
        [
          ['GET', '/apps/v1/me/vocabulary'],
          ['GET', '/apps/v1/me/team-vocabulary'],
        ],
        'fetched once for the recording, then frozen'
      );
      // No local bump — the cloud cache table holds no such row to touch.
      assert.isUndefined(yield* h.usageCount('voc_c'));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('the key and the base URL never reach a log line', () =>
    Effect.gen(function* () {
      const h = yield* build();
      h.setResponder(() => Promise.resolve(jsonResponse({ error: { message: `bad key ${KEY}` } }, 401)));
      yield* h.lane.transcribeChunk('rec_l', PARAMS, chunk(tone(240_000)), BYOK);
      h.setResponder(() => Promise.resolve(jsonResponse({ text: 'ok' })));
      yield* h.lane.transcribeChunk('rec_l', PARAMS, chunk(tone(240_000)), BYOK);
      const dump = JSON.stringify(h.logger.entries);
      assert.isFalse(dump.includes(KEY));
      assert.isFalse(dump.includes('byok.test'));
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});
