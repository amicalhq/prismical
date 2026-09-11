/**
 * Transcriber seam tests.
 *
 *  - CloudTranscriberLive downsamples cloud uploads to filtered 16 kHz WAVs;
 *  - TranscriberLive dispatches on the frozen engine; placeholder local/BYOK lanes acknowledge
 *    empty and warn ONCE per recording;
 *  - engine resolution (mode × preference — model presence is a lane concern);
 *  - the transcriptionConfig derivation per engine (never an instanceId);
 *  - the segment mint (the server's chunk→segment math) + the channel speaker count;
 *  - the cloud-mode mirror: sync-create bodies that validate against the api contract,
 *    sequential POSTs, best-effort on failure.
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { SEGMENT_ORDER_CLOUD_BASE, SEGMENT_ORDER_WINDOW } from '@prismical/ai-prompts/transcription';
import { SyncTranscriptSegmentCreateRequestSchema } from '@prismical/api-contracts';
import { isValidPrefixedId } from '@prismical/id';
import { makeTestLogger } from '../helpers/test-layers';
import { fakeSegment, makeFakeWorkspaceBackend } from '../helpers/fake-recording';
import { makeTranscriberStack } from '../helpers/fake-workspace-env';
import { RECOMMENDED_MODEL_ID } from '../../src/main/domains/models/catalogue';
import { CAPTURE_SAMPLE_RATE } from '../../src/main/domains/recording/chunker';
import {
  TRANSCRIPT_SEGMENTS_PATH,
  mirrorSegmentsToCore,
  transcriptSegmentCreateBody,
} from '../../src/main/domains/recording/segment-mirror';
import { CloudTranscriberLive } from '../../src/main/domains/transcriber/cloud';
import {
  BYOK_DESKTOP_TRANSCRIPTION_CONFIG,
  LOCAL_WHISPER_TRANSCRIPTION_CONFIG,
  resolveRecordingEngine,
  supportsRecordingLanguage,
  transcriptionConfigFor,
  type RecordingEngine,
} from '../../src/main/domains/transcriber/engine';
import {
  detectedSpeakerCountFor,
  deterministicSegmentId,
  mintChunkSegment,
} from '../../src/main/domains/transcriber/segment';
import {
  CloudTranscriberLane,
  Transcriber,
  type ChunkAudio,
} from '../../src/main/domains/transcriber/service';
import { MANAGED_TRANSCRIPTION_CONFIG } from '../../src/main/domains/transport/live';
import {
  WorkspaceBackend,
  type TranscribeChunkParams,
} from '../../src/main/domains/transport/service';
import { MainLogger } from '../../src/main/infra/logging/service';

const PARAMS: TranscribeChunkParams = { chunkIndex: 3, chunkStartMs: 15_000, source: 'mic' };
const CLOUD: RecordingEngine = {
  engine: 'cloud',
  modelId: RECOMMENDED_MODEL_ID,
  byokBaseUrl: null,
  byokModel: null,
};
const LOCAL: RecordingEngine = { ...CLOUD, engine: 'local', modelId: 'whisper-tiny' };
const BYOK: RecordingEngine = {
  ...CLOUD,
  engine: 'byok',
  byokBaseUrl: 'https://byok.test/v1',
  byokModel: 'whisper-1',
};
const samples = (n: number, fill = 0.25): Float32Array => new Float32Array(n).fill(fill);
const audio = (n: number): ChunkAudio => ({ samples: samples(n), sampleRate: CAPTURE_SAMPLE_RATE });

describe('CloudTranscriberLive', () => {
  it.effect(
    'uploads filtered 16 kHz WAVs with unchanged source offsets and results',
    () =>
      Effect.gen(function* () {
        const fakeCloud = makeFakeWorkspaceBackend();
        const answer = { ok: true as const, value: [fakeSegment('rec_16k', 'mic', 3, 'hi')] };
        fakeCloud.setUploadResponder(() => answer);
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(
          CloudTranscriberLive.pipe(Layer.provide(fakeCloud.layer))
        ).pipe(Scope.extend(scope));
        const lane = Context.get(ctx, CloudTranscriberLane);
        for (const source of ['mic', 'system'] as const) {
          // Speech-band signal plus a high-frequency tone that would alias to 6 kHz.
          const input = Float32Array.from(
            { length: 720_000 },
            (_, i) =>
              0.25 * Math.cos((2 * Math.PI * 1_000 * i) / 48_000) +
              0.25 * Math.cos((2 * Math.PI * 10_000 * i) / 48_000)
          );
          const params = { ...PARAMS, source };
          const result = yield* lane.transcribeChunk(
            'rec_16k',
            params,
            { samples: input, sampleRate: 48_000 },
            CLOUD
          );
          assert.strictEqual(result, answer);
          const call = fakeCloud.uploadCalls.at(-1)!;
          assert.strictEqual(call.recordingId, 'rec_16k');
          assert.deepStrictEqual(call.params, params);
          const wav = Buffer.from(call.wav);
          assert.strictEqual(wav.length, 480_044);
          assert.strictEqual(wav.readUInt32LE(24), 16_000);
          assert.strictEqual(wav.readUInt32LE(28), 32_000);
          assert.strictEqual(wav.readUInt16LE(20), 1);
          assert.strictEqual(wav.readUInt16LE(22), 1);
          assert.strictEqual(wav.readUInt16LE(34), 16);
          assert.strictEqual(wav.readUInt32LE(40), 480_000);
          for (let i = 160; i < 320; i += 1) {
            assert.closeTo(
              wav.readInt16LE(44 + i * 2) / 32768,
              0.25 * Math.cos((2 * Math.PI * 1_000 * i) / 16_000),
              0.0001
            );
          }
        }
        yield* lane.transcribeChunk('rec_16k', PARAMS, audio(481), CLOUD);
        const tail = Buffer.from(fakeCloud.uploadCalls.at(-1)!.wav);
        assert.strictEqual(tail.length, 44 + 161 * 2);
        assert.strictEqual(tail.readUInt32LE(24), 16_000);
        yield* Scope.close(scope, Exit.void);
      })
  );

});

describe('TranscriberLive dispatch and placeholder lanes', () => {
  const build = Effect.gen(function* () {
    const logger = makeTestLogger();
    const fakeCloud = makeFakeWorkspaceBackend();
    const scope = yield* Scope.make();
    const ctx = yield* Layer.build(
      makeTranscriberStack(fakeCloud.layer).pipe(Layer.provide(logger.layer))
    ).pipe(Scope.extend(scope));
    return { transcriber: Context.get(ctx, Transcriber), fakeCloud, logger };
  });

  it.effect("'cloud' routes to the cloud lane (the backend upload)", () =>
    Effect.gen(function* () {
      const { transcriber, fakeCloud } = yield* build;
      const res = yield* transcriber.transcribeChunk('rec_c', PARAMS, audio(48_000), CLOUD);
      assert.deepStrictEqual(res, { ok: true, value: [] });
      assert.strictEqual(fakeCloud.uploadCalls.length, 1);
    })
  );

  it.effect(
    "'local' / 'byok' placeholders ack { ok, [] } without touching the backend, ONE warn per recording",
    () =>
      Effect.gen(function* () {
        const { transcriber, fakeCloud, logger } = yield* build;
        for (const engine of [LOCAL, BYOK]) {
          const first = yield* transcriber.transcribeChunk('rec_a', PARAMS, audio(48_000), engine);
          const second = yield* transcriber.transcribeChunk(
            'rec_a',
            { ...PARAMS, chunkIndex: 4 },
            audio(48_000),
            engine
          );
          const other = yield* transcriber.transcribeChunk('rec_b', PARAMS, audio(48_000), engine);
          assert.deepStrictEqual(first, { ok: true, value: [] });
          assert.deepStrictEqual(second, { ok: true, value: [] });
          assert.deepStrictEqual(other, { ok: true, value: [] });
        }
        assert.strictEqual(fakeCloud.uploadCalls.length, 0, 'the cloud lane was never reached');
        const warns = logger.entries.filter(
          e =>
            e.scope === 'transcriber' &&
            e.message === 'transcription engine not available in this build — chunks ack empty'
        );
        // Two engines × two recordings: rec_a warned once per engine despite two chunks.
        assert.deepStrictEqual(
          warns.map(w => w.data),
          [
            { recordingId: 'rec_a', engine: 'local' },
            { recordingId: 'rec_b', engine: 'local' },
            { recordingId: 'rec_a', engine: 'byok' },
            { recordingId: 'rec_b', engine: 'byok' },
          ]
        );
      })
  );
});

describe('resolveRecordingEngine (mode × preference; model presence is the lane’s concern)', () => {
  const pref = (over: Partial<Parameters<typeof resolveRecordingEngine>[1]> = {}) => ({
    engine: 'cloud' as const,
    modelId: null,
    byokBaseUrl: null,
    byokModel: null,
    ...over,
  });

  it('cloud mode keeps the stored choice; local mode coerces the cloud default to local', () => {
    assert.deepStrictEqual(resolveRecordingEngine('cloud', pref()), {
      engine: 'cloud',
      language: 'en',
      modelId: RECOMMENDED_MODEL_ID,
      byokBaseUrl: null,
      byokModel: null,
    });
    assert.strictEqual(resolveRecordingEngine('local', pref()).engine, 'local');
    assert.strictEqual(resolveRecordingEngine('cloud', pref({ engine: 'local' })).engine, 'local');
    assert.strictEqual(resolveRecordingEngine('local', pref({ engine: 'local' })).engine, 'local');
    assert.strictEqual(resolveRecordingEngine('cloud', pref({ engine: 'byok' })).engine, 'byok');
    assert.strictEqual(resolveRecordingEngine('local', pref({ engine: 'byok' })).engine, 'byok');
  });

  it('keeps the chosen engine configuration when resolving a non-English recording', () => {
    const setting = pref({
      engine: 'byok', modelId: 'whisper-small',
      byokBaseUrl: 'https://byok.test/v1', byokModel: 'whisper-1',
    });
    assert.deepStrictEqual(resolveRecordingEngine('cloud', setting, 'ja'), {
      ...setting, modelId: 'whisper-small', language: 'ja',
    });
  });

  it('rejects non-English only for the English-only local model without rerouting the selection', () => {
    const englishOnly = resolveRecordingEngine('local', pref(), 'ja');
    assert.strictEqual(englishOnly.modelId, 'whisper-base-en');
    assert.isFalse(supportsRecordingLanguage(englishOnly, 'ja'));
    assert.isTrue(supportsRecordingLanguage(englishOnly, 'en'));
    assert.isTrue(supportsRecordingLanguage({ ...englishOnly, modelId: 'whisper-small' }, 'ja'));
    assert.isTrue(supportsRecordingLanguage({ ...englishOnly, engine: 'cloud' }, 'ja'));
    assert.isTrue(supportsRecordingLanguage({ ...englishOnly, engine: 'byok' }, 'ja'));
  });

  it('modelId falls back to the recommended model; an explicit id and the BYOK knobs pass through', () => {
    assert.strictEqual(
      resolveRecordingEngine('cloud', pref({ engine: 'local' })).modelId,
      RECOMMENDED_MODEL_ID
    );
    const explicit = resolveRecordingEngine(
      'local',
      pref({ engine: 'local', modelId: 'whisper-tiny' })
    );
    assert.strictEqual(explicit.modelId, 'whisper-tiny');
    const byok = resolveRecordingEngine(
      'cloud',
      pref({ engine: 'byok', byokBaseUrl: 'https://byok.test/v1', byokModel: 'whisper-1' })
    );
    assert.deepStrictEqual(byok, {
      engine: 'byok',
      language: 'en',
      modelId: RECOMMENDED_MODEL_ID,
      byokBaseUrl: 'https://byok.test/v1',
      byokModel: 'whisper-1',
    });
  });
});

describe('transcriptionConfigFor (frozen per engine)', () => {
  it('historical cloud recordings keep the managed English default', () => {
    assert.deepStrictEqual(transcriptionConfigFor(CLOUD), MANAGED_TRANSCRIPTION_CONFIG);
  });

  it('local → local-whisper + the local:-prefixed model id; byok → byok-desktop + the model (or unknown)', () => {
    assert.deepStrictEqual(transcriptionConfigFor(LOCAL), {
      provider: 'local-whisper',
      model: 'local:whisper-tiny',
      language: 'en',
    });
    assert.deepStrictEqual(
      transcriptionConfigFor(LOCAL),
      LOCAL_WHISPER_TRANSCRIPTION_CONFIG('whisper-tiny')
    );
    assert.deepStrictEqual(transcriptionConfigFor(BYOK), {
      provider: 'byok-desktop',
      model: 'whisper-1',
      language: 'en',
    });
    assert.deepStrictEqual(transcriptionConfigFor({ ...BYOK, byokModel: null }), {
      provider: 'byok-desktop',
      model: 'unknown',
      language: 'en',
    });
    assert.deepStrictEqual(
      transcriptionConfigFor({ ...BYOK, byokModel: null }),
      BYOK_DESKTOP_TRANSCRIPTION_CONFIG(null)
    );
  });

  it('freezes the selected spoken language without changing model or provider metadata', () => {
    for (const engine of [CLOUD, LOCAL, BYOK]) {
      assert.deepStrictEqual(transcriptionConfigFor({ ...engine, language: 'ja' }), {
        ...transcriptionConfigFor(engine), language: 'ja',
      });
    }
  });

  it('never carries an instanceId because the server would resolve BYOK on every chunk upload', () => {
    for (const engine of [CLOUD, LOCAL, BYOK]) {
      assert.isFalse('instanceId' in transcriptionConfigFor(engine));
      assert.strictEqual(transcriptionConfigFor(engine).language, 'en');
    }
  });

  it('namespaces local catalogue model ids before sync', () => {
    // The `local:` prefix keeps the user's on-device selection distinct and
    // preserves the exact catalogue id through sync redaction.
    for (const modelId of ['whisper-large-v3', 'whisper-large-v3-turbo']) {
      assert.strictEqual(
        LOCAL_WHISPER_TRANSCRIPTION_CONFIG(modelId).model,
        `local:${modelId}`
      );
    }
  });
});

describe('mintChunkSegment (the server’s chunkSegmentValues math, minted in main)', () => {
  it('mints ONE segment per non-empty chunk with the cloud segmentOrder window', () => {
    const now = 1_720_000_000_000;
    const segment = mintChunkSegment({
      recordingId: 'rec_1',
      params: PARAMS,
      samples: samples(240_000),
      text: '  hello team  ',
      now,
    });
    assert.isNotNull(segment);
    assert.match(segment!.id, /^tsg_/);
    assert.strictEqual(segment!.recordingId, 'rec_1');
    assert.strictEqual(segment!.source, 'mic');
    assert.strictEqual(segment!.speaker, 'you');
    assert.strictEqual(segment!.text, 'hello team');
    assert.strictEqual(segment!.startTimeMs, 15_000);
    assert.strictEqual(segment!.endTimeMs, 20_000, 'chunkStartMs + round(240000 / 48000 s → ms)');
    assert.strictEqual(segment!.segmentOrder, SEGMENT_ORDER_CLOUD_BASE + 3 * SEGMENT_ORDER_WINDOW);
    assert.strictEqual(segment!.segmentOrder, 1_003_000);
    assert.strictEqual(segment!.isFinal, true);
    assert.strictEqual(segment!.createdAt, new Date(now).toISOString());
    assert.strictEqual(segment!.updatedAt, segment!.createdAt);
    assert.isNull(segment!.deletedAt);
  });

  it('a system chunk is attributed to them; a partial tail measures its own length; blank text mints nothing', () => {
    const system = mintChunkSegment({
      recordingId: 'rec_1',
      params: { chunkIndex: 1, chunkStartMs: 0, source: 'system' },
      samples: samples(48_000),
      text: 'them',
      now: 0,
    });
    assert.strictEqual(system?.speaker, 'them');
    assert.strictEqual(system?.endTimeMs, 1_000);
    assert.strictEqual(system?.segmentOrder, 1_001_000);
    assert.isNull(
      mintChunkSegment({
        recordingId: 'rec_1',
        params: PARAMS,
        samples: samples(48_000),
        text: '  \n ',
        now: 0,
      })
    );
  });

  it('the id is deterministic per (recordingId, segmentOrder): re-mints share it, other chunks and recordings do not', () => {
    const a = mintChunkSegment({
      recordingId: 'r',
      params: PARAMS,
      samples: samples(10),
      text: 'a',
      now: 0,
    });
    const b = mintChunkSegment({
      recordingId: 'r',
      params: PARAMS,
      samples: samples(10),
      text: 'b',
      now: 1_000,
    });
    // Same chunk, different attempt (live vs drain): SAME segmentOrder AND
    // Same id — the server's id-keyed sync upsert replaces instead of duplicating.
    assert.strictEqual(a?.segmentOrder, b?.segmentOrder);
    assert.strictEqual(a?.id, b?.id);
    assert.strictEqual(a?.id, deterministicSegmentId('r', a!.segmentOrder));
    // tsg_ + 24 lowercase-hex chars, and prefix-valid for the entity.
    assert.match(a!.id, /^tsg_[0-9a-f]{24}$/);
    assert.isTrue(isValidPrefixedId('transcriptSegment', a!.id));
    // A different chunk of the same recording gets a different id…
    const nextChunk = mintChunkSegment({
      recordingId: 'r',
      params: { ...PARAMS, chunkIndex: 4 },
      samples: samples(10),
      text: 'c',
      now: 0,
    });
    assert.notStrictEqual(nextChunk?.id, a?.id);
    // …and so does the same chunk of a different recording.
    const otherRecording = mintChunkSegment({
      recordingId: 'r2',
      params: PARAMS,
      samples: samples(10),
      text: 'a',
      now: 0,
    });
    assert.notStrictEqual(otherRecording?.id, a?.id);
  });
});

describe('detectedSpeakerCountFor channel-derived count', () => {
  const seg = (source: 'mic' | 'system', text: string) => ({
    ...fakeSegment('rec', source, 0, text),
    source,
  });

  it('dual with any non-empty system segment → 2; otherwise 1', () => {
    assert.strictEqual(
      detectedSpeakerCountFor('dual', [seg('mic', 'me'), seg('system', 'them')]),
      2
    );
    assert.strictEqual(
      detectedSpeakerCountFor('dual', [seg('mic', 'me'), seg('system', '   ')]),
      1
    );
    assert.strictEqual(detectedSpeakerCountFor('dual', [seg('mic', 'me')]), 1);
    assert.strictEqual(detectedSpeakerCountFor('dual', []), 1);
    assert.strictEqual(detectedSpeakerCountFor('mic', [seg('mic', 'me')]), 1);
    assert.strictEqual(detectedSpeakerCountFor('system', [seg('system', 'them')]), 1);
  });
});

describe('cloud-mode segment mirror (POST /apps/v1/me/transcript-segments)', () => {
  it('the create body is exactly the sync contract’s field set', () => {
    const minted = mintChunkSegment({
      recordingId: 'rec_1',
      params: PARAMS,
      samples: samples(240_000),
      text: 'hello',
      now: 0,
    })!;
    const body = transcriptSegmentCreateBody(minted);
    const parsed = SyncTranscriptSegmentCreateRequestSchema.safeParse(body);
    assert.isTrue(parsed.success, JSON.stringify(parsed.error?.issues));
    // z.object strips unknown keys — equality proves nothing was stripped, i.e. the
    // body carries ONLY fields the contract names.
    assert.deepStrictEqual(parsed.data, body);
    assert.deepStrictEqual(Object.keys(body).sort(), [
      'endTimeMs',
      'id',
      'isFinal',
      'recordingId',
      'segmentOrder',
      'source',
      'speaker',
      'startTimeMs',
      'text',
    ]);
    assert.strictEqual(body.segmentOrder, 1_003_000, 'the SAME segmentOrder the store keys on');
    // A bare 8-field lane segment defaults isFinal to true.
    assert.strictEqual(
      transcriptSegmentCreateBody(fakeSegment('rec_1', 'mic', 0, 'x')).isFinal,
      true
    );
  });

  it.effect(
    'POSTs segments in order and returns delivery failures for recovery',
    () =>
      Effect.gen(function* () {
        const logger = makeTestLogger();
        const fakeCloud = makeFakeWorkspaceBackend();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(Layer.mergeAll(logger.layer, fakeCloud.layer)).pipe(
          Scope.extend(scope)
        );
        const log = Context.get(ctx, MainLogger).scoped('recording');
        const backend = Context.get(ctx, WorkspaceBackend);
        const a = mintChunkSegment({
          recordingId: 'rec_1',
          params: { ...PARAMS, chunkIndex: 0 },
          samples: samples(240_000),
          text: 'a',
          now: 0,
        })!;
        const b = mintChunkSegment({
          recordingId: 'rec_1',
          params: { ...PARAMS, chunkIndex: 1 },
          samples: samples(240_000),
          text: 'b',
          now: 0,
        })!;

        assert.deepStrictEqual(yield* mirrorSegmentsToCore(backend, log, 'rec_1', [a, b]), { ok: true, value: undefined });
        assert.deepStrictEqual(fakeCloud.requestCalls, [
          { method: 'POST', path: TRANSCRIPT_SEGMENTS_PATH, body: transcriptSegmentCreateBody(a) },
          { method: 'POST', path: TRANSCRIPT_SEGMENTS_PATH, body: transcriptSegmentCreateBody(b) },
        ]);
        assert.strictEqual(logger.entries.filter(e => e.level === 'warn').length, 0);

        fakeCloud.setRequestResponder(() => ({ ok: true, status: 500, bodyJson: null }));
        assert.deepStrictEqual(yield* mirrorSegmentsToCore(backend, log, 'rec_1', [a]), { ok: false, retryable: true, failure: { kind: 'http', status: 500 } });
        fakeCloud.setRequestResponder(() => ({ error: { code: 'INTERNAL' } }));
        assert.deepStrictEqual(yield* mirrorSegmentsToCore(backend, log, 'rec_1', [b]), { ok: false, retryable: true, failure: { kind: 'network' } });
        const warns = logger.entries.filter(
          e => e.level === 'warn' && e.message === 'segment mirror to core failed — retained for recovery'
        );
        assert.deepStrictEqual(
          warns.map(w => w.data),
          [
            { recordingId: 'rec_1', segmentOrder: a.segmentOrder, status: 500 },
            { recordingId: 'rec_1', segmentOrder: b.segmentOrder, error: 'INTERNAL' },
          ]
        );
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'a re-transcribed chunk mirrors with the same id — the server’s id-keyed sync upsert stays idempotent',
    () =>
      Effect.gen(function* () {
        const logger = makeTestLogger();
        const fakeCloud = makeFakeWorkspaceBackend();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(Layer.mergeAll(logger.layer, fakeCloud.layer)).pipe(
          Scope.extend(scope)
        );
        const log = Context.get(ctx, MainLogger).scoped('recording');
        const backend = Context.get(ctx, WorkspaceBackend);
        // The live pass and a later drain pass re-mint the SAME chunk (text may
        // even differ across whisper runs) — the wire body must carry one id.
        const live = mintChunkSegment({
          recordingId: 'rec_re',
          params: PARAMS,
          samples: samples(240_000),
          text: 'first attempt',
          now: 0,
        })!;
        const drained = mintChunkSegment({
          recordingId: 'rec_re',
          params: PARAMS,
          samples: samples(240_000),
          text: 'second attempt',
          now: 60_000,
        })!;

        yield* mirrorSegmentsToCore(backend, log, 'rec_re', [live]);
        yield* mirrorSegmentsToCore(backend, log, 'rec_re', [drained]);

        assert.strictEqual(fakeCloud.requestCalls.length, 2);
        const [first, second] = fakeCloud.requestCalls.map(
          call => call.body as { id: string; segmentOrder: number; text: string }
        );
        assert.strictEqual(first.id, second.id, 'ONE server row per chunk, replaced not duplicated');
        assert.strictEqual(first.segmentOrder, second.segmentOrder);
        assert.strictEqual(second.text, 'second attempt');
        yield* Scope.close(scope, Exit.void);
      })
  );
});
