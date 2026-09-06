// @vitest-environment jsdom
/**
 * Folder hooks over the Legend-State sync store. The store is real
 * (createSyncStore) with a mocked wire layer; useSyncStore is mocked to hand
 * the hooks that store, exactly as the provider would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../../sync/api", () => ({
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
vi.mock("../../sync/provider", () => ({ useSyncStore: vi.fn() }));

import * as api from "../../sync/api";
import { useSyncStore } from "../../sync/provider";
import { createSyncStore, type SyncStore } from "../../sync/store";
import { useFolders, useCreateFolder, useUpdateFolder, useDeleteFolder } from "./folders";

const mockedApi = vi.mocked(api);
const mockedUseStore = vi.mocked(useSyncStore);

let store: SyncStore;

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.restList.mockResolvedValue([]);
  mockedApi.restNoteTagList.mockResolvedValue([]);
  mockedApi.restCreate.mockImplementation(async (_route, input) => ({
    ...(input as object),
    createdAt: "2030-01-01T00:00:00.000Z",
  }));
  mockedApi.restUpdate.mockImplementation(async (_route, _id, input) => ({ ...(input as object) }));
  store = createSyncStore({
    partition: { accountSub: "sub", orgId: "org" },
    pollIntervalMs: 0,
  });
  mockedUseStore.mockReturnValue(store);
});

afterEach(() => {
  store.dispose();
});

describe("useFolders", () => {
  it("maps pulled rows to the Folder contract (sorted by updatedAt, id)", async () => {
    mockedApi.restList.mockResolvedValueOnce([
      { id: "fld_b", name: "B", parentId: null, isFavorite: true, createdAt: "2030-01-02T00:00:00.000Z", updatedAt: "2030-01-02T00:00:00.000Z" },
      { id: "fld_a", name: "A", parentId: null, isFavorite: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" },
    ]);
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.data!.map((f) => f.id)).toEqual(["fld_a", "fld_b"]);
    expect(result.current.data![1]).toMatchObject({ name: "B", favorite: true, parentId: null });
    expect(result.current.isLoading).toBe(false);
  });

  it("is loading while signed out (no store)", () => {
    mockedUseStore.mockReturnValue(null);
    const { result } = renderHook(() => useFolders());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
  });
});

describe("folder mutations (optimistic)", () => {
  it("useCreateFolder returns the folder immediately, row visible, POST pushed", async () => {
    const { result: folders } = renderHook(() => useFolders());
    await waitFor(() => expect(folders.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useCreateFolder());
    let created: unknown;
    result.current.mutate("Projects", { onSuccess: (f) => (created = f) });
    expect(created).toMatchObject({ name: "Projects", parentId: null });
    await waitFor(() => expect(folders.current.data!.some((f) => f.name === "Projects")).toBe(true));
    await waitFor(() => expect(mockedApi.restCreate).toHaveBeenCalledTimes(1));
    const [route, sent] = mockedApi.restCreate.mock.calls[0]! as [string, Record<string, unknown>];
    expect(route).toBe("folders");
    expect(sent.createdAt).toBeUndefined(); // POST routing discriminator
  });

  it("useUpdateFolder patches only the sent fields; useDeleteFolder tombstones", async () => {
    mockedApi.restList.mockResolvedValueOnce([
      { id: "fld_x", name: "X", parentId: null, isFavorite: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" },
    ]);
    const { result: folders } = renderHook(() => useFolders());
    await waitFor(() => expect(folders.current.data?.length).toBe(1));

    const { result: update } = renderHook(() => useUpdateFolder());
    update.current.mutate({ id: "fld_x", patch: { isFavorite: true } });
    await waitFor(() => expect(folders.current.data![0]!.favorite).toBe(true));
    await waitFor(() => expect(mockedApi.restUpdate).toHaveBeenCalled());
    const body = mockedApi.restUpdate.mock.calls[0]![2] as Record<string, unknown>;
    expect(body.isFavorite).toBe(true);
    expect(body.name).toBeUndefined(); // partial update

    const { result: del } = renderHook(() => useDeleteFolder());
    del.current.mutate("fld_x");
    await waitFor(() => expect(folders.current.data!.length).toBe(0));
    await waitFor(() => expect(mockedApi.restRemove).toHaveBeenCalledWith("folders", "fld_x"));
  });
});
