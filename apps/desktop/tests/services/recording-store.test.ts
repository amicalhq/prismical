/**
 * RecordingStore unit tests: the start upsert (drain
 * re-entry replaces fields, createdAt survives), completed/failed transitions
 * (existing rows only — never fabricated), the epoch-ms → ISO timestamp
 * conversion, and the segment lane: the untyped-wire normalization matrix
 * (isFinal ?? true, timestamps ?? now, deletedAt ?? null) plus the
 * ON CONFLICT (recordingId, segmentOrder) replace — a retried chunk re-mints
 * its tsg_ id server-side, so the window (not the id) is the identity.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { asc, eq } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { RecordingStore, type RecordingStartFields } from '../../src/main/domains/recording/store';
import {
  RecordingStoreLive,
  mergeRecordingMeta,
} from '../../src/main/domains/recording/store-live';
import type { RecordingSegment } from '../../src/main/domains/transport/service';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb, type ProductDbService } from '../../src/main/infra/product-db/service';

// A temp dir per test file keeps WAL siblings isolated (operational-db idiom).
const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-recording-store-test-'));
let dbSeq = 0;

/** Build the store over a fresh file-backed product store. */
const buildStore = Effect.gen(function* () {
  dbSeq += 1;
  const logger = makeTestLogger();
  const env = Layer.mergeAll(
    testConfigLayer({ localDbPath: path.join(tempDir, `recording-store-${dbSeq}.db`) }),
    logger.layer
  );
  const scope = yield* Scope.make();
  const envCtx = yield* Layer.build(env).pipe(Scope.extend(scope));
  const productDb = makeProductDbLayer({ kind: 'local' });
  const workspace = Layer.mergeAll(productDb, RecordingStoreLive.pipe(Layer.provide(productDb)));
  const ctx = yield* Layer.build(workspace).pipe(
    Effect.provide(envCtx),
    Scope.extend(scope),
    Effect.orDie
  );
  return {
    scope,
    store: Context.get(ctx, RecordingStore),
    product: Context.get(ctx, ProductDb),
  };
});

const START: RecordingStartFields = {
  id: 'rec_1',
  title: 'Standup',
  captureMode: 'dual',
  status: 'recording',
  noteId: 'nt_1',
  startedAt: 1_720_000_000_000,
  transcriptionConfig: { provider: 'prismical-cloud', model: 'prismical-cloud', language: 'en' },
};

/** The 8 fields main's RecordingSegment type declares (the lane's shape). */
const laneSegment = (
  over: Partial<RecordingSegment> & Pick<RecordingSegment, 'id' | 'segmentOrder'>
): RecordingSegment => ({
  recordingId: 'rec_1',
  source: 'mic',
  speaker: 'you',
  text: 'hello team',
  startTimeMs: 0,
  endTimeMs: 5_000,
  ...over,
});

const recordingRow = (product: ProductDbService, id: string) =>
  Effect.promise(async () => {
    const rows = await product.db
      .select()
      .from(schema.recording)
      .where(eq(schema.recording.id, id));
    return rows[0];
  });

const segmentRows = (product: ProductDbService, recordingId: string) =>
  Effect.promise(() =>
    product.db
      .select()
      .from(schema.transcriptSegment)
      .where(eq(schema.transcriptSegment.recordingId, recordingId))
      .orderBy(asc(schema.transcriptSegment.segmentOrder))
  );

describe('RecordingStore', () => {
  it.effect('recordingStarted persists the create fields with ISO startedAt; the upsert replaces on re-entry and keeps createdAt', () =>
    Effect.gen(function* () {
      const { scope, store, product } = yield* buildStore;

      yield* store.recordingStarted(START);
      const row = (yield* recordingRow(product, 'rec_1'))!;
      assert.strictEqual(row.status, 'recording');
      assert.strictEqual(row.title, 'Standup');
      assert.strictEqual(row.captureMode, 'dual');
      assert.strictEqual(row.noteId, 'nt_1');
      assert.strictEqual(row.startedAt, new Date(1_720_000_000_000).toISOString());
      assert.deepStrictEqual(row.transcriptionConfig, START.transcriptionConfig);
      assert.isNull(row.endedAt);
      assert.isFalse(Number.isNaN(Date.parse(row.createdAt)), 'createdAt stored as ISO');

      // Re-entrant start (drain-safe upsert): fields replace, ONE row survives,
      // the original createdAt is kept.
      yield* store.recordingStarted({ ...START, title: 'Renamed', noteId: null });
      const all = yield* Effect.sync(() => product.db.select().from(schema.recording).all());
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].title, 'Renamed');
      assert.isNull(all[0].noteId);
      assert.strictEqual(all[0].createdAt, row.createdAt);

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('recordingCompleted/recordingFailed transition existing rows; a missing id is never fabricated', () =>
    Effect.gen(function* () {
      const { scope, store, product } = yield* buildStore;
      yield* store.recordingStarted(START);
      yield* store.recordingStarted({ ...START, id: 'rec_2' });
      const before = (yield* recordingRow(product, 'rec_1'))!;

      yield* store.recordingCompleted('rec_1', { endedAt: 1_720_000_090_000, durationMs: 90_000 });
      const completed = (yield* recordingRow(product, 'rec_1'))!;
      assert.strictEqual(completed.status, 'completed');
      assert.strictEqual(completed.endedAt, new Date(1_720_000_090_000).toISOString());
      assert.strictEqual(completed.durationMs, 90_000, 'durationMs stored as given');
      assert.isAtLeast(Date.parse(completed.updatedAt), Date.parse(before.updatedAt));

      yield* store.recordingFailed('rec_2');
      assert.strictEqual((yield* recordingRow(product, 'rec_2'))!.status, 'failed');

      // Neither transition fabricates a row for an unknown id.
      yield* store.recordingCompleted('rec_missing', { endedAt: 0, durationMs: 0 });
      yield* store.recordingFailed('rec_missing');
      assert.isUndefined(yield* recordingRow(product, 'rec_missing'));

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('segmentsReceived normalizes the 8-field lane shape and preserves a full 13-field wire row verbatim', () =>
    Effect.gen(function* () {
      const { scope, store, product } = yield* buildStore;

      // Bare lane shape → defaults: isFinal true, deletedAt null, now-ISO stamps.
      yield* store.segmentsReceived([laneSegment({ id: 'tsg_bare', segmentOrder: 1_000_000 })]);
      // Full wire reality (the extra 5 server fields ride the cast) → verbatim.
      const wire = {
        ...laneSegment({ id: 'tsg_full', segmentOrder: 1_001_000 }),
        source: 'system',
        speaker: 'them',
        orgUserId: 'ou_1', // no column — dropped
        isFinal: false,
        createdAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-01-02T03:04:06.000Z',
        deletedAt: null,
      } as RecordingSegment;
      yield* store.segmentsReceived([wire]);
      // Empty array is a no-op.
      yield* store.segmentsReceived([]);

      const rows = yield* segmentRows(product, 'rec_1');
      assert.strictEqual(rows.length, 2);
      const [bare, full] = rows;
      assert.strictEqual(bare.id, 'tsg_bare');
      assert.isTrue(bare.isFinal, 'isFinal defaults true');
      assert.isNull(bare.deletedAt);
      assert.isFalse(Number.isNaN(Date.parse(bare.createdAt)), 'createdAt defaults to now ISO');
      assert.strictEqual(bare.createdAt, bare.updatedAt);
      assert.strictEqual(full.id, 'tsg_full');
      assert.strictEqual(full.source, 'system');
      assert.strictEqual(full.speaker, 'them');
      assert.isFalse(full.isFinal, 'wire isFinal preserved');
      assert.strictEqual(full.createdAt, '2026-01-02T03:04:05.000Z');
      assert.strictEqual(full.updatedAt, '2026-01-02T03:04:06.000Z');

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a retried chunk — same (recordingId, segmentOrder), NEW id — replaces the row instead of duplicating', () =>
    Effect.gen(function* () {
      const { scope, store, product } = yield* buildStore;

      yield* store.segmentsReceived([
        laneSegment({ id: 'tsg_a', segmentOrder: 1_000_000, text: 'first pass' }),
      ]);
      yield* store.segmentsReceived([
        laneSegment({ id: 'tsg_b', segmentOrder: 1_000_000, text: 'retried pass' }),
      ]);

      const replaced = yield* segmentRows(product, 'rec_1');
      assert.strictEqual(replaced.length, 1, 'the window is the identity — no duplicate');
      assert.strictEqual(replaced[0].id, 'tsg_b', 'the re-minted id wins');
      assert.strictEqual(replaced[0].text, 'retried pass');

      // A different window in the same recording is a second row …
      yield* store.segmentsReceived([laneSegment({ id: 'tsg_c', segmentOrder: 1_001_000 })]);
      assert.strictEqual((yield* segmentRows(product, 'rec_1')).length, 2);
      // … and the same order under ANOTHER recording never collides.
      yield* store.segmentsReceived([
        laneSegment({ id: 'tsg_d', segmentOrder: 1_000_000, recordingId: 'rec_2' }),
      ]);
      assert.strictEqual((yield* segmentRows(product, 'rec_2')).length, 1);
      assert.strictEqual((yield* segmentRows(product, 'rec_1')).length, 2);

      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('RecordingStore.recordingMetaMerged — the server max-merge', () => {
  it('mergeRecordingMeta: numbers take the max, everything else shallow-overwrites, new keys are added', () => {
    assert.deepStrictEqual(
      mergeRecordingMeta(
        { detectedSpeakerCount: 2, finalize: { status: 'skipped' }, label: 'a' },
        { detectedSpeakerCount: 1, finalize: { status: 'done' }, label: 'b', extra: true }
      ),
      { detectedSpeakerCount: 2, finalize: { status: 'done' }, label: 'b', extra: true }
    );
    assert.deepStrictEqual(mergeRecordingMeta({ detectedSpeakerCount: 1 }, { detectedSpeakerCount: 2 }), {
      detectedSpeakerCount: 2,
    });
    // A non-numeric stored value is simply replaced (no max over mixed types).
    assert.deepStrictEqual(mergeRecordingMeta({ detectedSpeakerCount: 'x' }, { detectedSpeakerCount: 1 }), {
      detectedSpeakerCount: 1,
    });
    assert.deepStrictEqual(mergeRecordingMeta({}, { detectedSpeakerCount: 1 }), { detectedSpeakerCount: 1 });
  });

  it.effect('merges into the row (max for the count), bumps updatedAt, and never fabricates a missing row', () =>
    Effect.gen(function* () {
      const { store, product, scope } = yield* buildStore;
      yield* store.recordingStarted({
        ...START,
        meta: { detectedSpeakerCount: 2, finalize: { status: 'skipped' } },
      });
      const before = (yield* recordingRow(product, 'rec_1'))!;

      yield* store.recordingMetaMerged('rec_1', { detectedSpeakerCount: 1, source: 'local' });
      const lowered = (yield* recordingRow(product, 'rec_1'))!;
      assert.deepStrictEqual(lowered.meta, {
        detectedSpeakerCount: 2,
        finalize: { status: 'skipped' },
        source: 'local',
      });
      assert.isTrue(Date.parse(lowered.updatedAt) >= Date.parse(before.updatedAt));

      yield* store.recordingMetaMerged('rec_1', { detectedSpeakerCount: 3 });
      assert.strictEqual((yield* recordingRow(product, 'rec_1'))!.meta?.detectedSpeakerCount, 3);

      // A row that started with NULL meta merges from {}.
      yield* store.recordingStarted({ ...START, id: 'rec_2' });
      yield* store.recordingMetaMerged('rec_2', { detectedSpeakerCount: 1 });
      assert.deepStrictEqual((yield* recordingRow(product, 'rec_2'))!.meta, { detectedSpeakerCount: 1 });

      // Missing row → no-op (never fabricated).
      yield* store.recordingMetaMerged('rec_missing', { detectedSpeakerCount: 1 });
      assert.isUndefined(yield* recordingRow(product, 'rec_missing'));

      yield* Scope.close(scope, Exit.void);
    })
  );
});
