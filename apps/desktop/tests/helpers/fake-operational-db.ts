/**
 * A fake OperationalDb for the settings/reset tests: an in-memory KV Map behind
 * the real OperationalDbService shape, with seedable rows and boot-read failure
 * injection. The recovery-outbox methods die by default (a call would be a bug in
 * the settings tests); pass `options.recovery` to back them with an in-memory Map
 * (the reset test needs list and delete). The local-model methods
 * follow the same opt-in: pass `options.localModels` to back them with a Map.
 * Electron-free.
 */
import { Effect, Layer } from 'effect';
import {
  DbError,
  OperationalDb,
  type LocalModelRow,
  type OperationalDbService,
  type RecoveryOutboxRow,
} from '../../src/main/infra/operational-db/service';

export interface FakeOperationalDb {
  readonly layer: Layer.Layer<OperationalDb>;
  /** The backing store — inspect writes or pre-seed rows. */
  readonly store: Map<string, string>;
  /** The backing recovery-outbox rows (present only when `options.recovery` was passed). */
  readonly recovery: Map<string, RecoveryOutboxRow>;
  /** The backing installed-model rows (present only when `options.localModels` was passed). */
  readonly localModels: Map<string, LocalModelRow>;
  /** Arm getSetting to fail with a DbError (a boot-read failure). */
  readonly failGet: (fail: boolean) => void;
}

export const makeFakeOperationalDb = (
  seed: Record<string, string> = {},
  options?: {
    recovery?: ReadonlyArray<RecoveryOutboxRow>;
    localModels?: ReadonlyArray<LocalModelRow>;
  }
): FakeOperationalDb => {
  const store = new Map<string, string>(Object.entries(seed));
  const recoveryEnabled = options?.recovery !== undefined;
  const recovery = new Map<string, RecoveryOutboxRow>(
    (options?.recovery ?? []).map(row => [row.recordingId, row])
  );
  const localModelsEnabled = options?.localModels !== undefined;
  const localModels = new Map<string, LocalModelRow>(
    (options?.localModels ?? []).map(row => [row.modelId, row])
  );
  let getFails = false;
  const die = (op: string) =>
    Effect.die(new Error(`fake operational db: ${op} is unused in this test`));
  const recoveryOr = <A>(op: string, effect: Effect.Effect<A, DbError>) =>
    recoveryEnabled ? effect : die(op);
  const localModelsOr = <A>(op: string, effect: Effect.Effect<A, DbError>) =>
    localModelsEnabled ? effect : die(op);
  const service: OperationalDbService = {
    db: undefined as unknown as OperationalDbService['db'],
    getSetting: key =>
      getFails
        ? Effect.fail(new DbError({ op: 'getSetting', cause: 'injected' }))
        : Effect.sync(() => store.get(key) ?? null),
    setSetting: (key, value) =>
      Effect.sync(() => {
        store.set(key, value);
      }),
    deleteSetting: key =>
      Effect.sync(() => {
        store.delete(key);
      }),
    deleteSettingsByPrefix: prefix =>
      Effect.sync(() => {
        for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
      }),
    insertRecoveryOutbox: row =>
      recoveryOr(
        'insertRecoveryOutbox',
        Effect.sync(() => {
          recovery.set(row.recordingId, row as unknown as RecoveryOutboxRow);
        })
      ),
    updateRecoveryOutbox: () => die('updateRecoveryOutbox'),
    getRecoveryOutbox: recordingId =>
      recoveryOr(
        'getRecoveryOutbox',
        Effect.sync(() => recovery.get(recordingId) ?? null)
      ),
    listRecoveryOutbox: () =>
      recoveryOr(
        'listRecoveryOutbox',
        Effect.sync(() => [...recovery.values()])
      ),
    deleteRecoveryOutbox: recordingId =>
      recoveryOr(
        'deleteRecoveryOutbox',
        Effect.sync(() => {
          recovery.delete(recordingId);
        })
      ),
    listLocalModels: () =>
      localModelsOr(
        'listLocalModels',
        Effect.sync(() => [...localModels.values()])
      ),
    upsertLocalModel: row =>
      localModelsOr(
        'upsertLocalModel',
        Effect.sync(() => {
          const now = new Date().toISOString();
          const existing = localModels.get(row.modelId);
          localModels.set(row.modelId, {
            ...row,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          });
        })
      ),
    deleteLocalModel: modelId =>
      localModelsOr(
        'deleteLocalModel',
        Effect.sync(() => {
          localModels.delete(modelId);
        })
      ),
    deleteAllLocalModels: () =>
      localModelsOr(
        'deleteAllLocalModels',
        Effect.sync(() => {
          localModels.clear();
        })
      ),
  };
  return {
    layer: Layer.succeed(OperationalDb, service),
    store,
    recovery,
    localModels,
    failGet: fail => {
      getFails = fail;
    },
  };
};
