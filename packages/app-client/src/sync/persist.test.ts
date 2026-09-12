/**
 * Persistence round-trip: rows and the delta cursor survive a
 * "restart" (new store instance, same partition, fresh plugin) through the
 * partition's IndexedDB database, and the second boot pulls WITH `since`
 * (the warm-boot behavior that instant paint relies on). fake-indexeddb
 * supplies the IndexedDB globals in node.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  restList: vi.fn(async () => []),
  restCreate: vi.fn(),
  restUpdate: vi.fn(),
  restRemove: vi.fn(async () => undefined),
  restNoteTagList: vi.fn(async () => []),
  restNoteTagCreate: vi.fn(async () => undefined),
  restNoteTagRemove: vi.fn(async () => undefined),
  restNoteEventList: vi.fn(async () => []),
  restNoteEventCreate: vi.fn(),
  restNoteEventRemove: vi.fn(async () => undefined),
}));

import * as api from "./api";
import { syncState } from "@legendapp/state";
import { createIndexedDbPersistPlugin, createSyncStore, type NoteRow, type SyncStore, type TagRow } from "./store";
import { partitionDatabaseName } from "./partition";
import { createPartitionPersistence } from "./persist";
import { purgeAccountPartitions, registerPartitionDatabase } from "./purge";

const mocked = vi.mocked(api);
// Unique partition per test run: fake-indexeddb is in-memory per worker, and
// deleting a database with live plugin connections blocks — isolation by
// naming beats cleanup.
let seq = 0;
let PARTITION = { accountSub: "sub|persist", orgId: "org_persist" };

let stores: SyncStore[] = [];

async function bootStore(): Promise<SyncStore> {
  const store = createSyncStore({
    partition: PARTITION,
    persistPlugin: await createIndexedDbPersistPlugin(PARTITION),
    pollIntervalMs: 0,
  });
  stores.push(store);
  return store;
}

async function storedNote<T = NoteRow>(id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(partitionDatabaseName(PARTITION));
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("notes", "readonly");
      const get = tx.objectStore("notes").get(id);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.restList.mockResolvedValue([]);
  mocked.restNoteTagList.mockResolvedValue([]);
  mocked.restCreate.mockImplementation(async (_route, input) => ({ ...(input as object), createdAt: "2030-01-01" }));
  mocked.restUpdate.mockImplementation(async (_route, _id, input) => input);
  mocked.restRemove.mockResolvedValue(undefined);
  seq += 1;
  PARTITION = { accountSub: "sub|persist", orgId: `org_persist_${seq}` };
});

afterEach(() => {
  for (const store of stores) store.dispose();
  stores = [];
});

describe("IndexedDB persistence per partition", () => {
  it("keeps another tab's pending creates when this tab saves or acknowledges its own", async () => {
    const first = await createPartitionPersistence(PARTITION);
    const second = await createPartitionPersistence(PARTITION);
    const pendingA = { p: null, t: ["object"], v: { id: "nt_a" } };
    const pendingB = { p: null, t: ["object"], v: { id: "nt_b" } };
    await first.setMetadata("notes", { pending: { nt_a: pendingA }, lastSync: 100 });
    await second.setMetadata("notes", { pending: { nt_b: pendingB }, lastSync: 50 });
    await first.setMetadata("notes", { pending: {}, lastSync: 100 });
    const restarted = await createPartitionPersistence(PARTITION);
    expect(restarted.getMetadata("notes")).toMatchObject({ pending: { nt_b: pendingB }, lastSync: 100 });
    expect(restarted.getMetadata("notes").pending).not.toHaveProperty("nt_a");
  });

  it("does not replace another tab's newer pending edit while persisting an unchanged snapshot", async () => {
    const first = await createPartitionPersistence(PARTITION);
    const old = { p: null, t: ["object"], v: { id: "nt_shared", title: "Earlier" } };
    await first.setMetadata("notes", { pending: { nt_shared: old } });
    const second = await createPartitionPersistence(PARTITION);
    const edited = { ...old, v: { ...old.v, title: "Later edit" } };
    await second.setMetadata("notes", { pending: { nt_shared: edited } });
    await first.setMetadata("notes", { pending: { nt_shared: old }, lastSync: 100 });
    const restarted = await createPartitionPersistence(PARTITION);
    expect(restarted.getMetadata("notes").pending).toEqual({ nt_shared: edited });
  });

  it("retains the legacy adapter's persisted rows, pending writes, and cursor", async () => {
    const { observablePersistIndexedDB } = await import("@legendapp/state/persist-plugins/indexeddb");
    const { SYNC_TABLE_NAMES, SYNC_DB_VERSION } = await import("./partition");
    const legacy = observablePersistIndexedDB({
      databaseName: partitionDatabaseName(PARTITION), version: SYNC_DB_VERSION, tableNames: [...SYNC_TABLE_NAMES],
    });
    await legacy.initialize({});
    const row = { id: "nt_legacy", title: "Queued earlier", updatedAt: "2030-01-01" };
    await legacy.set("notes", [{ path: [row.id], pathTypes: ["object"], prevAtPath: undefined, valueAtPath: row }], {});
    const pending = { [row.id]: { p: null, t: ["object"], v: row } };
    await legacy.setMetadata("notes", { lastSync: 1234, pending }, {});
    const next = await createPartitionPersistence(PARTITION);
    expect(next.getTable("notes")).toEqual({ [row.id]: row });
    expect(next.getMetadata("notes")).toMatchObject({ lastSync: 1234, pending });
  });

  it("reports a transaction abort and never treats the write as committed", async () => {
    const plugin = await createPartitionPersistence(PARTITION);
    const transaction = IDBDatabase.prototype.transaction;
    const abortWrites = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase, names: string | Iterable<string>, mode?: IDBTransactionMode, options?: IDBTransactionOptions,
    ) {
      const tx = transaction.call(this, names, mode, options);
      if (mode === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    });
    try {
      await expect(plugin.set("notes", [{
        path: ["nt_failed"], pathTypes: ["object"], prevAtPath: undefined,
        valueAtPath: { id: "nt_failed", title: "Unsaved", updatedAt: "2030-01-01" },
      }])).rejects.toThrow();
      expect(plugin.error$.peek()).toBeInstanceOf(Error);
      expect(await storedNote("nt_failed")).toBeUndefined();
    } finally {
      abortWrites.mockRestore();
    }
  });

  it("closes open partition connections for sign-out deletion and permits a clean reopen", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    try {
      const first = await bootStore();
      await first.whenLocalReady();
      registerPartitionDatabase(PARTITION.accountSub, partitionDatabaseName(PARTITION));
      const id = first.createNote({ title: "Sign out" });
      await vi.waitFor(async () => expect(await storedNote(id)).toBeDefined());
      first.dispose();
      expect(await purgeAccountPartitions(PARTITION.accountSub)).toBeGreaterThanOrEqual(1);
      const second = await bootStore();
      await second.whenLocalReady();
      expect(second.notes$[id]!.peek()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects unavailable storage instead of leaving local hydration pending forever", async () => {
    const open = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    try {
      await expect(createIndexedDbPersistPlugin(PARTITION)).rejects.toMatchObject({ name: "SecurityError" });
    } finally {
      open.mockRestore();
    }
  });

  it("persists a new edited note before the first GET and replays it under the same ID after restart", async () => {
    mocked.restList.mockImplementation(() => new Promise(() => {}));
    const first = await bootStore();
    await first.whenLocalReady();
    const id = first.createNote({ title: "Offline draft" });
    first.updateNote(id, { title: "Edited offline", starred: true });
    await vi.waitFor(async () => expect(await storedNote(id)).toMatchObject({ id, title: "Edited offline", starred: true }));
    expect(mocked.restCreate).not.toHaveBeenCalled();
    first.dispose();

    let release!: (rows: unknown[]) => void;
    mocked.restList.mockImplementation(route => route === "notes"
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve([]));
    const second = await bootStore();
    const ready = vi.fn();
    const gate = second.requireNoteCreateAck(id).then(ready);
    await second.whenLocalReady();
    expect(second.notes$[id]!.peek()).toMatchObject({ title: "Edited offline", starred: true });
    expect(ready).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(release).toBeDefined());
    release([]);
    await gate;
    expect(mocked.restCreate).toHaveBeenCalledTimes(1);
    expect(mocked.restCreate.mock.calls[0]![1]).toMatchObject({ id, title: "Edited offline", starred: true });
    expect(second.notes$[id]!.createdAt.peek()).toBeTruthy();
    await vi.waitFor(async () => expect(
      (await storedNote<{ pending?: Record<string, unknown> }>("__legend_metadata"))?.pending,
    ).toEqual({}));
  });

  it("does not resurrect a note created and deleted before the first remote pull", async () => {
    mocked.restList.mockImplementation(() => new Promise(() => {}));
    const first = await bootStore();
    await first.whenLocalReady();
    const id = first.createNote({ title: "Discarded" });
    await vi.waitFor(async () => expect(await storedNote(id)).toBeDefined());
    first.deleteNote(id);
    await vi.waitFor(async () => expect(await storedNote(id)).toBeUndefined());
    first.dispose();
    mocked.restList.mockResolvedValue([]);
    const second = await bootStore();
    await second.whenLocalReady();
    await vi.waitFor(() => expect(syncState(second.notes$).isLoaded.get()).toBe(true));
    await second.refreshAll();
    expect(second.notes$[id]!.peek()).toBeUndefined();
    expect(mocked.restCreate).not.toHaveBeenCalled();
    await expect(second.requireNoteCreateAck(id)).rejects.toThrow("Note is unavailable");
  });

  it("replays pending edits and deletions after restart without reviving stale server rows", async () => {
    const stamp = "2030-01-01T00:00:00.000Z";
    const rows = ["nt_edit", "nt_delete"].map(id => ({ id, title: "Original", createdAt: stamp, updatedAt: stamp }));
    mocked.restList.mockImplementation(async route => route === "notes" ? rows : []);
    const first = await bootStore();
    await first.whenLocalReady();
    await vi.waitFor(() => expect(first.notes$.nt_delete?.peek()).toBeDefined());
    mocked.restUpdate.mockImplementation(() => new Promise(() => {}));
    mocked.restRemove.mockImplementation(() => new Promise(() => {}));
    first.updateNote("nt_edit", { title: "Changed offline" });
    first.deleteNote("nt_delete");
    await vi.waitFor(async () => expect(await storedNote("nt_edit")).toMatchObject({ title: "Changed offline" }));
    await vi.waitFor(async () => expect(await storedNote("nt_delete")).toBeUndefined());
    first.dispose();

    mocked.restUpdate.mockImplementation(async (_route, _id, input) => input);
    mocked.restRemove.mockResolvedValue(undefined);
    const second = await bootStore();
    await second.whenLocalReady();
    await vi.waitFor(() => expect(mocked.restUpdate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocked.restRemove).toHaveBeenCalledTimes(2));
    expect(mocked.restUpdate.mock.lastCall?.[2]).toMatchObject({ id: "nt_edit", title: "Changed offline" });
    expect(second.notes$.nt_edit!.title.peek()).toBe("Changed offline");
    expect(second.notes$.nt_delete!.peek()).toBeUndefined();
  });

  it("rows + cursor survive a restart; the second boot pulls with `since` and paints from disk", async () => {
    const T1 = "2030-01-05T00:00:00.000Z";
    mocked.restList.mockResolvedValueOnce([
      { id: "tag_p", name: "Persisted", color: "#1", createdAt: T1, updatedAt: T1 },
    ]);

    const first = await bootStore();
    first.tags$.get();
    await vi.waitFor(() =>
      expect((first.tags$.peek() as Record<string, TagRow>).tag_p?.name).toBe("Persisted"),
    );
    // Give the persist plugin's write-behind queue a beat to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.dispose();

    // "Restart": fresh plugin + store on the same partition; the wire now
    // returns nothing — everything visible must come from disk.
    mocked.restList.mockClear();
    mocked.restList.mockResolvedValue([]);
    const second = await bootStore();
    second.tags$.get();
    await vi.waitFor(() =>
      expect((second.tags$.peek() as Record<string, TagRow>).tag_p?.name).toBe("Persisted"),
    );
    // The persisted cursor makes the second boot a DELTA pull (warm boot).
    await vi.waitFor(() => expect(mocked.restList).toHaveBeenCalled());
    const lastSyncArg = mocked.restList.mock.calls[0]![1] as number | undefined;
    expect(lastSyncArg).toBe(new Date(T1).getTime());
  });

  it("different partitions land in different databases (no cross-identity reads)", () => {
    expect(partitionDatabaseName(PARTITION)).not.toBe(
      partitionDatabaseName({ accountSub: "sub|persist", orgId: "org_other" }),
    );
    expect(partitionDatabaseName(PARTITION)).toBe(partitionDatabaseName({ ...PARTITION }));
    expect(partitionDatabaseName(PARTITION)).toMatch(/^prismical-sync-[0-9a-f]{16}$/);
  });
});
