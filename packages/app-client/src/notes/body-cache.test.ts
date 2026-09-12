import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import * as Y from 'yjs';
import { BodyCache, initializeLocalBody } from './body-cache';
import { openIndexedDbNoteLog } from './indexeddb-note-log';

const partition = { accountSub: 'account', orgId: 'workspace' };
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('replays committed Yjs updates across close/reopen and isolates workspace bodies', async () => {
  await initializeLocalBody(partition, 'nt_one');
  const cache = new BodyCache(partition);
  const log = openIndexedDbNoteLog(cache, 'nt_one');
  await log.hydrated;
  const source = new Y.Doc();
  source.getText('text').insert(0, 'Offline text');
  log.sendUpdate(Y.encodeStateAsUpdate(source));
  await log.waitForPendingChanges();
  log.close();
  cache.close();
  const reopened = new BodyCache(partition);
  const restored = new Y.Doc();
  const replay = openIndexedDbNoteLog(reopened, 'nt_one');
  replay.onUpdate(update => Y.applyUpdate(restored, update));
  await replay.hydrated;
  expect(restored.getText('text').toString()).toBe('Offline text');
  expect((await reopened.get('nt_one'))?.initialized).toBe(true);
  const other = new BodyCache({ ...partition, orgId: 'another' });
  expect(await other.list()).toEqual([]);
  replay.close();
  reopened.close();
  other.close();
  source.destroy();
  restored.destroy();
});

it('retains a newer edit made by another window while a previous revision is acknowledged', async () => {
  const first = new BodyCache(partition);
  const second = new BodyCache(partition);
  const delivered = await first.markChanged('nt_one');
  await second.markChanged('nt_one');
  await first.markSynced('nt_one', delivered.revision);
  expect(await second.get('nt_one')).toMatchObject({ dirty: true, revision: 2 });
  await second.markSynced('nt_one', 2);
  expect(await first.get('nt_one')).toMatchObject({ dirty: false, initialized: true });
  first.close();
  second.close();
});

it('never acknowledges queued local edits through a readonly connection', async () => {
  const cache = new BodyCache(partition);
  const edit = await cache.markChanged('nt_one');
  await cache.markSynced('nt_one', edit.revision, false);
  expect(await cache.get('nt_one')).toMatchObject({ initialized: true, dirty: true });
  const download = await cache.markChanged('nt_readonly', false);
  await cache.markSynced('nt_readonly', download.revision, false);
  expect(await cache.get('nt_readonly')).toMatchObject({ initialized: true, dirty: false });
  cache.close();
});

it('rejects the durability barrier when an append fails and allows snapshot repair', async () => {
  const cache = new BodyCache(partition);
  const log = openIndexedDbNoteLog(cache, 'nt_one');
  await log.hydrated;
  const failed = vi.fn();
  log.onResync(failed);
  const source = new Y.Doc();
  source.getText('text').insert(0, 'Retained in memory');
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
    throw new DOMException('Storage is full', 'QuotaExceededError');
  });
  log.sendUpdate(Y.encodeStateAsUpdate(source));
  await expect(log.waitForPendingChanges()).rejects.toThrow('Storage is full');
  expect(failed).toHaveBeenCalledOnce();
  log.compact(0, Y.encodeStateAsUpdate(source));
  await expect(log.waitForPendingChanges()).resolves.toBeUndefined();
  const restored = new Y.Doc();
  const replay = openIndexedDbNoteLog(cache, 'nt_one');
  replay.onUpdate(update => Y.applyUpdate(restored, update));
  await replay.hydrated;
  expect(restored.getText('text').toString()).toBe('Retained in memory');
  replay.close();
  log.close();
  cache.close();
  source.destroy();
  restored.destroy();
});

it('compaction preserves updates appended after its hydrated prefix', async () => {
  const cache = new BodyCache(partition);
  const first = openIndexedDbNoteLog(cache, 'nt_one');
  const source = new Y.Doc();
  source.getText('text').insert(0, 'First');
  first.sendUpdate(Y.encodeStateAsUpdate(source));
  await first.waitForPendingChanges();
  const second = openIndexedDbNoteLog(cache, 'nt_one');
  const prefix = await second.hydrated;
  const snapshot = Y.encodeStateAsUpdate(source);
  source.getText('text').insert(5, ' second');
  first.sendUpdate(Y.encodeStateAsUpdate(source));
  await first.waitForPendingChanges();
  second.compact(prefix.seq, snapshot);
  await second.waitForPendingChanges();
  const restored = new Y.Doc();
  const replay = openIndexedDbNoteLog(cache, 'nt_one');
  replay.onUpdate(update => Y.applyUpdate(restored, update));
  await replay.hydrated;
  expect(restored.getText('text').toString()).toBe('First second');
  replay.close(); first.close(); second.close(); cache.close();
  source.destroy(); restored.destroy();
});
