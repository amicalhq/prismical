// @vitest-environment jsdom
import * as React from 'react';
import * as Y from 'yjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { observable } from '@legendapp/state';
import { PortsProvider, type AppPorts } from '../ports-context';
import { configureAppClient } from '../runtime';
import { BodyCache, initializeLocalBody } from './body-cache';
import { openIndexedDbNoteLog } from './indexeddb-note-log';
import { useNoteCollab } from './use-note-collab';
import { NoteBodySyncProvider, selectBodiesToSync } from './note-body-sync-provider';

const fixture = vi.hoisted(() => ({
  store: null as unknown,
  providers: [] as Array<{ name: string; destroy: () => void; destroyed: boolean }>,
  server: new Map<string, unknown>(),
}));
vi.mock('../sync/provider', () => ({ useSyncStore: () => fixture.store }));
vi.mock('@hocuspocus/provider', async () => {
  const Yjs = await import('yjs');
  return { HocuspocusProvider: vi.fn(function(config: {
    name: string; document: Y.Doc;
    onStatus: (event: { status: string }) => void;
    onAuthenticated: (event: { scope: string }) => void;
    onSynced: (event: { state: boolean }) => void;
    onUnsyncedChanges: (event: { number: number }) => void;
  }) {
    const listeners = new Map<string, Set<() => void>>();
    const server = (fixture.server.get(config.name) as Y.Doc | undefined) ?? new Yjs.Doc();
    fixture.server.set(config.name, server);
    const remoteOrigin = {};
    const provider = {
      name: config.name, synced: false, isAuthenticated: false, authorizedScope: 'read-write', hasUnsyncedChanges: false, destroyed: false,
      on(event: string, listener: () => void) { listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)); },
      off(event: string, listener: () => void) { listeners.get(event)?.delete(listener); },
      destroy() {
        provider.destroyed = true;
        config.document.off('update', upload);
        for (const listener of listeners.get('destroy') ?? []) listener();
      },
    };
    const upload = (_update: Uint8Array, origin: unknown) => {
      if (provider.destroyed || origin === remoteOrigin) return;
      Yjs.applyUpdate(server, Yjs.encodeStateAsUpdate(config.document));
      config.onUnsyncedChanges({ number: 0 });
      for (const listener of listeners.get('unsyncedChanges') ?? []) listener();
    };
    config.document.on('update', upload);
    fixture.providers.push(provider);
    queueMicrotask(() => {
      if (provider.destroyed) return;
      config.onStatus({ status: 'connected' });
      provider.isAuthenticated = true;
      config.onAuthenticated({ scope: 'read-write' });
      upload(new Uint8Array(), null);
      Yjs.applyUpdate(config.document, Yjs.encodeStateAsUpdate(server), remoteOrigin);
      provider.synced = true;
      config.onSynced({ state: true });
      config.onUnsyncedChanges({ number: 0 });
      for (const listener of listeners.get('synced') ?? []) listener();
    });
    return provider;
  }) };
});

const partition = { accountSub: 'account', orgId: 'workspace' };
const env = { platform: 'web' as const, noteWsUrl: 'wss://note.test', webAppOrigin: 'https://web.test', analyticsKey: null, appVersion: null };
const session = { state: 'signed-in' as const, activeSub: partition.accountSub, accounts: [{ sub: partition.accountSub, email: 'a@example.test', activeOrgId: partition.orgId }] };
const ports = {
  env: { getEnv: () => env },
  auth: { getSession: () => session, onSessionChanged: () => () => {}, getTokenForSession: async () => 'token' },
  analytics: { capture: vi.fn() },
} as unknown as AppPorts;
function wrapper({ children }: { children: React.ReactNode }) { return <PortsProvider ports={ports}>{children}</PortsProvider>; }

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  fixture.providers = [];
  fixture.server = new Map();
  fixture.store = { notes$: {}, requireNoteCreateAck: () => Promise.resolve() };
  configureAppClient({ env: { getEnv: () => env } });
});
afterEach(async () => {
  cleanup();
  await act(async () => {});
  for (const doc of fixture.server.values()) (doc as Y.Doc).destroy();
  vi.unstubAllGlobals();
});

function notes(noteId: string, createdAt?: string) {
  return { [noteId]: { peek: () => ({ id: noteId, createdAt, canWrite: true }) } };
}

it('edits and restores a new local body before metadata acknowledgement, then connects with the same ID', async () => {
  let acknowledge!: () => void;
  const gate = new Promise<void>(resolve => { acknowledge = resolve; });
  fixture.store = { notes$: notes('nt_local'), requireNoteCreateAck: () => gate };
  const first = renderHook(() => useNoteCollab('nt_local'), { wrapper });
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  expect(fixture.providers).toHaveLength(0);
  act(() => first.result.current.doc!.getText('text').insert(0, 'Offline words'));
  await act(() => first.result.current.waitForLocalChanges());
  expect(first.result.current.localSaved).toBe(true);
  expect(first.result.current.synced).toBe(false);
  first.unmount();
  const reopened = renderHook(() => useNoteCollab('nt_local'), { wrapper });
  await waitFor(() => expect(reopened.result.current.ready).toBe(true));
  expect(reopened.result.current.doc!.getText('text').toString()).toBe('Offline words');
  expect(fixture.providers).toHaveLength(0);
  await act(async () => { acknowledge(); });
  await waitFor(() => expect(reopened.result.current.synced).toBe(true));
  expect(fixture.providers.map(provider => provider.name)).toEqual(['nt_local']);
  expect((fixture.server.get('nt_local') as Y.Doc).getText('text').toString()).toBe('Offline words');
});

it('keeps an uncached existing body unavailable and never connects without its metadata store', async () => {
  fixture.store = null;
  const view = renderHook(() => useNoteCollab('nt_uncached'), { wrapper });
  await act(async () => {});
  expect(view.result.current.ready).toBe(false);
  expect(fixture.providers).toHaveLength(0);
});

it('restores cached readonly scope and reports metadata persistence failures without discarding the body', async () => {
  await initializeLocalBody(partition, 'nt_cached');
  const cache = new BodyCache(partition);
  await cache.update('nt_cached', row => ({ ...row, scope: 'readonly' }));
  const persistenceError$ = observable<Error | null>(null);
  fixture.store = { notes$: notes('nt_cached', '2026-01-01'), persistenceError$, requireNoteCreateAck: () => new Promise(() => {}) };
  const view = renderHook(() => useNoteCollab('nt_cached'), { wrapper });
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  expect(view.result.current.scope).toBe('readonly');
  act(() => persistenceError$.set(new Error('Metadata storage failed')));
  expect(view.result.current.localSaveError).toBe('Metadata storage failed');
  expect(view.result.current.localSaved).toBe(false);
  expect(view.result.current.doc).not.toBeNull();
  cache.close();
});

it('uploads a closed body, then pulls body-only remote edits and persists their merged state', async () => {
  const noteId = 'nt_closed';
  await initializeLocalBody(partition, noteId);
  const cache = new BodyCache(partition);
  const local = new Y.Doc();
  local.getText('text').insert(0, 'Local');
  const log = openIndexedDbNoteLog(cache, noteId);
  log.sendUpdate(Y.encodeStateAsUpdate(local));
  await log.waitForPendingChanges();
  log.close();
  fixture.store = { notes$: notes(noteId, '2026-01-01'), requireNoteCreateAck: () => Promise.resolve() };
  render(<NoteBodySyncProvider />, { wrapper });
  await waitFor(() => expect((fixture.server.get(noteId) as Y.Doc | undefined)?.getText('text').toString()).toBe('Local'));
  await waitFor(async () => expect((await cache.get(noteId))?.dirty).toBe(false));
  await waitFor(() => expect(fixture.providers.every(provider => provider.destroyed)).toBe(true));
  const server = fixture.server.get(noteId) as Y.Doc;
  server.getText('text').insert(5, ' remote');
  // The metadata row/cursor stays unchanged. A cached-document sweep must discover this edit.
  await cache.update(noteId, row => ({ ...row, refreshedAt: 0 }));
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(fixture.providers).toHaveLength(2));
  await waitFor(() => expect(fixture.providers.every(provider => provider.destroyed)).toBe(true));
  const restored = new Y.Doc();
  const replay = openIndexedDbNoteLog(cache, noteId);
  replay.onUpdate(update => Y.applyUpdate(restored, update));
  await replay.hydrated;
  expect(restored.getText('text').toString()).toBe('Local remote');
  replay.close(); cache.close(); local.destroy(); restored.destroy();
});

it('does not acknowledge another window’s unseen update when this document later syncs', async () => {
  const noteId = 'nt_shared';
  await initializeLocalBody(partition, noteId);
  fixture.store = { notes$: notes(noteId, '2026-01-01'), requireNoteCreateAck: () => Promise.resolve() };
  const view = renderHook(() => useNoteCollab(noteId), { wrapper });
  const other = new BodyCache(partition);
  await waitFor(() => expect(view.result.current.synced && view.result.current.ready).toBe(true));
  await waitFor(async () => expect((await other.get(noteId))?.dirty).toBe(false));
  const unseen = new Y.Doc();
  unseen.getText('text').insert(0, 'Other window');
  const otherLog = openIndexedDbNoteLog(other, noteId);
  await otherLog.hydrated;
  otherLog.sendUpdate(Y.encodeStateAsUpdate(unseen));
  await other.markChanged(noteId);
  await otherLog.waitForPendingChanges();
  act(() => view.result.current.doc!.getText('text').insert(0, 'Visible window'));
  await act(() => view.result.current.waitForLocalChanges());
  await waitFor(() => expect(view.result.current.remotePending).toBe(true));
  expect((await other.get(noteId))?.dirty).toBe(true);
  expect(view.result.current.doc!.getText('text').toString()).toBe('Visible window');
  otherLog.close(); other.close(); unseen.destroy();
});

it('prioritizes dirty bodies and refreshes clean cached bodies without fetching unvisited notes', () => {
  const base = { initialized: true, revision: 1 };
  expect(selectBodiesToSync([
    { ...base, noteId: 'clean', dirty: false, refreshedAt: 0 },
    { ...base, noteId: 'dirty', dirty: true, refreshedAt: 70_000 },
    { ...base, noteId: 'fresh', dirty: false, refreshedAt: 70_000 },
  ], new Map(), 80_000).map(row => row.noteId)).toEqual(['dirty', 'clean']);
});
