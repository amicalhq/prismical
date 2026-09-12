import type { NoteLogHandle, NoteLogHydration } from '@prismical/app-contracts';
import { BodyCache, readRequest, transactionDone } from './body-cache';

interface StoredUpdate { noteId: string; seq: number; update: Uint8Array }

/** Browser implementation of the existing opaque Yjs log port. Transactions define durability. */
export function openIndexedDbNoteLog(cache: BodyCache, noteId: string): NoteLogHandle {
  let closed = false;
  let updateListener: ((update: Uint8Array) => void) | null = null;
  let resyncListener: (() => void) | null = null;
  let failure: unknown = null;
  const buffered: Uint8Array[] = [];
  const opened = cache.database.then(() => ({ ok: true as const }));
  const hydrated: Promise<NoteLogHydration> = cache.database.then(async db => {
    const rows = await readRequest<StoredUpdate[]>(
      db.transaction('updates', 'readonly').objectStore('updates').index('noteId').getAll(noteId),
    );
    for (const row of rows) {
      if (closed) break;
      if (updateListener) updateListener(row.update);
      else buffered.push(row.update);
    }
    return { seq: rows.at(-1)?.seq ?? 0, count: rows.length };
  });
  void hydrated.catch(() => {});
  // Every append/compact is ordered after replay, so no late replay can miss an accepted edit.
  let pending: Promise<unknown> = hydrated;
  const enqueue = (write: (db: IDBDatabase) => Promise<void>) => {
    pending = pending.catch(() => {}).then(async () => {
      try { await write(await cache.database); }
      catch (error) {
        failure = error;
        if (!closed) resyncListener?.();
      }
    });
  };
  return {
    opened,
    hydrated,
    onUpdate(listener) {
      updateListener = listener;
      for (const update of buffered.splice(0)) listener(update);
    },
    onResync(listener) { resyncListener = listener; },
    sendUpdate(update) {
      enqueue(async db => {
        const transaction = db.transaction('updates', 'readwrite');
        const done = transactionDone(transaction);
        transaction.objectStore('updates').add({ noteId, update });
        await done;
      });
    },
    // Web derives title/excerpt from the live document; the server owns their remote projection.
    flush() {},
    async waitForPendingChanges() {
      await pending;
      if (failure) throw failure;
    },
    compact(upTo, state) {
      enqueue(async db => {
        const transaction = db.transaction('updates', 'readwrite');
        const done = transactionDone(transaction);
        const store = transaction.objectStore('updates');
        const cursor = store.index('noteId').openCursor(noteId);
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (row) {
            if ((row.value as StoredUpdate).seq <= upTo) row.delete();
            row.continue();
          } else {
            store.put({ noteId, update: state, ...(upTo > 0 ? { seq: upTo } : {}) });
          }
        };
        await done;
        failure = null;
      });
    },
    close() { closed = true; },
  };
}
