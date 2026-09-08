import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Cause, Context, Effect, Exit, Layer, Option, Scope } from 'effect';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import type { AppConfigService } from '../../src/main/infra/config/service';
import { makeProductDbLayer, redactCause } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import {
  ProductDb,
  ProductDbError,
  type ProductDbService,
  type ProductDbTarget,
} from '../../src/main/infra/product-db/service';

// The db layer never touches electron, but its transitive imports (logger
// service types only) keep the module graph electron-free; no mock needed.
// A temp dir per test file keeps WAL siblings isolated.
const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-db-test-'));

const buildDb = (target: ProductDbTarget, overrides: Partial<AppConfigService> = {}) => {
  const logger = makeTestLogger();
  return {
    logger,
    layer: makeProductDbLayer(target).pipe(
      Layer.provide(testConfigLayer(overrides)),
      Layer.provide(logger.layer)
    ),
  };
};

const insertNote = (svc: ProductDbService, id: string, title: string, contentText: string) =>
  Effect.promise(async () => {
    const now = new Date().toISOString();
    await svc.db.insert(schema.note).values({
      id,
      title,
      contentText,
      createdAt: now,
      updatedAt: now,
      metadataUpdatedAt: now,
    });
  });

/** note ids matching an FTS5 query, via the raw client (drizzle cannot MATCH). */
const ftsMatch = (svc: ProductDbService, query: string) =>
  Effect.sync(() =>
    (
      svc.client
        .prepare('SELECT note_id FROM note_fts WHERE note_fts MATCH ?')
        .pluck()
        .all(query) as unknown[]
    ).map(String)
  );

describe('ProductDb', () => {
  it.effect('migrations are recorded once and never re-applied', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'idempotent.db');

      const first = buildDb({ kind: 'local' }, { localDbPath: dbPath });
      const scopeA = yield* Scope.make();
      yield* Layer.build(first.layer).pipe(Scope.extend(scopeA));
      yield* Scope.close(scopeA, Exit.void);
      const firstOpen = first.logger.find(entry => entry.message === 'product db opened');
      assert.deepStrictEqual((firstOpen?.data as { migrationsRun: number[] }).migrationsRun, [0, 1, 2]);

      const second = buildDb({ kind: 'local' }, { localDbPath: dbPath });
      const scopeB = yield* Scope.make();
      yield* Layer.build(second.layer).pipe(Scope.extend(scopeB));
      yield* Scope.close(scopeB, Exit.void);
      const secondOpen = second.logger.find(entry => entry.message === 'product db opened');
      assert.deepStrictEqual((secondOpen?.data as { migrationsRun: number[] }).migrationsRun, []);
    })
  );

  it.effect('local target creates the file at the configured localDbPath', () =>
    Effect.gen(function* () {
      // Nested path also proves the recursive mkdir at open.
      const dbPath = path.join(tempDir, 'local-target', 'local.db');
      const { layer } = buildDb({ kind: 'local' }, { localDbPath: dbPath });
      const scope = yield* Scope.make();
      yield* Layer.build(layer).pipe(Scope.extend(scope));
      assert.isTrue(existsSync(dbPath), 'local.db must exist at localDbPath');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('cloud-cache target creates the encoded per-(sub, org) filename', () =>
    Effect.gen(function* () {
      const cloudCacheDir = path.join(tempDir, 'cloud-cache');

      // Identity components are percent-encoded (no ':' or '/' — Windows-safe).
      const withOrg = buildDb(
        { kind: 'cloud-cache', sub: 'user@example.com', orgId: 'org/1' },
        { cloudCacheDir }
      );
      const scopeA = yield* Scope.make();
      yield* Layer.build(withOrg.layer).pipe(Scope.extend(scopeA));
      assert.isTrue(existsSync(path.join(cloudCacheDir, 'user%40example.com__org%2F1.db')));
      yield* Scope.close(scopeA, Exit.void);

      // Missing orgId folds to 'default' (the eventkit sequence-key idiom).
      const withoutOrg = buildDb({ kind: 'cloud-cache', sub: 'usr_a' }, { cloudCacheDir });
      const scopeB = yield* Scope.make();
      yield* Layer.build(withoutOrg.layer).pipe(Scope.extend(scopeB));
      assert.isTrue(existsSync(path.join(cloudCacheDir, 'usr_a__default.db')));
      yield* Scope.close(scopeB, Exit.void);
    })
  );

  it.effect('a cloud-cache open logs the REDACTED identity — never the sub or the path', () =>
    Effect.gen(function* () {
      const cloudCacheDir = path.join(tempDir, 'redaction');
      const sub = 'usr_abcdef012345';
      const { logger, layer } = buildDb(
        { kind: 'cloud-cache', sub, orgId: 'org_secret_1' },
        { cloudCacheDir }
      );
      const scope = yield* Scope.make();
      yield* Layer.build(layer).pipe(Scope.extend(scope));

      const opened = logger.find(entry => entry.message === 'product db opened');
      const data = (opened?.data ?? {}) as Record<string, unknown>;
      assert.strictEqual(data.sub, 'usr_ab…');
      assert.strictEqual(data.orgId, 'org_se…');
      // The cache PATH embeds the encoded identity — it is never logged.
      assert.isUndefined(data.path);
      assert.notInclude(JSON.stringify(data), sub);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('an open FAILURE scrubs the identity out of the cause it reports', () =>
    Effect.gen(function* () {
      const cloudCacheDir = path.join(tempDir, 'open-failure');
      const sub = 'usr_abcdef012345';
      // A DIRECTORY where the database file belongs. better-sqlite3's own
      // open error carries no path, so the reported cause is the store's
      // `<redacted target>: <driver message>` label — the scrub stays as a
      // defence for any error that does quote the (encoded) filename.
      mkdirSync(path.join(cloudCacheDir, `${sub}__org_secret_1.db`), { recursive: true });

      const { layer } = buildDb(
        { kind: 'cloud-cache', sub, orgId: 'org_secret_1' },
        { cloudCacheDir }
      );
      const scope = yield* Scope.make();
      const exit = yield* Effect.exit(Layer.build(layer).pipe(Scope.extend(scope)));

      assert.isTrue(Exit.isFailure(exit), 'opening a directory as a database must fail');
      const failure = Exit.isFailure(exit)
        ? Option.getOrNull(Cause.failureOption(exit.cause))
        : null;
      assert.instanceOf(failure, ProductDbError);
      // Every consumer logs `cause: String(error.cause)` — that is the string
      // that must not carry the identity.
      assert.strictEqual((failure as ProductDbError).op, 'open');
      const reported = String((failure as ProductDbError).cause);
      assert.notInclude(reported, sub);
      assert.notInclude(reported, encodeURIComponent(sub));
      assert.include(reported, 'usr_ab…');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it('redactCause scrubs an identity a cause DOES quote (raw and percent-encoded)', () => {
    // No driver quotes the filename today (better-sqlite3's open error carries
    // no path), so the open-failure test above cannot reach the scrub — drive
    // it directly with the shapes a filesystem error would embed.
    const target = { kind: 'cloud-cache', sub: 'user@example.com', orgId: 'org/secret/1' } as const;
    const cause = new Error(
      `EACCES: permission denied, open '/caches/${encodeURIComponent(target.sub)}__${encodeURIComponent(target.orgId)}.db' (${target.sub} / ${target.orgId})`
    );
    const reported = String(redactCause(target, cause));
    assert.notInclude(reported, target.sub);
    assert.notInclude(reported, encodeURIComponent(target.sub));
    assert.notInclude(reported, target.orgId);
    assert.notInclude(reported, encodeURIComponent(target.orgId));
    assert.include(reported, 'cloud-cache user@e…/org/se…: ');
    assert.include(reported, 'EACCES: permission denied');
    // A no-org cache is labelled `none`, never a scrubbable sentinel word.
    const noOrg = String(redactCause({ kind: 'cloud-cache', sub: target.sub }, new Error('default DEFAULT')));
    assert.include(noOrg, 'cloud-cache user@e…/none: Error: default DEFAULT');
    // The local store carries no identity: its cause passes through untouched.
    const local = new Error('unable to open database file');
    assert.strictEqual(redactCause({ kind: 'local' }, local), local);
  });

  it.effect('note_fts round-trip: match, content update, soft delete/trash, restore', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'fts.db');
      const { layer } = buildDb({ kind: 'local' }, { localDbPath: dbPath });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const svc = Context.get(ctx, ProductDb);

      yield* insertNote(svc, 'nt_1', 'Quarterly planning', 'alpha bravo');
      assert.deepStrictEqual(yield* ftsMatch(svc, 'title:quarterly'), ['nt_1']);
      assert.deepStrictEqual(yield* ftsMatch(svc, 'bravo'), ['nt_1']);

      // Content update re-indexes: the new term matches, the old one is gone.
      yield* Effect.promise(async () => {
        await svc.db
          .update(schema.note)
          .set({ contentText: 'charlie delta', updatedAt: new Date().toISOString() })
          .where(eq(schema.note.id, 'nt_1'));
      });
      assert.deepStrictEqual(yield* ftsMatch(svc, 'charlie'), ['nt_1']);
      assert.deepStrictEqual(yield* ftsMatch(svc, 'bravo'), []);

      // Soft delete drops the row from the index …
      yield* Effect.promise(async () => {
        await svc.db
          .update(schema.note)
          .set({ deletedAt: new Date().toISOString() })
          .where(eq(schema.note.id, 'nt_1'));
      });
      assert.deepStrictEqual(yield* ftsMatch(svc, 'charlie'), []);

      // … and clearing it re-indexes the row.
      yield* Effect.promise(async () => {
        await svc.db
          .update(schema.note)
          .set({ deletedAt: null })
          .where(eq(schema.note.id, 'nt_1'));
      });
      assert.deepStrictEqual(yield* ftsMatch(svc, 'charlie'), ['nt_1']);

      // Trash is treated exactly like soft delete.
      yield* Effect.promise(async () => {
        await svc.db
          .update(schema.note)
          .set({ trashedAt: new Date().toISOString() })
          .where(eq(schema.note.id, 'nt_1'));
      });
      assert.deepStrictEqual(yield* ftsMatch(svc, 'charlie'), []);

      // Hard delete leaves no index residue.
      yield* Effect.promise(async () => {
        await svc.db.delete(schema.note).where(eq(schema.note.id, 'nt_1'));
      });
      const count = yield* Effect.sync(() =>
        svc.client.prepare('SELECT count(*) AS n FROM note_fts').pluck().get()
      );
      assert.strictEqual(Number(count), 0);

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('release CLOSES the database — subsequent queries fail', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'close.db');
      const { logger, layer } = buildDb({ kind: 'local' }, { localDbPath: dbPath });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const svc = Context.get(ctx, ProductDb);
      yield* insertNote(svc, 'nt_close', 'Close me', '');

      yield* Scope.close(scope, Exit.void);
      assert.isDefined(logger.find(entry => entry.message === 'product db closed'));

      const after = yield* Effect.exit(Effect.try(() => svc.db.select().from(schema.note).all()));
      assert.isTrue(Exit.isFailure(after), 'query after close must fail');
    })
  );

  it.effect("':memory:' localDbPath works (test default)", () =>
    Effect.gen(function* () {
      const { layer } = buildDb({ kind: 'local' });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const svc = Context.get(ctx, ProductDb);

      yield* insertNote(svc, 'nt_mem', 'In memory', 'ephemeral text');
      const rows = yield* Effect.sync(() => svc.db.select().from(schema.note).all());
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.title, 'In memory');
      // FTS triggers ran in memory too.
      assert.deepStrictEqual(yield* ftsMatch(svc, 'ephemeral'), ['nt_mem']);

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('driver smoke: FTS5 build, WAL on file / memory on :memory:, porter + bm25, atomic immediate transaction', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'driver-smoke.db');
      const file = buildDb({ kind: 'local' }, { localDbPath: dbPath });
      const memory = buildDb({ kind: 'local' });
      const scope = yield* Scope.make();
      const fileSvc = Context.get(yield* Layer.build(file.layer).pipe(Scope.extend(scope)), ProductDb);
      const memSvc = Context.get(
        yield* Layer.build(memory.layer).pipe(Scope.extend(scope)),
        ProductDb
      );

      // The bundled SQLite must carry FTS5 (note_fts, MATCH, bm25, porter).
      assert.strictEqual(
        fileSvc.client.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5')").pluck().get(),
        1
      );
      // The open pragma sticks on a file store; a memory store answers 'memory'.
      assert.strictEqual(fileSvc.client.pragma('journal_mode', { simple: true }), 'wal');
      assert.strictEqual(memSvc.client.pragma('journal_mode', { simple: true }), 'memory');

      // Porter stemming (migration 0002) + title-weighted bm25 ordering.
      yield* insertNote(fileSvc, 'nt_body', 'Roadmap', 'the timeline slipped');
      yield* insertNote(fileSvc, 'nt_title', 'Timeline review', 'notes');
      assert.deepStrictEqual(
        fileSvc.client
          .prepare(
            'SELECT note_id FROM note_fts WHERE note_fts MATCH ? ORDER BY bm25(note_fts, 0.0, 10.0, 1.0)'
          )
          .pluck()
          .all('timelines'),
        ['nt_title', 'nt_body']
      );

      // An immediate transaction rolls back WHOLESALE when a later statement
      // fails — the guarantee both migrators and the collab compact rely on.
      const exit = yield* Effect.exit(
        Effect.try(() =>
          fileSvc.client
            .transaction(() => {
              fileSvc.client
                .prepare('INSERT INTO schema_meta (version, name, applied_at) VALUES (?, ?, ?)')
                .run(900, 'smoke', 'now');
              fileSvc.client
                .prepare('INSERT INTO schema_meta (version, name, applied_at) VALUES (?, ?, ?)')
                .run(0, 'duplicate', 'now');
            })
            .immediate()
        )
      );
      assert.isTrue(Exit.isFailure(exit), 'the duplicate ledger row must fail');
      assert.strictEqual(
        fileSvc.client.prepare('SELECT count(*) FROM schema_meta WHERE version = 900').pluck().get(),
        0
      );
      assert.isFalse(fileSvc.client.inTransaction);

      yield* Scope.close(scope, Exit.void);
    })
  );
});
