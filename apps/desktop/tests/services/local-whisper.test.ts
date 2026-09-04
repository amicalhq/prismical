/**
 * LocalWhisperLive tests — the on-device lane over a
 * FAKE WhisperEngine + fake ModelManager + a real in-memory ProductDb (the
 * vocabulary table). No sidecar, no worker, no model file.
 *
 *  - the near-silence guard acks [] without touching the engine;
 *  - a missing model acks [] with ONE warn per recording;
 *  - the happy path mints exactly the server-shaped segment from the worker's text,
 *    sends the frozen decode options and 16 kHz audio (240 000 → 80 000);
 *  - installed VAD weights append only `vad: true, vad_model_path`;
 *  - resampler continuity per (recording, source) lane;
 *  - the prompt carries the vocabulary targets + the previous chunk's tail (per lane);
 *  - replacements applied + usage_count bumped for hits;
 *  - in cloud mode the terms come from the server's /me/vocabulary and
 *    /me/team-vocabulary through the WorkspaceBackend (once per recording,
 *    personal-first merge, failures fold to empty, NO usage bump);
 *  - engine failures map: crash / spawn / timeout → retryable, inference → not.
 */
import { assert, describe, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { makeFakeWorkspaceBackend } from '../helpers/fake-recording';
import { fakeModelManagerLayer, makeFakeWhisperEngine } from '../helpers/fake-workspace-env';
import { AppModeService, type AppMode } from '../../src/main/domains/app-mode/service';
import { CAPTURE_SAMPLE_RATE } from '../../src/main/domains/recording/chunker';
import { VAD_MODEL_ID } from '../../src/main/domains/models/catalogue';
import { SILENCE_PEAK_FLOAT } from '../../src/main/domains/transcriber/audio';
import type { RecordingEngine } from '../../src/main/domains/transcriber/engine';
import {
  ENGINE_BREAKER_THRESHOLD,
  LocalWhisperLive,
  localDecodeOptions,
} from '../../src/main/domains/transcriber/local';
import { LocalTranscriberLane, type ChunkAudio } from '../../src/main/domains/transcriber/service';
import type { TranscribeChunkParams } from '../../src/main/domains/transport/service';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb } from '../../src/main/infra/product-db/service';
import { WhisperEngineError } from '../../src/main/infra/whisper/service';

const MODEL_PATH = '/models/ggml-base.en.bin';
const VAD_PATH = '/models/ggml-silero-v5.1.2.bin';
const LOCAL: RecordingEngine = {
  engine: 'local',
  modelId: 'whisper-base-en',
  byokBaseUrl: null,
  byokModel: null,
};
const PARAMS: TranscribeChunkParams = { chunkIndex: 3, chunkStartMs: 15_000, source: 'mic' };

/** A clearly audible chunk: a 440 Hz tone at 0.3 amplitude. */
const tone = (samples: number): Float32Array =>
  Float32Array.from({ length: samples }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
const chunk = (samples: Float32Array): ChunkAudio => ({ samples, sampleRate: CAPTURE_SAMPLE_RATE });

const build = (
  installed: Record<string, string> = { 'whisper-base-en': MODEL_PATH },
  mode: AppMode = 'local'
) =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const whisper = makeFakeWhisperEngine();
    const fakeCloud = makeFakeWorkspaceBackend();
    const scope = yield* Scope.make();
    const env = Layer.mergeAll(testConfigLayer(), logger.layer);
    const productDb = makeProductDbLayer({ kind: 'local' });
    const ctx = yield* Layer.build(
      Layer.mergeAll(
        productDb,
        LocalWhisperLive.pipe(
          Layer.provide(productDb),
          Layer.provide(whisper.layer),
          Layer.provide(fakeModelManagerLayer(installed)),
          Layer.provide(Layer.succeed(AppModeService, { mode, chosen: true })),
          Layer.provide(fakeCloud.layer)
        )
      ).pipe(Layer.provide(env))
    ).pipe(Scope.extend(scope), Effect.orDie);
    const product = Context.get(ctx, ProductDb);
    const seedVocabulary = (
      rows: ReadonlyArray<{ id: string; word: string; replacementWord?: string; deleted?: boolean }>
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
            deletedAt: row.deleted ? new Date().toISOString() : null,
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
      lane: Context.get(ctx, LocalTranscriberLane),
      whisper,
      fakeCloud,
      logger,
      scope,
      seedVocabulary,
      usageCount,
    };
  });

const FROZEN_OPTIONS = {
  language: 'en',
  initial_prompt: '',
  suppress_blank: true,
  suppress_non_speech_tokens: true,
  no_timestamps: false,
};

describe('LocalWhisperLive', () => {
  it('localDecodeOptions has the fixed five options, plus only the VAD pair when weights are installed', () => {
    assert.deepStrictEqual(localDecodeOptions(undefined), FROZEN_OPTIONS);
    assert.deepStrictEqual(localDecodeOptions('Prismical'), {
      ...FROZEN_OPTIONS,
      initial_prompt: 'Prismical',
    });
    // With the VAD weights: `vad` + `vad_model_path` and NOTHING else — every
    // other `vad_*` knob keeps whisper-cli's defaults inside the addon.
    assert.deepStrictEqual(localDecodeOptions(undefined, VAD_PATH), {
      ...FROZEN_OPTIONS,
      vad: true,
      vad_model_path: VAD_PATH,
    });
  });

  it.effect('near-silence acks [] without touching the engine (the server’s 330/32767 guard)', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const quiet = new Float32Array(240_000).fill(SILENCE_PEAK_FLOAT * 0.9);
      quiet[100] = -SILENCE_PEAK_FLOAT * 0.99;
      const res = yield* h.lane.transcribeChunk('rec_q', PARAMS, chunk(quiet), LOCAL);
      assert.deepStrictEqual(res, { ok: true, value: [] });
      assert.strictEqual(h.whisper.ensureCalls.length, 0);
      assert.strictEqual(h.whisper.transcribeCalls.length, 0);
      // One sample over the threshold is audible (float32 storage rounds the
      // exact 330/32767 down a hair, so "at" the double threshold is below it).
      const audible = new Float32Array(240_000);
      audible[7] = SILENCE_PEAK_FLOAT * 1.01;
      yield* h.lane.transcribeChunk('rec_q', PARAMS, chunk(audible), LOCAL);
      assert.strictEqual(h.whisper.transcribeCalls.length, 1);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a missing model acks [] for every chunk with ONE warn per recording; the engine is never touched', () =>
    Effect.gen(function* () {
      const h = yield* build({});
      for (const index of [0, 1]) {
        const res = yield* h.lane.transcribeChunk(
          'rec_a',
          { ...PARAMS, chunkIndex: index },
          chunk(tone(240_000)),
          LOCAL
        );
        assert.deepStrictEqual(res, { ok: true, value: [] });
      }
      yield* h.lane.transcribeChunk('rec_b', PARAMS, chunk(tone(240_000)), LOCAL);
      const warns = h.logger.entries.filter(
        e => e.scope === 'transcriber' && e.message === 'local whisper model not installed — chunks ack empty'
      );
      assert.deepStrictEqual(
        warns.map(w => w.data),
        [
          { recordingId: 'rec_a', modelId: 'whisper-base-en' },
          { recordingId: 'rec_b', modelId: 'whisper-base-en' },
        ]
      );
      assert.strictEqual(h.whisper.ensureCalls.length, 0);
      assert.strictEqual(h.whisper.transcribeCalls.length, 0);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('happy path: ensureModel(installed path) → transcribe(16 kHz, frozen options) → ONE server-shaped segment', () =>
    Effect.gen(function* () {
      const h = yield* build();
      h.whisper.setTranscribeResponder(() => ({
        text: ' Hello team, welcome.',
        segments: [{ text: ' Hello team, welcome.', from: 0, to: 2_100 }],
      }));
      const res = yield* h.lane.transcribeChunk('rec_1', PARAMS, chunk(tone(240_000)), LOCAL);
      assert.deepStrictEqual(h.whisper.ensureCalls, [MODEL_PATH]);
      assert.strictEqual(h.whisper.transcribeCalls.length, 1);
      const call = h.whisper.transcribeCalls[0];
      assert.strictEqual(call.audio16k.length, 80_000, '240 000 @ 48 kHz → 80 000 @ 16 kHz');
      // No VAD weights installed ⇒ exactly the frozen five, no vad keys.
      assert.deepStrictEqual(call.options, FROZEN_OPTIONS);

      assert.isTrue(res.ok);
      if (!res.ok) return;
      assert.strictEqual(res.value.length, 1);
      const segment = res.value[0] as (typeof res.value)[number] & {
        isFinal: boolean;
        createdAt: string;
        updatedAt: string;
        deletedAt: null;
      };
      assert.match(segment.id, /^tsg_/);
      assert.strictEqual(segment.recordingId, 'rec_1');
      assert.strictEqual(segment.source, 'mic');
      assert.strictEqual(segment.speaker, 'you');
      assert.strictEqual(segment.text, 'Hello team, welcome.');
      assert.strictEqual(segment.startTimeMs, 15_000);
      assert.strictEqual(segment.endTimeMs, 20_000);
      assert.strictEqual(segment.segmentOrder, 1_003_000);
      assert.strictEqual(segment.isFinal, true);
      assert.strictEqual(segment.createdAt, segment.updatedAt);
      assert.isNull(segment.deletedAt);
      assert.strictEqual(
        h.fakeCloud.requestCalls.length,
        0,
        'local mode never fetches vocabulary from the server'
      );

      // Blank worker text → [] (a silent-but-audible chunk, like the server).
      h.whisper.setTranscribeResponder(() => ({ text: '   ', segments: [] }));
      const blank = yield* h.lane.transcribeChunk(
        'rec_1',
        { ...PARAMS, chunkIndex: 4 },
        chunk(tone(240_000)),
        LOCAL
      );
      assert.deepStrictEqual(blank, { ok: true, value: [] });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('installed VAD weights ride into the decode options — the sha1-verified path only (the SIGABRT defense)', () =>
    Effect.gen(function* () {
      const h = yield* build({ 'whisper-base-en': MODEL_PATH, [VAD_MODEL_ID]: VAD_PATH });
      h.whisper.setTranscribeResponder(() => ({ text: ' Hi there.', segments: [] }));
      const res = yield* h.lane.transcribeChunk('rec_vad', PARAMS, chunk(tone(240_000)), LOCAL);
      assert.isTrue(res.ok);
      // The frozen five plus the vad pair and NOTHING else; the path is the
      // ModelManager's installedPath answer (only ever a SHA-1-verified file —
      // a non-Silero ggml as vad_model_path would ABORT the worker process).
      assert.deepStrictEqual(h.whisper.transcribeCalls[0]?.options, {
        ...FROZEN_OPTIONS,
        vad: true,
        vad_model_path: VAD_PATH,
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('the resampler is continuous per (recording, source): full chunks → 80 000, a 1 s tail → 16 000; a system chunk of the same recording has its own', () =>
    Effect.gen(function* () {
      const h = yield* build();
      for (const index of [0, 1]) {
        yield* h.lane.transcribeChunk(
          'rec_r',
          { chunkIndex: index, chunkStartMs: index * 5_000, source: 'mic' },
          chunk(tone(240_000)),
          LOCAL
        );
      }
      yield* h.lane.transcribeChunk(
        'rec_r',
        { chunkIndex: 2, chunkStartMs: 10_000, source: 'mic' },
        chunk(tone(48_000)),
        LOCAL
      );
      yield* h.lane.transcribeChunk(
        'rec_r',
        { chunkIndex: 3, chunkStartMs: 0, source: 'system' },
        chunk(tone(48_000)),
        LOCAL
      );
      assert.deepStrictEqual(
        h.whisper.transcribeCalls.map(c => c.audio16k.length),
        [80_000, 80_000, 16_000, 16_000]
      );
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('the prompt carries the vocabulary targets first and the previous chunk’s tail last — per lane; deleted rows are ignored', () =>
    Effect.gen(function* () {
      const h = yield* build();
      yield* h.seedVocabulary([
        { id: 'voc_1', word: 'Prismical' },
        { id: 'voc_2', word: 'road map', replacementWord: 'roadmap' },
        { id: 'voc_3', word: 'ghost', deleted: true },
        { id: 'voc_4', word: '   ' },
      ]);
      h.whisper.setTranscribeResponder(() => ({
        text: ' Yes, the timeline looks tight.',
        segments: [],
      }));
      yield* h.lane.transcribeChunk(
        'rec_p',
        { chunkIndex: 0, chunkStartMs: 0, source: 'mic' },
        chunk(tone(240_000)),
        LOCAL
      );
      yield* h.lane.transcribeChunk(
        'rec_p',
        { chunkIndex: 1, chunkStartMs: 5_000, source: 'mic' },
        chunk(tone(240_000)),
        LOCAL
      );
      // The system lane of the SAME recording starts without the mic lane's tail.
      yield* h.lane.transcribeChunk(
        'rec_p',
        { chunkIndex: 2, chunkStartMs: 0, source: 'system' },
        chunk(tone(240_000)),
        LOCAL
      );
      assert.deepStrictEqual(
        h.whisper.transcribeCalls.map(c => c.options.initial_prompt),
        [
          'Prismical, roadmap',
          'Prismical, roadmap. Yes, the timeline looks tight.',
          'Prismical, roadmap',
        ]
      );
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('replacements are applied to the worker text and usage_count is bumped for the rules that fired', () =>
    Effect.gen(function* () {
      const h = yield* build();
      yield* h.seedVocabulary([
        { id: 'voc_r', word: 'road map', replacementWord: 'roadmap' },
        { id: 'voc_t', word: 'time line', replacementWord: 'timeline' },
      ]);
      h.whisper.setTranscribeResponder(() => ({
        text: " Let's review the road map. The Road Map again.",
        segments: [],
      }));
      const res = yield* h.lane.transcribeChunk('rec_v', PARAMS, chunk(tone(240_000)), LOCAL);
      assert.isTrue(res.ok);
      if (!res.ok) return;
      assert.strictEqual(res.value[0]?.text, "Let's review the roadmap. The Roadmap again.");
      assert.strictEqual(yield* h.usageCount('voc_r'), 2);
      assert.strictEqual(yield* h.usageCount('voc_t'), 0, 'a rule that did not fire is not a use');
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('engine failures: spawn/crash/timeout are retryable engine failures; a decode error is not', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const cases = [
        { reason: 'worker-crashed', retryable: true, mapped: 'worker-crashed' },
        { reason: 'spawn-failed', retryable: true, mapped: 'worker-crashed' },
        { reason: 'timeout', retryable: true, mapped: 'timeout' },
        { reason: 'inference-failed', retryable: false, mapped: 'inference-failed' },
      ] as const;
      for (const [i, c] of cases.entries()) {
        h.whisper.setTranscribeResponder(
          () => new WhisperEngineError({ reason: c.reason, detail: `d-${c.reason}` })
        );
        // One recording per case: consecutive transient failures on a single
        // recording would correctly open the engine breaker — this test pins
        // the raw failure MAPPING, not the breaker.
        const res = yield* h.lane.transcribeChunk(
          `rec_f_${c.reason}`,
          { ...PARAMS, chunkIndex: i },
          chunk(tone(240_000)),
          LOCAL
        );
        assert.deepStrictEqual(res, {
          ok: false,
          retryable: c.retryable,
          failure: { kind: 'engine', reason: c.mapped },
        });
      }
      // ensureModel failing (a corrupt file) takes the same mapping.
      h.whisper.setEnsureResponder(() => new WhisperEngineError({ reason: 'inference-failed' }));
      const init = yield* h.lane.transcribeChunk(
        'rec_f_init',
        { ...PARAMS, chunkIndex: 9 },
        chunk(tone(240_000)),
        LOCAL
      );
      assert.deepStrictEqual(init, {
        ok: false,
        retryable: false,
        failure: { kind: 'engine', reason: 'inference-failed' },
      });
      const warns = h.logger.entries.filter(
        e => e.scope === 'transcriber' && e.message === 'local whisper chunk failed'
      );
      assert.deepStrictEqual(
        warns.map(w => (w.data as { reason: string; detail?: string }).reason),
        ['worker-crashed', 'spawn-failed', 'timeout', 'inference-failed', 'inference-failed']
      );
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(`${ENGINE_BREAKER_THRESHOLD} consecutive transient engine failures open the recording's circuit — later chunks bypass the engine and fail retryable`, () =>
    Effect.gen(function* () {
      const h = yield* build();
      h.whisper.setTranscribeResponder(
        () => new WhisperEngineError({ reason: 'timeout', detail: 'stuck decode' })
      );
      for (const index of [0, 1]) {
        const res = yield* h.lane.transcribeChunk(
          'rec_cb',
          { ...PARAMS, chunkIndex: index },
          chunk(tone(240_000)),
          LOCAL
        );
        assert.deepStrictEqual(res, {
          ok: false,
          retryable: true,
          failure: { kind: 'engine', reason: 'timeout' },
        });
      }
      assert.strictEqual(h.whisper.transcribeCalls.length, 2);

      // Third chunk: the circuit is open — NO engine call, same retryable
      // failure, so the cursor stays frozen and the drain re-covers the audio.
      const tripped = yield* h.lane.transcribeChunk(
        'rec_cb',
        { ...PARAMS, chunkIndex: 2 },
        chunk(tone(240_000)),
        LOCAL
      );
      assert.deepStrictEqual(tripped, {
        ok: false,
        retryable: true,
        failure: { kind: 'engine', reason: 'timeout' },
      });
      assert.strictEqual(h.whisper.transcribeCalls.length, 2, 'engine NOT engaged past the trip');
      assert.strictEqual(h.whisper.ensureCalls.length, 2, 'no model-reload loop either');

      const opened = h.logger.entries.filter(
        e =>
          e.message ===
          'local whisper circuit opened — engine bypassed for the rest of this recording (audio parks for the drain)'
      );
      assert.strictEqual(opened.length, 1, 'ONE warn when the circuit opens');
      assert.deepStrictEqual(opened[0].data, {
        recordingId: 'rec_cb',
        consecutiveFailures: 2,
        reason: 'timeout',
      });

      // Another recording still gets a fresh worker attempt (per-recording).
      h.whisper.setTranscribeResponder(() => ({ text: ' fine', segments: [] }));
      const other = yield* h.lane.transcribeChunk('rec_other', PARAMS, chunk(tone(240_000)), LOCAL);
      assert.isTrue(other.ok);
      assert.strictEqual(h.whisper.transcribeCalls.length, 3);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('a worker response (success or a decode error) resets the consecutive count — no trip', () =>
    Effect.gen(function* () {
      const h = yield* build();
      const answers = [
        new WhisperEngineError({ reason: 'worker-crashed' }),
        { text: ' ok', segments: [] }, // a success resets
        new WhisperEngineError({ reason: 'timeout' }),
        new WhisperEngineError({ reason: 'inference-failed' }), // a RESPONSE — resets
        new WhisperEngineError({ reason: 'worker-crashed' }),
      ];
      let i = 0;
      h.whisper.setTranscribeResponder(() => answers[i++]!);
      for (let index = 0; index < answers.length; index += 1) {
        yield* h.lane.transcribeChunk(
          'rec_reset',
          { ...PARAMS, chunkIndex: index },
          chunk(tone(240_000)),
          LOCAL
        );
      }
      // Every chunk engaged the engine — nothing was bypassed — and the next
      // one still does: the count never reached the threshold consecutively.
      assert.strictEqual(h.whisper.transcribeCalls.length, 5);
      h.whisper.setTranscribeResponder(() => ({ text: ' still here', segments: [] }));
      const res = yield* h.lane.transcribeChunk(
        'rec_reset',
        { ...PARAMS, chunkIndex: 9 },
        chunk(tone(240_000)),
        LOCAL
      );
      assert.isTrue(res.ok);
      assert.strictEqual(h.whisper.transcribeCalls.length, 6);
      assert.strictEqual(
        h.logger.entries.filter(e => e.message.includes('circuit opened')).length,
        0
      );
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});

describe('LocalWhisperLive — cloud-mode vocabulary source', () => {
  const PERSONAL = [
    { id: 'voc_p', word: 'Prismical', replacementWord: null, isReplacement: false },
    { id: 'voc_r', word: 'road map', replacementWord: 'roadmap', isReplacement: true },
  ];
  const TEAM = [
    // Case-variant collision with the personal word — personal must win.
    { id: 'tvc_dup', word: 'prismical', replacementWord: 'PRISMICAL', isReplacement: true },
    { id: 'tvc_f', word: 'Fabric', replacementWord: null, isReplacement: false },
  ];

  it.effect(
    'fetches /me/vocabulary + /me/team-vocabulary ONCE per recording, merges personal-first, prompts + replaces with the fetched terms',
    () =>
      Effect.gen(function* () {
        const h = yield* build({ 'whisper-base-en': MODEL_PATH }, 'cloud');
        h.fakeCloud.setRequestResponder(req => ({
          ok: true,
          status: 200,
          bodyJson: {
            success: true,
            results: req.path.endsWith('/team-vocabulary') ? TEAM : PERSONAL,
          },
        }));
        h.whisper.setTranscribeResponder(() => ({
          text: ' The road map is on Fabric.',
          segments: [],
        }));

        const first = yield* h.lane.transcribeChunk(
          'rec_cv',
          { chunkIndex: 0, chunkStartMs: 0, source: 'mic' },
          chunk(tone(240_000)),
          LOCAL
        );
        yield* h.lane.transcribeChunk(
          'rec_cv',
          { chunkIndex: 1, chunkStartMs: 5_000, source: 'mic' },
          chunk(tone(240_000)),
          LOCAL
        );

        // Exactly TWO GETs for the whole recording — the answer is frozen.
        assert.deepStrictEqual(
          h.fakeCloud.requestCalls.map(call => [call.method, call.path]),
          [
            ['GET', '/apps/v1/me/vocabulary'],
            ['GET', '/apps/v1/me/team-vocabulary'],
          ]
        );
        // Personal-first merge: the team case-variant of 'Prismical' is
        // dropped, its team-only sibling survives.
        assert.strictEqual(
          h.whisper.transcribeCalls[0]?.options.initial_prompt,
          'Prismical, roadmap, Fabric'
        );
        // The replacement pass ran over the fetched terms.
        assert.isTrue(first.ok);
        if (first.ok) assert.strictEqual(first.value[0]?.text, 'The roadmap is on Fabric.');
        yield* Scope.close(h.scope, Exit.void);
      })
  );

  it.effect('cloud mode never bumps usage_count — the cache table stays untouched', () =>
    Effect.gen(function* () {
      const h = yield* build({ 'whisper-base-en': MODEL_PATH }, 'cloud');
      h.fakeCloud.setRequestResponder(req => ({
        ok: true,
        status: 200,
        bodyJson: {
          success: true,
          results: req.path.endsWith('/team-vocabulary') ? [] : PERSONAL,
        },
      }));
      h.whisper.setTranscribeResponder(() => ({
        text: ' The road map again.',
        segments: [],
      }));
      const res = yield* h.lane.transcribeChunk('rec_nb', PARAMS, chunk(tone(240_000)), LOCAL);
      assert.isTrue(res.ok);
      if (res.ok) assert.strictEqual(res.value[0]?.text, 'The roadmap again.');
      // The rule fired, but in cloud mode there is no row to bump: the
      // ProductDb here is the never-written cache (server-side bumps happen
      // only on the server's own transcription lane).
      assert.isUndefined(yield* h.usageCount('voc_r'));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect(
    'a failed fetch folds to empty terms — the chunk still transcribes, one warn per scope, and the empty answer freezes',
    () =>
      Effect.gen(function* () {
        const h = yield* build({ 'whisper-base-en': MODEL_PATH }, 'cloud');
        h.fakeCloud.setRequestResponder(() => ({ ok: true, status: 500, bodyJson: null }));
        h.whisper.setTranscribeResponder(() => ({ text: ' Still works.', segments: [] }));

        const first = yield* h.lane.transcribeChunk(
          'rec_cf',
          { chunkIndex: 0, chunkStartMs: 0, source: 'mic' },
          chunk(tone(240_000)),
          LOCAL
        );
        const second = yield* h.lane.transcribeChunk(
          'rec_cf',
          { chunkIndex: 1, chunkStartMs: 5_000, source: 'mic' },
          chunk(tone(240_000)),
          LOCAL
        );
        assert.isTrue(first.ok && second.ok, 'vocabulary is never worth failing a chunk');
        if (first.ok) assert.strictEqual(first.value[0]?.text, 'Still works.');
        assert.strictEqual(h.whisper.transcribeCalls[0]?.options.initial_prompt, '');
        // One warn per scope; the [] answer froze — no refetch on chunk 1.
        const warns = h.logger.entries.filter(
          e => e.message === 'vocabulary fetch from core failed — scope empty'
        );
        assert.deepStrictEqual(
          warns.map(w => (w.data as { path: string; status: number }).path),
          ['/apps/v1/me/vocabulary', '/apps/v1/me/team-vocabulary']
        );
        assert.strictEqual(h.fakeCloud.requestCalls.length, 2, 'frozen for the recording');
        yield* Scope.close(h.scope, Exit.void);
      })
  );
});
