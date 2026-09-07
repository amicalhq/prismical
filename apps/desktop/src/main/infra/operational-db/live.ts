/**
 * Operational store — file-backed SQLite at AppConfig.operationalDbPath,
 * opened with Effect.acquireRelease and closed on release; the leak gate
 * asserts it.
 *
 * Driver: better-sqlite3 over drizzle-orm/better-sqlite3 (synchronous; the
 * N-API prebuild ships inside the package). The native binding cannot ride
 * the forge-vite main bundle, so better-sqlite3 is a rollup external
 * (vite.main.config.mts) shipped as real node_modules in the package
 * (EXTERNAL_DEPENDENCIES in forge.config.ts).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Effect, Layer } from 'effect';
import { BootError } from '../../runtime/boot-error';
import { AppConfig } from '../config/service';
import { MainLogger } from '../logging/service';
import { applyMigrations } from './migrations';
import * as schema from './schema';
import { DbError, OperationalDb, type OperationalDbService } from './service';

const openDatabase = (dbPath: string): Database.Database => {
  if (dbPath === ':memory:') {
    return new Database(':memory:');
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const client = new Database(dbPath);
  try {
    // better-sqlite3 defaults journal_mode to `delete` for a new file — keep
    // the WAL the node:sqlite era ran with.
    client.pragma('journal_mode = WAL');
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
};

export const OperationalDbLive: Layer.Layer<OperationalDb, BootError, AppConfig | MainLogger> =
  Layer.scoped(
    OperationalDb,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const log = (yield* MainLogger).scoped('db');

      const handle = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const client = openDatabase(config.operationalDbPath);
            try {
              const ran = applyMigrations(client);
              return { client, ran };
            } catch (error) {
              client.close();
              throw error;
            }
          },
          catch: cause => new BootError({ stage: 'operational-db', cause }),
        }).pipe(
          Effect.tap(({ ran }) =>
            log.info('operational db opened', {
              path: config.operationalDbPath,
              migrationsRun: ran,
            })
          )
        ),
        ({ client }) =>
          Effect.sync(() => {
            client.close();
          }).pipe(Effect.zipRight(log.info('operational db closed')))
      );

      const db = drizzle(handle.client, { schema });

      const tryDb = <A>(op: string, run: () => A): Effect.Effect<A, DbError> =>
        Effect.try({ try: run, catch: cause => new DbError({ op, cause }) });

      const service: OperationalDbService = {
        db,
        getSetting: key =>
          tryDb('getSetting', () => {
            const row = db
              .select({ value: schema.settings.value })
              .from(schema.settings)
              .where(eq(schema.settings.key, key))
              .get();
            return row?.value ?? null;
          }),
        setSetting: (key, value) =>
          tryDb('setSetting', () => {
            const updatedAt = new Date().toISOString();
            db.insert(schema.settings)
              .values({ key, value, updatedAt })
              .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt } })
              .run();
          }),
        deleteSetting: key =>
          tryDb('deleteSetting', () => {
            db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
          }),
        deleteSettingsByPrefix: prefix =>
          tryDb('deleteSettingsByPrefix', () => {
            // Match in JS rather than with LIKE: `_`/`%` in a prefix such as
            // `pref:` would need an ESCAPE clause, and the settings table is
            // a few dozen rows.
            const rows = db.select({ key: schema.settings.key }).from(schema.settings).all();
            const keys = rows.map(row => row.key).filter(key => key.startsWith(prefix));
            if (keys.length === 0) return;
            db.delete(schema.settings).where(inArray(schema.settings.key, keys)).run();
          }),
        insertRecoveryOutbox: row =>
          tryDb('insertRecoveryOutbox', () => {
            const now = new Date().toISOString();
            db.insert(schema.recoveryOutbox)
              .values({
                recordingId: row.recordingId,
                owner: row.owner,
                createInput: row.createInput,
                engineConfig: row.engineConfig,
                stagingMode: row.stagingMode ?? null,
                phase: row.phase ?? 'create',
                noteId: row.noteId ?? null,
                captureMode: row.captureMode,
                wavPath: row.wavPath,
                engine: row.engine ?? null,
                status: row.status ?? 'capturing',
                pauseCutPoints: row.pauseCutPoints ?? [],
                createdAt: now,
                updatedAt: now,
              })
              .run();
          }),
        updateRecoveryOutbox: (recordingId, patch) =>
          tryDb('updateRecoveryOutbox', () => {
            const set: Partial<typeof schema.recoveryOutbox.$inferInsert> = {
              updatedAt: new Date().toISOString(),
            };
            if (patch.status !== undefined) set.status = patch.status;
            if (patch.stagingMode !== undefined) set.stagingMode = patch.stagingMode;
            if (patch.phase !== undefined) set.phase = patch.phase;
            if (patch.endedAt !== undefined) set.endedAt = patch.endedAt;
            if (patch.durationMs !== undefined) set.durationMs = patch.durationMs;
            if (patch.attemptCount !== undefined) set.attemptCount = patch.attemptCount;
            if (patch.nextAttemptAt !== undefined) set.nextAttemptAt = patch.nextAttemptAt;
            if (patch.lastChunkIndex !== undefined) set.lastChunkIndex = patch.lastChunkIndex;
            if (patch.pauseCutPoints !== undefined) set.pauseCutPoints = patch.pauseCutPoints;
            if (patch.lastError !== undefined) set.lastError = patch.lastError;
            db.update(schema.recoveryOutbox)
              .set(set)
              .where(eq(schema.recoveryOutbox.recordingId, recordingId))
              .run();
          }),
        getRecoveryOutbox: recordingId =>
          tryDb('getRecoveryOutbox', () => {
            const row = db
              .select()
              .from(schema.recoveryOutbox)
              .where(eq(schema.recoveryOutbox.recordingId, recordingId))
              .get();
            return row ?? null;
          }),
        listRecoveryOutbox: () =>
          tryDb('listRecoveryOutbox', () =>
            db.select().from(schema.recoveryOutbox).orderBy(schema.recoveryOutbox.createdAt).all()
          ),
        deleteRecoveryOutbox: recordingId =>
          tryDb('deleteRecoveryOutbox', () => {
            db.delete(schema.recoveryOutbox)
              .where(eq(schema.recoveryOutbox.recordingId, recordingId))
              .run();
          }),
        listLocalModels: () =>
          tryDb('listLocalModels', () =>
            db.select().from(schema.localModel).orderBy(schema.localModel.modelId).all()
          ),
        upsertLocalModel: row =>
          tryDb('upsertLocalModel', () => {
            const now = new Date().toISOString();
            const values = {
              modelId: row.modelId,
              filename: row.filename,
              path: row.path,
              sizeBytes: row.sizeBytes,
              checksum: row.checksum,
              downloadedAt: row.downloadedAt,
              verifiedAt: row.verifiedAt,
              updatedAt: now,
            };
            db.insert(schema.localModel)
              .values({ ...values, createdAt: now })
              .onConflictDoUpdate({ target: schema.localModel.modelId, set: values })
              .run();
          }),
        deleteLocalModel: modelId =>
          tryDb('deleteLocalModel', () => {
            db.delete(schema.localModel).where(eq(schema.localModel.modelId, modelId)).run();
          }),
        deleteAllLocalModels: () =>
          tryDb('deleteAllLocalModels', () => {
            db.delete(schema.localModel).run();
          }),
      };
      return service;
    })
  );
