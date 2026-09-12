import type { SyncPartition } from '../sync/partition';
import { partitionKey } from '../sync/partition';
import { registerPartitionDatabase } from '../sync/purge';

/** Only notes opened on this device enter this index. Body-only changes have no metadata cursor. */
export interface CachedBody {
  noteId: string;
  initialized: boolean;
  revision: number;
  dirty: boolean;
  refreshedAt: number;
  scope?: 'read-write' | 'readonly';
}

export function bodyDatabaseName(partition: SyncPartition): string {
  return `prismical-bodies-${partitionKey(partition)}`;
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Local note storage failed'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Local note storage failed'));
  });
}

export function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local note storage failed'));
  });
}

export class BodyCache {
  readonly database: Promise<IDBDatabase>;

  constructor(readonly partition: SyncPartition) {
    const name = bodyDatabaseName(partition);
    registerPartitionDatabase(partition.accountSub, name);
    this.database = new Promise((resolve, reject) => {
      let failed = false;
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('notes', { keyPath: 'noteId' });
        const updates = request.result.createObjectStore('updates', { keyPath: 'seq', autoIncrement: true });
        updates.createIndex('noteId', 'noteId');
      };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Local note storage unavailable'));
      request.onblocked = () => { failed = true; reject(new Error('Local note storage is blocked')); };
    });
    // A background workspace can be offline before its first read. Keep the
    // rejection observable by callers without an unhandled rejection meanwhile.
    void this.database.catch(() => {});
  }

  async list(): Promise<CachedBody[]> {
    const db = await this.database;
    return readRequest(db.transaction('notes', 'readonly').objectStore('notes').getAll());
  }

  async get(noteId: string): Promise<CachedBody | undefined> {
    const db = await this.database;
    return readRequest(db.transaction('notes', 'readonly').objectStore('notes').get(noteId));
  }

  /** Read/modify/write in one transaction, including when another tab edits the same note. */
  async update(noteId: string, change: (current: CachedBody) => CachedBody): Promise<CachedBody> {
    const db = await this.database;
    const transaction = db.transaction('notes', 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore('notes');
    let result!: CachedBody;
    const request = store.get(noteId);
    request.onsuccess = () => {
      result = change(request.result ?? { noteId, initialized: false, revision: 0, dirty: false, refreshedAt: 0 });
      store.put(result);
    };
    await done;
    return result;
  }

  markChanged(noteId: string, local = true): Promise<CachedBody> {
    return this.update(noteId, row => ({ ...row, revision: row.revision + 1, dirty: row.dirty || local }));
  }

  markSynced(noteId: string, revision: number, writable = true): Promise<CachedBody> {
    return this.update(noteId, row => ({
      ...row,
      initialized: true,
      dirty: row.revision !== revision || (!writable && row.dirty),
      refreshedAt: Date.now(),
    }));
  }

  close(): void {
    void this.database.then(db => db.close(), () => {});
  }
}

/** Seed this at creation, before the metadata acknowledgement can remove the local-create hint. */
export async function initializeLocalBody(partition: SyncPartition, noteId: string): Promise<void> {
  const cache = new BodyCache(partition);
  try { await cache.update(noteId, row => ({ ...row, initialized: true, dirty: true })); }
  finally { cache.close(); }
}

const active = new Map<string, number>();
const listeners = new Set<() => void>();
const activityKey = (partition: SyncPartition, noteId: string) => `${partitionKey(partition)}:${noteId}`;

export function isBodyOpen(partition: SyncPartition, noteId: string): boolean {
  return active.has(activityKey(partition, noteId));
}

export function watchOpenBodies(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function registerOpenBody(partition: SyncPartition, noteId: string): () => void {
  const key = activityKey(partition, noteId);
  active.set(key, (active.get(key) ?? 0) + 1);
  for (const listener of listeners) listener();
  return () => {
    const count = (active.get(key) ?? 1) - 1;
    if (count > 0) active.set(key, count);
    else active.delete(key);
    for (const listener of listeners) listener();
  };
}
