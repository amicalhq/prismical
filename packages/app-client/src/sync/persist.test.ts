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
import { createIndexedDbPersistPlugin, createSyncStore, type SyncStore, type TagRow } from "./store";
import { partitionDatabaseName } from "./partition";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocked.restList.mockResolvedValue([]);
  mocked.restNoteTagList.mockResolvedValue([]);
  seq += 1;
  PARTITION = { accountSub: "sub|persist", orgId: `org_persist_${seq}` };
});

afterEach(() => {
  for (const store of stores) store.dispose();
  stores = [];
});

describe("IndexedDB persistence per partition", () => {
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
