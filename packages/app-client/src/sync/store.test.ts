/**
 * Sync-store invariants over a mocked wire layer. The wire itself is
 * contract-tested (./api.test.ts and the server/fake contract suites); here we pin
 * the Legend-State layer's behavior at the store boundary: delta merge,
 * tombstones, create/update routing, terminal4xx drop+revert, junction
 * gating, and the gated note create.
 */
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

import { syncState } from "@legendapp/state";
import { ApiError } from "../api/client";
import * as api from "./api";
import { createSyncStore, type SyncStore, type TagRow } from "./store";

/**
 * Activate a collection and wait for its FIRST pull to land. Writes issued
 * while the initial load is in flight are clobbered by the arriving remote
 * snapshot when no persistence (and thus no retrySync pending bookkeeping)
 * is attached — the real UI only writes after boot paint, and desktop always
 * persists, but tests must respect the same ordering. The web lane runs
 * persistence-off, so its mutation wiring must not fire before the first pull settles.
 */
async function activate(collection$: { get: () => unknown }): Promise<void> {
  collection$.get();
  await vi.waitFor(() => {
    expect(syncState(collection$ as never).isLoaded.get()).toBe(true);
  });
}

const mocked = vi.mocked(api);

const PARTITION = { accountSub: "sub|test", orgId: "org_test" };
let store: SyncStore;

beforeEach(() => {
  vi.clearAllMocks();
  mocked.restList.mockResolvedValue([]);
  mocked.restNoteTagList.mockResolvedValue([]);
  // Default write behavior: echo the input with a server-assigned createdAt
  // (the raw-row echo shape — no derived fields added).
  mocked.restCreate.mockImplementation(async (_route, input) => ({
    ...(input as object),
    createdAt: "2030-01-01T00:00:00.000Z",
  }));
  mocked.restUpdate.mockImplementation(async (_route, _id, input) => ({ ...(input as object) }));
  store = createSyncStore({ partition: PARTITION, pollIntervalMs: 0 });
});

afterEach(() => {
  store.dispose();
});

describe("delta pull → observable", () => {
  it("populates rows keyed by id from the list lane", async () => {
    mocked.restList.mockResolvedValueOnce([
      { id: "tag_a", name: "A", color: "#1", updatedAt: "2030-01-01T00:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z" },
      { id: "tag_b", name: "B", color: "#2", updatedAt: "2030-01-02T00:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z" },
    ]);
    store.tags$.get(); // activation triggers the first pull
    await vi.waitFor(() => {
      const rows = store.tags$.peek() as Record<string, TagRow>;
      expect(Object.keys(rows)).toEqual(["tag_a", "tag_b"]);
      expect(rows.tag_a!.name).toBe("A");
    });
  });

  it("a pulled tombstone removes the local row (fieldDeleted)", async () => {
    mocked.restList.mockResolvedValueOnce([
      { id: "tag_x", name: "X", color: "#1", updatedAt: "2030-01-01T00:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z" },
    ]);
    store.tags$.get();
    await vi.waitFor(() => expect((store.tags$.peek() as Record<string, TagRow>).tag_x).toBeTruthy());

    mocked.restList.mockResolvedValueOnce([
      { id: "tag_x", name: "X", color: "#1", updatedAt: "2030-01-03T00:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z", deletedAt: "2030-01-03T00:00:00.000Z" },
    ]);
    await store.refreshAll();
    await vi.waitFor(() => expect((store.tags$.peek() as Record<string, TagRow>).tag_x).toBeUndefined());
  });
});

describe("write routing", () => {
  it("advances the local naming revision before a manual rename or reset is acknowledged", async () => {
    mocked.restList.mockResolvedValueOnce([{
      id: "nt_title", title: "First line", titleSource: "first-line", titleRevision: 4,
      createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    }]);
    await activate(store.notes$);
    mocked.restUpdate.mockReturnValue(new Promise(() => {}));
    store.updateNote("nt_title", { title: "My title" });
    expect(store.notes$["nt_title"]!.titleRevision.peek()).toBe(5);
    store.updateNote("nt_title", { title: "" });
    expect(store.notes$["nt_title"]!.titleRevision.peek()).toBe(6);
    store.updateNote("nt_title", { starred: true });
    expect(store.notes$["nt_title"]!.titleRevision.peek()).toBe(6);
  });

  it("does not send a delayed write after its exact auth context is revoked", async () => {
    store.dispose();
    let contextActive = true;
    store = createSyncStore({
      partition: PARTITION,
      pollIntervalMs: 0,
      getRequestOptions: async () => {
        if (!contextActive) {
          throw new ApiError("AUTH_CONTEXT_CHANGED", "Session changed", 401);
        }
        return { authToken: "support-token", activeOrgId: "org_test" };
      },
    });
    await activate(store.tags$);
    mocked.restCreate.mockClear();

    contextActive = false;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.createTag("MustNotCrossSession");
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(mocked.restCreate).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("an optimistic create (no createdAt) routes to restCreate and backfills createdAt from the echo", async () => {
    await activate(store.tags$);
    const id = store.createTag("Fresh")!;
    await vi.waitFor(() => expect(mocked.restCreate).toHaveBeenCalledTimes(1));
    const [route, sent] = mocked.restCreate.mock.calls[0]! as [string, Record<string, unknown>];
    expect(route).toBe("tags");
    expect(sent.id).toBe(id);
    expect(sent.createdAt).toBeUndefined(); // the POST-routing discriminator
    await vi.waitFor(() => {
      // Legend converts the echo's createdAt to a Date (SyncTimestamp) — compare instants.
      const createdAt = (store.tags$.peek() as Record<string, TagRow>)[id]!.createdAt;
      expect(new Date(createdAt as string | Date).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    });
  });

  it("a later update routes to restUpdate with ONLY the changed fields (updatePartial)", async () => {
    await activate(store.tags$);
    const id = store.createTag("Partial")!;
    await vi.waitFor(() =>
      expect((store.tags$.peek() as Record<string, TagRow>)[id]!.createdAt).toBeTruthy(),
    );
    store.renameTag(id, "PartialB");
    await vi.waitFor(() => expect(mocked.restUpdate).toHaveBeenCalledTimes(1));
    const [route, sentId, body] = mocked.restUpdate.mock.calls[0]! as [string, string, Record<string, unknown>];
    expect(route).toBe("tags");
    expect(sentId).toBe(id);
    expect(body.name).toBe("PartialB");
    expect(body.color).toBeUndefined(); // unchanged fields stay off the wire
  });

  it("tag names are sanitized before the wire; empty-sanitizing names are refused", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.tags$.get();
    const id = store.createTag("My Work!")!;
    expect((store.tags$.peek() as Record<string, TagRow>)[id]!.name).toBe("MyWork");
    expect(store.createTag("!!!")).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("terminal4xx (drop + revert)", () => {
  it("a 409 on create drops the op AND reverts the optimistic row (no infinite retry)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocked.restCreate.mockRejectedValue(new ApiError("CONFLICT", "collision", 409));
    await activate(store.tags$);
    const id = store.createTag("Collide")!;
    await vi.waitFor(() => expect(mocked.restCreate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect((store.tags$.peek() as Record<string, TagRow>)[id]).toBeUndefined(),
    );
    expect(mocked.restCreate).toHaveBeenCalledTimes(1); // settled, not retried
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("rejected by server (409)"), expect.anything());
  });

  it("a 404 on delete keeps the local tombstone (already gone server-side = ack)", async () => {
    mocked.restList.mockResolvedValueOnce([
      { id: "tag_gone", name: "Gone", color: "#1", updatedAt: "2030-01-01T00:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z" },
    ]);
    mocked.restRemove.mockRejectedValue(new ApiError("NOT_FOUND", "gone", 404));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.tags$.get();
    await vi.waitFor(() => expect((store.tags$.peek() as Record<string, TagRow>).tag_gone).toBeTruthy());
    store.deleteTag("tag_gone");
    await vi.waitFor(() => expect(mocked.restRemove).toHaveBeenCalledTimes(1));
    // The row stays deleted locally — no resurrect, no retry loop.
    expect((store.tags$.peek() as Record<string, TagRow>).tag_gone).toBeUndefined();
    expect(mocked.restRemove).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe("note-tags junction gating (waitForSet)", () => {
  it("a link create waits until BOTH locally-created parents are server-acked", async () => {
    // Parents' creates resolve on demand — the link must not POST before both ack.
    const pending = new Map<string, (value: unknown) => void>();
    mocked.restCreate.mockImplementation(
      (_route, input) =>
        new Promise((resolve) => {
          const row = input as Record<string, unknown>;
          pending.set(row.id as string, (extra) =>
            resolve({ ...row, createdAt: "2030-01-01T00:00:00.000Z", ...(extra as object) }),
          );
        }),
    );
    await activate(store.notes$);
    await activate(store.tags$);
    await activate(store.noteTags$);

    const noteId = store.createNote({ title: "N" });
    const tagId = store.createTag("T")!;
    store.addNoteTag(noteId, tagId);

    await vi.waitFor(() => expect(pending.size).toBe(2));
    expect(mocked.restNoteTagCreate).not.toHaveBeenCalled();

    pending.get(noteId)!({});
    pending.get(tagId)!({});
    await vi.waitFor(() => expect(mocked.restNoteTagCreate).toHaveBeenCalledWith(noteId, tagId));
  });
});

describe("gated note create (collaboration ordering)", () => {
  it("whenNoteCreateAcked blocks until the create echo lands; unknown notes pass immediately", async () => {
    let release: ((value: unknown) => void) | null = null;
    mocked.restCreate.mockImplementation(
      (_route, input) =>
        new Promise((resolve) => {
          release = () => resolve({ ...(input as object), createdAt: "2030-01-01T00:00:00.000Z" });
        }),
    );
    await activate(store.notes$);

    await expect(store.whenNoteCreateAcked("nt_not_local")).resolves.toBeUndefined();

    const id = store.createNote({ title: "Gated" });
    let acked = false;
    const gate = store.whenNoteCreateAcked(id).then(() => {
      acked = true;
    });
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(acked).toBe(false);
    release!(undefined);
    await gate;
    expect(acked).toBe(true);
  });
});

describe("partition wiring", () => {
  it("wire calls carry no partition information — scoping is main/auth-side; the store is per-partition by construction", async () => {
    store.tags$.get();
    await vi.waitFor(() => expect(mocked.restList).toHaveBeenCalled());
    expect(store.partition).toEqual(PARTITION);
  });
});
