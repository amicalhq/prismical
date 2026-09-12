'use client';

import * as React from 'react';
import { useActiveAccountId, useActiveOrgId, useActiveSessionKey, usePorts } from '../ports-context';
import { getNoteLogConfig } from '../runtime';
import { useSyncStore } from '../sync/provider';
import { BodyCache, isBodyOpen, watchOpenBodies, type CachedBody } from './body-cache';
import { partitionKey } from '../sync/partition';
import { useNoteCollab } from './use-note-collab';

const REFRESH_MS = 60_000;
const RETRY_MS = 15_000;
const SESSION_MS = 25_000;
const MAX_CONNECTIONS = 2;

/** Refresh only previously opened bodies; body edits do not necessarily advance metadata cursors. */
export function selectBodiesToSync(rows: CachedBody[], attempted: Map<string, number>, now: number): CachedBody[] {
  return rows.filter(row =>
    now - (attempted.get(row.noteId) ?? -Infinity) >= RETRY_MS &&
    (row.dirty || now - row.refreshedAt >= REFRESH_MS),
  ).sort((a, b) => Number(b.dirty) - Number(a.dirty) || a.refreshedAt - b.refreshedAt);
}

/** Mount under SyncStoreProvider. Headless sessions use the same persistence and protocol as editors. */
export function NoteBodySyncProvider({ children }: { children?: React.ReactNode }) {
  const accountId = useActiveAccountId();
  const orgId = useActiveOrgId();
  const sessionKey = useActiveSessionKey();
  const { auth } = usePorts();
  const store = useSyncStore();
  const [work, setWork] = React.useState<{ key: string; ids: string[]; store: typeof store }>({ key: '', ids: [], store: null });
  const finishRef = React.useRef<(id: string) => void>(() => {});
  const finish = React.useCallback((id: string) => finishRef.current(id), []);
  const key = accountId ? `${partitionKey({ accountSub: accountId, orgId: orgId ?? '' })}:${sessionKey}` : '';

  React.useEffect(() => {
    if (!store || !accountId || !sessionKey || typeof indexedDB === 'undefined' || getNoteLogConfig()?.remote === false) return;
    const partition = { accountSub: accountId, orgId: orgId ?? '' };
    const cache = new BodyCache(partition);
    const running = new Set<string>();
    const attempted = new Map<string, number>();
    let disposed = false;
    let scanning = false;
    const publish = () => { if (!disposed) setWork({ key, ids: [...running], store }); };
    const scan = async () => {
      if (disposed || scanning || !navigator.onLine) return;
      scanning = true;
      try {
        if (!await auth.getTokenForSession(sessionKey, orgId)) return;
        const rows = await cache.list();
        if (disposed) return;
        for (const id of running) {
          const note = store.notes$[id]?.peek();
          if (isBodyOpen(partition, id) || !note || note.deletedAt) running.delete(id);
        }
        for (const row of selectBodiesToSync(rows, attempted, Date.now())) {
          if (running.size >= MAX_CONNECTIONS) break;
          const note = store.notes$[row.noteId]?.peek();
          if (!note || note.deletedAt || running.has(row.noteId) || isBodyOpen(partition, row.noteId)) continue;
          attempted.set(row.noteId, Date.now());
          running.add(row.noteId);
        }
        publish();
      } catch {
        // Visible editors report storage errors. A background attempt retries on the next sweep.
      } finally { scanning = false; }
    };
    finishRef.current = id => {
      running.delete(id);
      publish();
      void scan();
    };
    const onActivity = () => {
      for (const id of running) if (isBodyOpen(partition, id)) running.delete(id);
      publish();
      void scan();
    };
    const stopWatching = watchOpenBodies(onActivity);
    const timer = setInterval(() => { void scan(); }, RETRY_MS);
    const onOnline = () => { attempted.clear(); void scan(); };
    window.addEventListener('online', onOnline);
    void scan();
    return () => {
      disposed = true;
      finishRef.current = () => {};
      clearInterval(timer);
      stopWatching();
      window.removeEventListener('online', onOnline);
      cache.close();
    };
  }, [store, accountId, orgId, sessionKey, auth, key]);

  return <>{children}{work.key === key && work.store === store && work.ids.map(id => <BodySync key={`${key}:${id}`} noteId={id} onDone={finish} />)}</>;
}

function BodySync({ noteId, onDone }: { noteId: string; onDone: (id: string) => void }) {
  const { ready, synced, error, localSaveError, waitForPendingChanges, waitForLocalChanges } = useNoteCollab(noteId, { background: true });
  React.useEffect(() => {
    const timer = setTimeout(() => onDone(noteId), SESSION_MS);
    return () => clearTimeout(timer);
  }, [noteId, onDone]);
  React.useEffect(() => {
    if (error || localSaveError) { onDone(noteId); return; }
    if (!ready || !synced) return;
    let disposed = false;
    void waitForPendingChanges().then(waitForLocalChanges).then(() => {
      if (!disposed) onDone(noteId);
    }, () => { if (!disposed) onDone(noteId); });
    return () => { disposed = true; };
  }, [noteId, ready, synced, error, localSaveError, waitForPendingChanges, waitForLocalChanges, onDone]);
  return null;
}
