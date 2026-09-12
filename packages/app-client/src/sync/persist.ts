import { applyChanges, observable, type Change } from '@legendapp/state';
import type { ObservablePersistPlugin, PersistMetadata } from '@legendapp/state/sync';
import { partitionDatabaseName, SYNC_DB_VERSION, SYNC_TABLE_NAMES, type SyncPartition } from './partition';

// Preserve the existing Legend IndexedDB format so installed desktop partitions
// keep their rows, delivery cursor, and queued writes when changing adapters.
const METADATA_ID = '__legend_metadata';
const samePending = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('Local note storage transaction failed'));
  });
}

function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local note storage read failed'));
  });
}

/** One connection and cache per account/workspace; Legend owns the network queue. */
export class PartitionPersistence implements ObservablePersistPlugin {
  readonly error$ = observable<Error | null>(null);
  private rows: Record<string, Record<string, unknown>> = {};
  private metadata: Record<string, PersistMetadata> = {};
  private closed = false;

  constructor(private db: IDBDatabase) {
    // Sign-out deletion must finish even while another tab still has this store.
    db.onversionchange = () => {
      this.error$.set(new Error('Local note storage was cleared by another session'));
      this.close();
    };
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }

  async load(): Promise<void> {
    const transaction = this.db.transaction([...SYNC_TABLE_NAMES], 'readonly');
    const done = transactionDone(transaction);
    await Promise.all([
      done,
      ...SYNC_TABLE_NAMES.map(async table => {
        const rows = await readRequest(transaction.objectStore(table).getAll());
        this.rows[table] = {};
        for (const row of rows) {
          if (row.id === METADATA_ID) {
            const { id: _id, ...metadata } = row;
            this.metadata[table] = metadata;
          } else this.rows[table]![row.id] = row;
        }
      }),
    ]);
  }

  getTable<T = Record<string, unknown>>(table: string): T {
    return structuredClone(this.rows[table] ?? {}) as T;
  }

  getMetadata(table: string): PersistMetadata {
    // Legend mutates hydrated pending entries and removes acknowledged keys.
    // Keep our prior snapshot separate for the transactional comparison below.
    return structuredClone(this.metadata[table] ?? {});
  }

  private async write(table: string, change: (store: IDBObjectStore) => void): Promise<void> {
    // A purge intentionally discards pending work. Ignore Legend's delayed
    // bookkeeping after the database closes; never reopen a signed-out cache.
    if (this.closed) return;
    try {
      const transaction = this.db.transaction(table, 'readwrite');
      const done = transactionDone(transaction);
      try { change(transaction.objectStore(table)); }
      catch (error) {
        transaction.abort();
        await done.catch(() => {});
        throw error;
      }
      await done;
    } catch (error) {
      if (!this.error$.peek()) this.error$.set(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  set(table: string, changes: Change[]): Promise<void> {
    const before = Object.keys(this.rows[table] ?? {});
    const next = applyChanges(this.rows[table] ?? {}, changes) ?? {};
    this.rows[table] = next;
    const ids = changes.some(change => change.path.length === 0)
      ? new Set([...before, ...Object.keys(next)])
      : new Set(changes.map(change => change.path[0]!));
    return this.write(table, store => {
      for (const id of ids) {
        const row = next[id];
        if (row == null) store.delete(id);
        else store.put({ ...(row as object), id });
      }
    });
  }

  setMetadata(table: string, metadata: PersistMetadata): Promise<void> {
    const previous = this.metadata[table];
    const next = structuredClone(metadata);
    this.metadata[table] = next;
    return this.write(table, store => {
      const read = store.get(METADATA_ID);
      read.onsuccess = () => {
        const stored = (read.result ?? {}) as PersistMetadata;
        const pending = { ...stored.pending };
        for (const [key, value] of Object.entries(next.pending ?? {})) {
          if (!samePending(value, previous?.pending?.[key])) pending[key] = value;
        }
        // Clearing an acknowledged write must not erase another tab's newer
        // pending value or an unrelated note created since this tab loaded.
        for (const key of Object.keys(previous?.pending ?? {})) {
          if (!(key in (next.pending ?? {})) && samePending(stored.pending?.[key], previous?.pending[key])) {
            delete pending[key];
          }
        }
        // Retain Legend's cursor from this snapshot. Advancing it to another
        // tab's maximum would assume this snapshot contains that tab's rows.
        store.put({ ...stored, ...next, id: METADATA_ID, pending });
      };
    });
  }

  deleteMetadata(table: string): Promise<void> {
    delete this.metadata[table];
    return this.write(table, store => store.delete(METADATA_ID));
  }

  deleteTable(table: string): Promise<void> {
    this.rows[table] = {};
    delete this.metadata[table];
    return this.write(table, store => store.clear());
  }
}

export async function createPartitionPersistence(partition: SyncPartition): Promise<PartitionPersistence> {
  if (!globalThis.indexedDB) throw new Error('Local note storage is unavailable');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(partitionDatabaseName(partition), SYNC_DB_VERSION);
    opening.onupgradeneeded = () => {
      for (const table of SYNC_TABLE_NAMES) {
        if (!opening.result.objectStoreNames.contains(table)) {
          opening.result.createObjectStore(table, { keyPath: 'id' });
        }
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('Local note storage is unavailable'));
    opening.onblocked = () => {
      opening.onsuccess = () => opening.result.close();
      reject(new Error('Local note storage is blocked'));
    };
  });
  const plugin = new PartitionPersistence(db);
  try { await plugin.load(); }
  catch (error) { db.close(); throw error; }
  return plugin;
}
