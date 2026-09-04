/**
 * NoteBodyStore unit tests: per-note sequence allocation with
 * the lazy stub note row, replay order, compact atomicity (later rows
 * survive), the flush projection that never bumps updatedAt, the derived
 * title-follow matrix (placeholder/first-line follow; manual/tombstoned rows
 * untouched), and registration into the boot-scoped CollabBridge.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Option, Scope } from 'effect';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { CollabBridgeLive, NoteBodyStoreLive } from '../../src/main/domains/collab/store-live';
import { CollabBridge, NoteBodyStore } from '../../src/main/domains/collab/store';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb, type ProductDbService } from '../../src/main/infra/product-db/service';

// A temp dir per test file keeps WAL siblings isolated (operational-db idiom).
const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-note-body-store-test-'));
let dbSeq = 0;

/** Build the store graph over a fresh file-backed product store. */
const buildStore = Effect.gen(function* () {
  dbSeq += 1;
  const logger = makeTestLogger();
  const env = Layer.mergeAll(
    testConfigLayer({ localDbPath: path.join(tempDir, `note-body-${dbSeq}.db`) }),
    logger.layer,
    CollabBridgeLive
  );
  const scope = yield* Scope.make();
  const envCtx = yield* Layer.build(env).pipe(Scope.extend(scope));
  const productDb = makeProductDbLayer({ kind: 'local' });
  const workspace = Layer.mergeAll(productDb, NoteBodyStoreLive.pipe(Layer.provide(productDb)));
  const ctx = yield* Layer.build(workspace).pipe(
    Effect.provide(envCtx),
    Scope.extend(scope),
    Effect.orDie
  );
  return {
    scope,
    store: Context.get(ctx, NoteBodyStore),
    product: Context.get(ctx, ProductDb),
    bridge: Context.get(envCtx, CollabBridge),
  };
});

const noteRow = (product: ProductDbService, id: string) =>
  Effect.promise(async () => {
    const rows = await product.db.select().from(schema.note).where(eq(schema.note.id, id));
    return rows[0];
  });

const seedNote = (
  product: ProductDbService,
  id: string,
  fields: Partial<typeof schema.note.$inferInsert>
) =>
  Effect.promise(async () => {
    const now = new Date().toISOString();
    await product.db.insert(schema.note).values({
      id,
      title: 'Seeded',
      titleSource: 'manual',
      createdAt: now,
      updatedAt: now,
      metadataUpdatedAt: now,
      ...fields,
    });
  });

const blob = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

describe('NoteBodyStore', () => {
  it.effect('appendUpdate allocates per-note seqs and lazily creates the stub note row', () =>
    Effect.gen(function* () {
      const { scope, store, product } = yield* buildStore;

      assert.strictEqual(yield* store.appendUpdate('nt_a', blob(1)), 1);
      assert.strictEqual(yield* store.appendUpdate('nt_a', blob(2)), 2);
      // Seqs are PER NOTE — a second note starts back at 1.
      assert.strictEqual(yield* store.appendUpdate('nt_b', blob(9)), 1);

      // The lazy stub row (cloud store-hook parity): placeholder title.
      const row = yield* noteRow(product, 'nt_a');
      assert.isDefined(row);
      assert.strictEqual(row!.title, 'Untitled note');
      assert.strictEqual(row!.titleSource, 'placeholder');

      // An existing row is never overwritten by a later append.
      yield* seedNote(product, 'nt_c', { title: 'Kept', titleSource: 'manual' });
      yield* store.appendUpdate('nt_c', blob(7));
      const kept = yield* noteRow(product, 'nt_c');
      assert.strictEqual(kept!.title, 'Kept');
      assert.strictEqual(kept!.titleSource, 'manual');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('listUpdates replays the log in seq order with the exact blobs', () =>
    Effect.gen(function* () {
      const { scope, store } = yield* buildStore;
      yield* store.appendUpdate('nt_a', blob(1, 1));
      yield* store.appendUpdate('nt_a', blob(2, 2));
      yield* store.appendUpdate('nt_b', blob(3, 3));

      const rows = yield* store.listUpdates('nt_a');
      assert.deepStrictEqual(
        rows.map(row => ({ seq: row.seq, update: Array.from(row.update) })),
        [
          { seq: 1, update: [1, 1] },
          { seq: 2, update: [2, 2] },
        ]
      );
      assert.deepStrictEqual(yield* store.listUpdates('nt_missing'), []);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('compact replaces the prefix atomically; a later-seq row survives and replays after', () =>
    Effect.gen(function* () {
      const { scope, store } = yield* buildStore;
      yield* store.appendUpdate('nt_a', blob(1));
      yield* store.appendUpdate('nt_a', blob(2));
      yield* store.appendUpdate('nt_a', blob(3));
      yield* store.appendUpdate('nt_a', blob(4)); // seq 4 — lands AFTER the compact window

      yield* store.compact('nt_a', 3, blob(99, 99));

      const rows = yield* store.listUpdates('nt_a');
      assert.deepStrictEqual(
        rows.map(row => ({ seq: row.seq, update: Array.from(row.update) })),
        [
          { seq: 3, update: [99, 99] },
          { seq: 4, update: [4] },
        ]
      );
      // The next append continues above the surviving tail.
      assert.strictEqual(yield* store.appendUpdate('nt_a', blob(5)), 5);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('applyFlush projects the read-model WITHOUT bumping updatedAt', () =>
    Effect.gen(function* () {
      const { scope, store, product } = yield* buildStore;
      // Manual title: content columns update, title/titleSource/updatedAt untouched.
      yield* seedNote(product, 'nt_a', { title: 'My title', titleSource: 'manual' });
      const before = (yield* noteRow(product, 'nt_a'))!;

      yield* store.applyFlush('nt_a', { text: 'body text', markdown: '# body', firstLine: 'body text' });

      const after = (yield* noteRow(product, 'nt_a'))!;
      assert.strictEqual(after.contentText, 'body text');
      assert.strictEqual(after.contentMarkdown, '# body');
      assert.strictEqual(after.firstLine, 'body text');
      assert.strictEqual(after.title, 'My title');
      assert.strictEqual(after.titleSource, 'manual');
      assert.strictEqual(after.updatedAt, before.updatedAt, 'a body save is not a metadata write');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('title-follow matrix: placeholder/first-line follow the first line; changes bump updatedAt monotonically', () =>
    Effect.gen(function* () {
      const { scope, store, product } = yield* buildStore;

      // placeholder + firstLine → 'first-line' title, updatedAt bumped.
      yield* seedNote(product, 'nt_a', { title: 'Untitled note', titleSource: 'placeholder' });
      const beforeA = (yield* noteRow(product, 'nt_a'))!;
      yield* store.applyFlush('nt_a', { text: 'Hello\nWorld', markdown: null, firstLine: 'Hello' });
      const afterA = (yield* noteRow(product, 'nt_a'))!;
      assert.strictEqual(afterA.title, 'Hello');
      assert.strictEqual(afterA.titleSource, 'first-line');
      assert.isAbove(Date.parse(afterA.updatedAt), Date.parse(beforeA.updatedAt));

      // Unchanged derived title → NO bump (same firstLine again).
      yield* store.applyFlush('nt_a', { text: 'Hello\nAgain', markdown: null, firstLine: 'Hello' });
      const afterA2 = (yield* noteRow(product, 'nt_a'))!;
      assert.strictEqual(afterA2.updatedAt, afterA.updatedAt);

      // first-line + empty firstLine → back to the placeholder.
      yield* store.applyFlush('nt_a', { text: '', markdown: null, firstLine: '' });
      const afterA3 = (yield* noteRow(product, 'nt_a'))!;
      assert.strictEqual(afterA3.title, 'Untitled note');
      assert.strictEqual(afterA3.titleSource, 'placeholder');
      assert.isAbove(Date.parse(afterA3.updatedAt), Date.parse(afterA2.updatedAt));

      // A backdated-in-the-future clock: updatedAt = max(now, current + 1ms).
      const future = new Date(Date.now() + 60_000).toISOString();
      yield* seedNote(product, 'nt_b', { title: 'Untitled note', titleSource: 'placeholder', updatedAt: future });
      yield* store.applyFlush('nt_b', { text: 'Fresh', markdown: null, firstLine: 'Fresh' });
      const afterB = (yield* noteRow(product, 'nt_b'))!;
      assert.strictEqual(Date.parse(afterB.updatedAt), Date.parse(future) + 1);

      // Tombstoned/trashed rows keep their derived title but still receive the
      // content projection.
      yield* seedNote(product, 'nt_c', {
        title: 'Untitled note',
        titleSource: 'placeholder',
        deletedAt: new Date().toISOString(),
      });
      yield* store.applyFlush('nt_c', { text: 'Gone', markdown: null, firstLine: 'Gone' });
      const afterC = (yield* noteRow(product, 'nt_c'))!;
      assert.strictEqual(afterC.title, 'Untitled note');
      assert.strictEqual(afterC.titleSource, 'placeholder');
      assert.strictEqual(afterC.contentText, 'Gone');

      // No note row at all → a flush is a no-op (it never creates rows).
      yield* store.applyFlush('nt_missing', { text: 'x', markdown: null, firstLine: 'x' });
      assert.isUndefined(yield* noteRow(product, 'nt_missing'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('registers into the boot-scoped CollabBridge; scope close deregisters', () =>
    Effect.gen(function* () {
      const { scope, store, bridge } = yield* buildStore;
      const current = yield* bridge.current;
      assert.isTrue(Option.isSome(current), 'store registered on acquire');
      assert.strictEqual(Option.getOrThrow(current), store);
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Option.isNone(yield* bridge.current), 'store deregistered on release');
    })
  );
});
