import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { OperationalDb, type NewRecoveryOutbox } from '../../src/main/infra/operational-db/service';
import { MIGRATIONS } from '../../src/main/infra/operational-db/migrations';
import { OperationalDbLive } from '../../src/main/infra/operational-db/live';
import * as schema from '../../src/main/infra/operational-db/schema';

// The db layer never touches electron, but its transitive imports (logger
// service types only) keep the module graph electron-free; no mock needed.
// A temp dir per test file keeps WAL siblings isolated.
const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-db-test-'));

const buildDb = (dbPath: string) => {
  const logger = makeTestLogger();
  return {
    logger,
    layer: OperationalDbLive.pipe(
      Layer.provide(testConfigLayer({ operationalDbPath: dbPath })),
      Layer.provide(logger.layer)
    ),
  };
};

const recordingInput = (
  row: Omit<NewRecoveryOutbox, 'owner' | 'createInput' | 'engineConfig'>
): NewRecoveryOutbox => ({
  ...row,
  owner: { mode: 'local' },
  engineConfig: { engine: 'local', modelId: 'whisper-base-en', byokBaseUrl: null, byokModel: null },
  createInput: {
    recordingId: row.recordingId,
    captureMode: row.captureMode,
    title: 'Recording',
    startedAt: 0,
  },
});

describe('OperationalDb', () => {
  it.effect('reset clears all device rows, retains only reset settings, and preserves migrations', () =>
    Effect.gen(function* () {
      const ctx = yield* Layer.build(buildDb(':memory:').layer);
      const db = Context.get(ctx, OperationalDb);
      yield* db.setSetting('secure:auth.refreshToken.user', 'credential');
      yield* db.setSetting('unknown-old-setting', 'old');
      yield* db.insertRecoveryOutbox(recordingInput({
        recordingId: 'reset-rec', captureMode: 'mic', wavPath: '/recovery.wav',
      }));
      yield* db.upsertLocalModel({
        modelId: 'reset-model', filename: 'model.bin', path: '/model.bin',
        sizeBytes: 1, checksum: 'x', downloadedAt: '2026-01-01', verifiedAt: null,
      });
      const migrations = db.db.select().from(schema.schemaMeta).all();

      yield* db.resetDeviceState({ 'app:pendingPurge': 'marker', 'app:mode': 'local' });

      assert.deepStrictEqual(
        Object.fromEntries(db.db.select().from(schema.settings).all().map(row => [row.key, row.value])),
        { 'app:pendingPurge': 'marker', 'app:mode': 'local' }
      );
      assert.deepStrictEqual(yield* db.listRecoveryOutbox(), []);
      assert.deepStrictEqual(yield* db.listLocalModels(), []);
      assert.deepStrictEqual(db.db.select().from(schema.schemaMeta).all(), migrations);
    }).pipe(Effect.scoped)
  );

  it.effect('reset rolls back the wipe if retaining the purge marker fails', () =>
    Effect.gen(function* () {
      const ctx = yield* Layer.build(buildDb(':memory:').layer);
      const db = Context.get(ctx, OperationalDb);
      yield* db.setSetting('app:pendingPurge', 'retry-me');
      yield* db.setSetting('old-setting', 'old');
      // A failed INSERT after DELETE must not lose the retry marker.
      const result = yield* Effect.exit(db.resetDeviceState({
        'app:pendingPurge': null as unknown as string,
      }));
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(yield* db.getSetting('app:pendingPurge'), 'retry-me');
      assert.strictEqual(yield* db.getSetting('old-setting'), 'old');
    }).pipe(Effect.scoped)
  );

  it.effect('opens, migrates (settings + schema_meta) and round-trips settings', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'roundtrip.db');
      const { layer } = buildDb(dbPath);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const db = Context.get(ctx, OperationalDb);

      assert.isNull(yield* db.getSetting('missing'));
      yield* db.setSetting('widget.geometry', '{"x":1}');
      assert.strictEqual(yield* db.getSetting('widget.geometry'), '{"x":1}');
      // Upsert path.
      yield* db.setSetting('widget.geometry', '{"x":2}');
      assert.strictEqual(yield* db.getSetting('widget.geometry'), '{"x":2}');
      yield* db.deleteSetting('widget.geometry');
      assert.isNull(yield* db.getSetting('widget.geometry'));

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('release CLOSES the database — subsequent queries fail typed', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'close.db');
      const { logger, layer } = buildDb(dbPath);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const db = Context.get(ctx, OperationalDb);
      yield* db.setSetting('k', 'v');

      yield* Scope.close(scope, Exit.void);
      assert.isDefined(logger.find(entry => entry.message === 'operational db closed'));

      const after = yield* Effect.exit(db.getSetting('k'));
      assert.isTrue(Exit.isFailure(after), 'query after close must fail');
    })
  );

  it.effect('migrations are recorded once and never re-applied', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'idempotent.db');

      const first = buildDb(dbPath);
      const scopeA = yield* Scope.make();
      yield* Layer.build(first.layer).pipe(Scope.extend(scopeA));
      yield* Scope.close(scopeA, Exit.void);
      const firstOpen = first.logger.find(entry => entry.message === 'operational db opened');
      assert.deepStrictEqual(
        (firstOpen?.data as { migrationsRun: number[] }).migrationsRun,
        [0, 1, 2, 3, 4, 5, 6, 7]
      );

      const second = buildDb(dbPath);
      const scopeB = yield* Scope.make();
      yield* Layer.build(second.layer).pipe(Scope.extend(scopeB));
      yield* Scope.close(scopeB, Exit.void);
      const secondOpen = second.logger.find(entry => entry.message === 'operational db opened');
      assert.deepStrictEqual((secondOpen?.data as { migrationsRun: number[] }).migrationsRun, []);
    })
  );

  it.effect('migration 0001 upgrades an existing settings-only DB without data loss', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'upgrade.db');
      // Seed a legacy operational.db: settings and schema_meta only, migration 0
      // already applied, with a persisted setting we must not lose.
      const seed = new DatabaseSync(dbPath);
      seed.exec(
        'CREATE TABLE `schema_meta` (`version` integer PRIMARY KEY NOT NULL, `name` text NOT NULL, `applied_at` text NOT NULL)'
      );
      seed.exec(
        'CREATE TABLE `settings` (`key` text PRIMARY KEY NOT NULL, `value` text NOT NULL, `updated_at` text NOT NULL)'
      );
      seed
        .prepare('INSERT INTO schema_meta (version, name, applied_at) VALUES (?, ?, ?)')
        .run(0, 'init', new Date().toISOString());
      seed
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('widget.geometry', '{"y":0.5}', new Date().toISOString());
      seed.close();

      const { logger, layer } = buildDb(dbPath);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const db = Context.get(ctx, OperationalDb);

      // Only 0001 ran — 0000 was already in the ledger (versioned upgrade).
      const opened = logger.find(entry => entry.message === 'operational db opened');
      assert.deepStrictEqual(
        (opened?.data as { migrationsRun: number[] }).migrationsRun,
        [1, 2, 3, 4, 5, 6, 7]
      );
      // Pre-existing setting survived the upgrade (no data loss).
      assert.strictEqual(yield* db.getSetting('widget.geometry'), '{"y":0.5}');
      // The freshly-migrated table is usable.
      yield* db.insertRecoveryOutbox(
        recordingInput({
          recordingId: 'rec_1',
          captureMode: 'dual',
          wavPath: '/tmp/rec_1.wav',
        })
      );
      assert.strictEqual((yield* db.getRecoveryOutbox('rec_1'))?.status, 'capturing');

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('recovery outbox: insert → update → list → resolve round-trip', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'outbox.db');
      const { layer } = buildDb(dbPath);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const db = Context.get(ctx, OperationalDb);

      assert.isNull(yield* db.getRecoveryOutbox('rec_missing'));
      assert.deepStrictEqual(yield* db.listRecoveryOutbox(), []);

      // Acquire: row opens 'capturing' with defaulted drain bookkeeping.
      yield* db.insertRecoveryOutbox(
        recordingInput({
          recordingId: 'rec_a',
          noteId: 'note_a',
          captureMode: 'dual',
          wavPath: '/tmp/a.wav',
          engine: 'local',
        })
      );
      const acquired = yield* db.getRecoveryOutbox('rec_a');
      assert.strictEqual(acquired?.status, 'capturing');
      assert.strictEqual(acquired?.attemptCount, 0);
      assert.isNull(acquired?.nextAttemptAt);
      assert.isNull(acquired?.lastChunkIndex);
      assert.strictEqual(acquired?.noteId, 'note_a');
      assert.strictEqual(acquired?.captureMode, 'dual');
      assert.strictEqual(acquired?.engine, 'local', 'frozen engine kind round-trips');
      assert.deepStrictEqual(acquired?.pauseCutPoints, []);
      assert.deepStrictEqual(acquired?.owner, { mode: 'local' });
      assert.strictEqual(acquired?.phase, 'create');
      assert.strictEqual(acquired?.createInput?.recordingId, 'rec_a');
      assert.isNull(acquired?.endedAt);
      assert.isNull(acquired?.durationMs);

      // Note-less recording → noteId null.
      yield* db.insertRecoveryOutbox(
        recordingInput({
          recordingId: 'rec_b',
          captureMode: 'mic',
          wavPath: '/tmp/b.wav',
        })
      );
      assert.isNull((yield* db.getRecoveryOutbox('rec_b'))?.noteId);
      // Engine omitted ⇒ NULL — the drain reads a NULL engine as legacy 'cloud'.
      assert.isNull((yield* db.getRecoveryOutbox('rec_b'))?.engine);

      // Drain bookkeeping: bump attempt, advance cursor, park, record error.
      yield* db.updateRecoveryOutbox('rec_a', {
        status: 'interrupted',
        attemptCount: 2,
        nextAttemptAt: '2026-07-12T00:00:00.000Z',
        lastChunkIndex: 5,
        pauseCutPoints: [
          { micSamples: 96_000, systemSamples: 48_000 },
          { micSamples: 240_000, systemSamples: 240_000 },
        ],
        lastError: 'boom',
      });
      const parked = yield* db.getRecoveryOutbox('rec_a');
      assert.strictEqual(parked?.status, 'interrupted');
      assert.strictEqual(parked?.attemptCount, 2);
      assert.strictEqual(parked?.nextAttemptAt, '2026-07-12T00:00:00.000Z');
      assert.strictEqual(parked?.lastChunkIndex, 5);
      assert.deepStrictEqual(parked?.pauseCutPoints, [
        { micSamples: 96_000, systemSamples: 48_000 },
        { micSamples: 240_000, systemSamples: 240_000 },
      ]);
      assert.strictEqual(parked?.lastError, 'boom');
      assert.isTrue((parked?.updatedAt ?? '') >= (parked?.createdAt ?? ''));

      // Partial patch: untouched fields stay; explicit null clears a nullable column.
      yield* db.updateRecoveryOutbox('rec_a', { lastError: null });
      const cleared = yield* db.getRecoveryOutbox('rec_a');
      assert.isNull(cleared?.lastError);
      assert.strictEqual(cleared?.attemptCount, 2);
      assert.strictEqual(cleared?.status, 'interrupted');

      // List is the drain's work set — both unresolved rows present.
      const list = yield* db.listRecoveryOutbox();
      assert.strictEqual(list.length, 2);
      assert.deepStrictEqual(list.map(row => row.recordingId).sort(), ['rec_a', 'rec_b']);

      // Resolve = delete row (no residue left behind).
      yield* db.deleteRecoveryOutbox('rec_a');
      assert.isNull(yield* db.getRecoveryOutbox('rec_a'));
      assert.deepStrictEqual(
        (yield* db.listRecoveryOutbox()).map(row => row.recordingId),
        ['rec_b']
      );

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('recovery outbox survives a DB reopen — the crash-recovery premise', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'survive.db');

      const first = buildDb(dbPath);
      const scopeA = yield* Scope.make();
      const ctxA = yield* Layer.build(first.layer).pipe(Scope.extend(scopeA));
      const dbA = Context.get(ctxA, OperationalDb);
      yield* dbA.insertRecoveryOutbox(
        recordingInput({
          recordingId: 'rec_kill',
          noteId: 'note_x',
          captureMode: 'system',
          wavPath: '/tmp/kill.wav',
          status: 'capturing',
        })
      );
      // Close = the process dying mid-capture (kill -9 leaves the 'capturing' row).
      yield* Scope.close(scopeA, Exit.void);

      const second = buildDb(dbPath);
      const scopeB = yield* Scope.make();
      const ctxB = yield* Layer.build(second.layer).pipe(Scope.extend(scopeB));
      const dbB = Context.get(ctxB, OperationalDb);
      const reopened = second.logger.find(entry => entry.message === 'operational db opened');
      assert.deepStrictEqual((reopened?.data as { migrationsRun: number[] }).migrationsRun, []);
      const survivor = yield* dbB.getRecoveryOutbox('rec_kill');
      assert.strictEqual(survivor?.status, 'capturing');

      assert.strictEqual(survivor?.wavPath, '/tmp/kill.wav');
      assert.strictEqual((yield* dbB.listRecoveryOutbox()).length, 1);

      yield* Scope.close(scopeB, Exit.void);
    })
  );

  it.effect('local models: upsert → list → re-upsert keeps createdAt → delete', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'local-models.db');
      const { layer } = buildDb(dbPath);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const db = Context.get(ctx, OperationalDb);

      assert.deepStrictEqual(yield* db.listLocalModels(), []);
      yield* db.upsertLocalModel({
        modelId: 'whisper-base-en',
        filename: 'ggml-base.en.bin',
        path: '/models/ggml-base.en.bin',
        sizeBytes: 147_964_211,
        checksum: '137c40403d78fd54d454da0f9bd998f78703390c',
        downloadedAt: '2026-09-01T00:00:00.000Z',
        verifiedAt: '2026-09-01T00:00:00.000Z',
      });
      const [inserted] = yield* db.listLocalModels();
      assert.strictEqual(inserted?.modelId, 'whisper-base-en');
      assert.strictEqual(inserted?.sizeBytes, 147_964_211);
      assert.strictEqual(inserted?.verifiedAt, '2026-09-01T00:00:00.000Z');

      // Upsert on the same id replaces the mutable columns and keeps createdAt.
      yield* db.upsertLocalModel({
        modelId: 'whisper-base-en',
        filename: 'ggml-base.en.bin',
        path: '/models/ggml-base.en.bin',
        sizeBytes: 147_964_211,
        checksum: '137c40403d78fd54d454da0f9bd998f78703390c',
        downloadedAt: '2026-09-02T00:00:00.000Z',
        verifiedAt: null,
      });
      const rows = yield* db.listLocalModels();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.downloadedAt, '2026-09-02T00:00:00.000Z');
      assert.isNull(rows[0]?.verifiedAt);
      assert.strictEqual(rows[0]?.createdAt, inserted?.createdAt);

      yield* db.deleteLocalModel('whisper-base-en');
      assert.deepStrictEqual(yield* db.listLocalModels(), []);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('open/migrate failure is a typed BootError, not an exit', () =>
    Effect.gen(function* () {
      // Parent "directory" is a regular file — mkdir/open must fail.
      const blocker = path.join(tempDir, 'blocker-file');
      writeFileSync(blocker, 'not a dir');
      const { layer } = buildDb(path.join(blocker, 'db.sqlite'));

      const scope = yield* Scope.make();
      const exit = yield* Effect.exit(Layer.build(layer).pipe(Scope.extend(scope)));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(JSON.stringify(exit.cause), 'BootError');
        assert.include(JSON.stringify(exit.cause), 'operational-db');
      }
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('Recovery ownership migration', () => {
  it.effect('retains existing audio jobs without assigning an owner or processing phase', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, 'ownerless-upgrade.db');
      const seed = new DatabaseSync(dbPath);
      for (const migration of MIGRATIONS.filter(migration => migration.version < 5)) {
        seed.exec(migration.sql);
        seed
          .prepare('INSERT INTO schema_meta (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date(0).toISOString());
      }
      seed
        .prepare(
          'INSERT INTO recovery_outbox (recording_id, capture_mode, wav_path, status, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          'rec_existing',
          'mic',
          '/retained/audio',
          'finalizing',
          'stop-incomplete',
          new Date(0).toISOString(),
          new Date(0).toISOString()
        );
      seed.close();
      const { layer } = buildDb(dbPath);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const row = yield* Context.get(ctx, OperationalDb).getRecoveryOutbox('rec_existing');
      assert.strictEqual(row?.wavPath, '/retained/audio');
      assert.strictEqual(row?.lastError, 'stop-incomplete');
      assert.isNull(row?.owner);
      assert.isNull(row?.createInput);
      assert.isNull(row?.engineConfig);

      assert.isNull(row?.phase);
      yield* Scope.close(scope, Exit.void);
    })
  );
});
